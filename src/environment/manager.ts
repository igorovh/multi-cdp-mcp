import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { BackendAdapter } from "../backend/adapter.ts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ManagedExtension, ManagementResult } from "../browser/control.ts";
import {
  launchBrave,
  portInUse,
  reconnectBrave,
  stopBrave,
  type BraveProcess,
} from "../browser/brave.ts";
import { CdpClient } from "../browser/cdp.ts";
import { ExtensionControl } from "../browser/control.ts";
import {
  environmentsDir,
  logsDir,
  templateDir,
  type ProxyConfig,
} from "../config.ts";
import { errorMessage, log } from "../logging.ts";
import {
  acquireProfileLock,
  cloneEnvironment,
  createFreshProfile,
  prepareTemplate,
  prepareUnpackedExtensions,
} from "../profile/manager.ts";
import { EnvironmentRegistry, type EnvironmentRecord } from "./registry.ts";

export type EnvironmentState = "stopped" | "starting" | "running" | "failed";

export interface EnvironmentView
  extends Omit<
    EnvironmentRecord,
    "ownerSessionId" | "extensionPaths" | "devExtensionPaths" | "browserPid"
  > {
  state: EnvironmentState;
  ownedByCaller: boolean;
  owner: "self" | "other" | null;
}

interface RunningParts {
  brave: BraveProcess;
  backend: BackendAdapter;
  cdp: CdpClient;
  control: ExtensionControl | null;
  releaseLock: () => Promise<void>;
}

class Environment {
  state: EnvironmentState = "stopped";
  running: RunningParts | null = null;
  /** Number of tool calls in flight; an environment is never evicted while non-zero. */
  activeCalls = 0;
  lastError: string | null = null;

  constructor(
    readonly record: EnvironmentRecord,
  ) {}

  get id(): string {
    return this.record.id;
  }
}

export class EnvironmentManager {
  #environments = new Map<string, Environment>();
  #bindings = new Map<string, string>();
  #startups = new Map<string, Promise<Environment>>();
  #creations = new Map<string, Promise<Environment>>();
  #templateReady: Promise<string> | null = null;
  #reservedPorts = new Set<number>();

  private constructor(
    private readonly config: ProxyConfig,
    private readonly registry: EnvironmentRegistry,
  ) {}

  static async create(config: ProxyConfig): Promise<EnvironmentManager> {
    const registry = await EnvironmentRegistry.open(config);
    const manager = new EnvironmentManager(config, registry);
    for (const record of registry.all()) {
      manager.#environments.set(record.id, new Environment(record));
      if (record.ownerSessionId) manager.#bindings.set(record.ownerSessionId, record.id);
    }
    log.info(`Restored ${manager.#environments.size} environment(s) from the registry`);
    return manager;
  }

  /** Template preparation is shared and must happen at most once per proxy run. */
  #ensureTemplate(): Promise<string> {
    this.#templateReady ??= prepareTemplate({
      mode: this.config.profileSource.mode,
      sourceUserDataDir: this.config.profileSource.sourceUserDataDir,
      templateDir: templateDir(this.config),
      maxTemplateSizeGb: this.config.profileSource.maxTemplateSizeGb,
      refresh: this.config.profileSource.refreshTemplate,
    });
    return this.#templateReady;
  }

  async #allocatePort(): Promise<number> {
    const { start, end } = this.config.browser.portRange;
    const taken = new Set(
      [...this.#environments.values()]
        .filter((environment) => environment.running)
        .map((environment) => environment.record.port),
    );
    for (let port = start; port <= end; port++) {
      if (taken.has(port) || this.#reservedPorts.has(port)) continue;
      this.#reservedPorts.add(port);
      if (await portInUse(port)) {
        this.#reservedPorts.delete(port);
        continue;
      }
      return port;
    }
    throw new Error(`No free debugging port in range ${start}-${end}.`);
  }

  list(sessionId: string): EnvironmentView[] {
    return [...this.#environments.values()].map((environment) => {
      const {
        ownerSessionId,
        extensionPaths: _extensionPaths,
        devExtensionPaths: _devExtensionPaths,
        browserPid: _browserPid,
        ...record
      } = environment.record;
      return {
        ...record,
        state: environment.state,
        ownedByCaller: ownerSessionId === sessionId,
        owner: ownerSessionId === sessionId ? "self" : ownerSessionId ? "other" : null,
      };
    });
  }

  /** Lazily creates and binds an environment the first time a session touches the browser. */
  async resolveForSession(sessionId: string): Promise<Environment> {
    const boundId = this.#bindings.get(sessionId);
    if (boundId) {
      const existing = this.#environments.get(boundId);
      if (existing) return await this.#ensureRunning(existing);
      this.#bindings.delete(sessionId);
    }

    const pending = this.#creations.get(sessionId);
    if (pending) return await pending;

    // Single-flight: concurrent first calls from one session must not create two browsers.
    const creation = this.#createFor(sessionId).finally(() => this.#creations.delete(sessionId));
    this.#creations.set(sessionId, creation);
    return await creation;
  }

  async #createFor(
    sessionId: string,
    requestedId?: string,
    options: { fresh?: boolean; devExtensionPaths?: string[]; headless?: boolean } = {},
  ): Promise<Environment> {
    const id = requestedId ?? `env-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) {
      throw new Error(
        "Environment IDs must be 1-64 characters: letters, digits, dot, underscore or dash.",
      );
    }
    if (this.#environments.has(id)) throw new Error(`Environment "${id}" already exists.`);

    const profileDir = join(environmentsDir(this.config), id);
    const record: EnvironmentRecord = {
      id,
      profileDir,
      port: 0,
      ownerSessionId: null,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      seeded: false,
      extensionPaths: [],
      profileMode: options.fresh ? "fresh" : "template",
      devExtensionPaths: options.devExtensionPaths ?? [],
      headless: options.headless ?? this.config.browser.headless,
    };

    const environment = new Environment(record);
    this.#environments.set(id, environment);
    await this.#bind(sessionId, environment);
    log.info(`Created environment ${id} for session ${sessionId}`);
    return await this.#ensureRunning(environment);
  }

  async createNamed(
    sessionId: string,
    name?: string,
    options: { fresh?: boolean; devExtensionPaths?: string[]; headless?: boolean } = {},
  ): Promise<Environment> {
    return await this.#createFor(sessionId, name, options);
  }

  async select(sessionId: string, id: string): Promise<Environment> {
    const environment = this.#environments.get(id);
    if (!environment) throw new Error(`Unknown environment "${id}".`);
    const owner = environment.record.ownerSessionId;
    if (owner && owner !== sessionId) {
      if (environment.activeCalls > 0 || environment.state === "starting") {
        throw new Error(
          `Environment "${id}" is busy with another conversation; try again once it is idle.`,
        );
      }
      log.warn(`Environment ${id} handed over from ${owner} to ${sessionId}`);
      this.#bindings.delete(owner);
    }
    await this.#bind(sessionId, environment);
    return await this.#ensureRunning(environment);
  }

  async #bind(sessionId: string, environment: Environment): Promise<void> {
    const previousId = this.#bindings.get(sessionId);
    if (previousId && previousId !== environment.id) {
      const previous = this.#environments.get(previousId);
      if (previous?.record.ownerSessionId === sessionId) {
        previous.record.ownerSessionId = null;
        await this.registry.upsert(previous.record);
      }
    }
    environment.record.ownerSessionId = sessionId;
    this.#bindings.set(sessionId, environment.id);
    await this.registry.upsert(environment.record);
  }

  async release(sessionId: string): Promise<string | null> {
    const id = this.#bindings.get(sessionId);
    if (!id) return null;
    this.#bindings.delete(sessionId);
    const environment = this.#environments.get(id);
    if (environment) {
      environment.record.ownerSessionId = null;
      await this.registry.upsert(environment.record);
    }
    return id;
  }

  async stop(id: string, sessionId: string): Promise<void> {
    const environment = this.#environments.get(id);
    if (!environment) throw new Error(`Unknown environment "${id}".`);
    if (environment.record.ownerSessionId && environment.record.ownerSessionId !== sessionId) {
      throw new Error(`Environment "${id}" belongs to another conversation.`);
    }
    if (environment.activeCalls > 0) {
      throw new Error(`Environment "${id}" has ${environment.activeCalls} call(s) in flight.`);
    }
    if (!environment.running && environment.record.browserPid) {
      await this.#ensureRunning(environment);
    }
    await this.#shutdown(environment);
  }

  async delete(id: string, sessionId: string, force = false): Promise<void> {
    const environment = this.#environments.get(id);
    if (!environment) throw new Error(`Unknown environment "${id}".`);
    if (environment.record.ownerSessionId && environment.record.ownerSessionId !== sessionId) {
      throw new Error(`Environment "${id}" belongs to another conversation.`);
    }
    if (environment.activeCalls > 0 || environment.state === "starting") {
      throw new Error(`Environment "${id}" is busy and cannot be deleted.`);
    }
    if (environment.running && !force) {
      throw new Error(`Environment "${id}" is running. Stop it first or pass force: true.`);
    }
    if (environment.running || environment.record.browserPid) await this.#shutdownForDelete(environment);
    await this.#deleteStopped(environment);
  }

  async deleteAll(sessionId: string, force: boolean): Promise<number> {
    const environments = [...this.#environments.values()];
    const busy = environments.find(
      (environment) => environment.activeCalls > 0 || environment.state === "starting",
    );
    if (busy) throw new Error(`Environment "${busy.id}" is busy; delete_all aborted.`);
    const running = environments.filter(
      (environment) => environment.running || environment.record.browserPid,
    );
    if (running.length > 0 && !force) {
      throw new Error(
        `${running.length} environment(s) may be running. Stop them first or pass force: true.`,
      );
    }
    for (const environment of running) await this.#shutdownForDelete(environment);
    for (const environment of environments) await this.#deleteStopped(environment);
    this.#bindings.delete(sessionId);
    return environments.length;
  }

  async #shutdownForDelete(environment: Environment): Promise<void> {
    if (!environment.running && environment.record.browserPid) await this.#ensureRunning(environment);
    await this.#shutdown(environment);
  }

  async #deleteStopped(environment: Environment): Promise<void> {
    if (environment.running || environment.state === "starting" || environment.activeCalls > 0) {
      throw new Error(`Environment "${environment.id}" is not safely stopped.`);
    }
    const root = resolve(environmentsDir(this.config));
    const profile = resolve(environment.record.profileDir);
    const rel = relative(root, profile);
    if (rel.startsWith("..") || rel === "" || resolve(root, rel) !== profile) {
      throw new Error(`Refusing to delete profile outside ${root}: ${profile}`);
    }
    for (const [caller, id] of this.#bindings) {
      if (id === environment.id) this.#bindings.delete(caller);
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    await this.registry.remove(environment.id);
    this.#environments.delete(environment.id);
    log.info(`Deleted environment ${environment.id} and its profile`);
  }

  async #shutdown(environment: Environment): Promise<void> {
    const parts = environment.running;
    environment.running = null;
    environment.state = "stopped";
    if (!parts) return;

    try {
      await parts.backend.close();
      parts.cdp.close();
      await stopBrave(parts.brave);
    } finally {
      await parts.releaseLock();
    }
    environment.record.browserPid = undefined;
    environment.record.browserVersion = undefined;
    environment.record.port = 0;
    this.#reservedPorts.delete(parts.brave.port);
    await this.registry.upsert(environment.record);
    log.info(`Stopped environment ${environment.id}`);
  }

  #ensureRunning(environment: Environment): Promise<Environment> {
    if (environment.running) {
      environment.record.lastUsedAt = new Date().toISOString();
      return Promise.resolve(environment);
    }
    const pending = this.#startups.get(environment.id);
    if (pending) return pending;

    const startup = this.#start(environment).finally(() => this.#startups.delete(environment.id));
    this.#startups.set(environment.id, startup);
    return startup;
  }

  async #start(environment: Environment): Promise<Environment> {
    environment.state = "starting";
    try {
      const active = [...this.#environments.values()].filter(
        (candidate) =>
          candidate !== environment &&
          (candidate.state === "starting" || candidate.state === "running"),
      ).length;
      if (active >= this.config.limits.maxEnvironments) {
        throw new Error(
          `Running environment limit reached (${this.config.limits.maxEnvironments}). Stop one first.`,
        );
      }

      if (!environment.record.seeded) {
        if (environment.record.profileMode === "fresh") {
          await createFreshProfile(environment.record.profileDir);
        } else {
          await cloneEnvironment(await this.#ensureTemplate(), environment.record.profileDir);
        }
        environment.record.seeded = true;
        await this.registry.upsert(environment.record);
      }

      const releaseLock = await acquireProfileLock(environment.record.profileDir);
      let brave: BraveProcess | null = null;
      let cdp: CdpClient | null = null;
      let backend: BackendAdapter | null = null;
      try {
        brave = await reconnectBrave({
          executable: this.config.braveExecutable,
          userDataDir: environment.record.profileDir,
          remoteDebuggingPort: environment.record.port,
        });

        if (!brave && this.config.extensions.materializeProfileExtensions) {
          const unpacked = await prepareUnpackedExtensions(environment.record.profileDir);
          environment.record.extensionPaths = unpacked.map((extension) => extension.path);
        }

        const port = brave?.port ?? (await this.#allocatePort());
        if (brave) {
          if (this.#reservedPorts.has(port)) {
            throw new Error(`Recovered port ${port} is already reserved by another environment.`);
          }
          this.#reservedPorts.add(port);
        }
        environment.record.port = port;

        brave ??= await launchBrave({
          executable: this.config.braveExecutable,
          userDataDir: environment.record.profileDir,
          remoteDebuggingPort: port,
          logDir: logsDir(this.config),
          headless: environment.record.headless,
          extraArgs: this.config.browser.extraArgs,
          timeoutMs: this.config.limits.startupTimeoutMs,
          extensionPaths: [
            this.config.extensions.controlExtensionPath,
            ...this.config.extensions.devExtensionPaths,
            ...environment.record.devExtensionPaths,
            ...environment.record.extensionPaths,
          ],
        });

        cdp = await CdpClient.connect(brave.webSocketDebuggerUrl);
        backend = await BackendAdapter.start(this.config, {
          environmentId: environment.id,
          browserUrl: `http://127.0.0.1:${port}`,
          logDir: logsDir(this.config),
          filesystemRoot: join(this.config.dataRoot, "artifacts", environment.id),
        });

        // Optional: without it, enable/disable is unavailable but everything else works.
        let control: ExtensionControl | null = null;
        try {
          control = await ExtensionControl.attach(cdp, { waitMs: 10_000 });
        } catch (error) {
          log.warn(`No extension control for ${environment.id}: ${errorMessage(error)}`);
        }

        environment.running = { brave, backend, cdp, control, releaseLock };
        environment.state = "running";
        environment.lastError = null;
        environment.record.lastUsedAt = new Date().toISOString();
        environment.record.browserPid = brave.pid;
        environment.record.browserVersion = brave.browserVersion;
        await this.registry.upsert(environment.record);
        log.ok(`Environment ${environment.id} running on port ${port}`);
        return environment;
      } catch (error) {
        if (environment.record.port > 0) this.#reservedPorts.delete(environment.record.port);
        await backend?.close().catch(() => {});
        cdp?.close();
        if (brave) await stopBrave(brave).catch(() => {});
        await releaseLock();
        throw error;
      }
    } catch (error) {
      environment.state = "failed";
      environment.lastError = errorMessage(error);
      throw error;
    }
  }

  async withEnvironment<T>(
    sessionId: string,
    fn: (environment: Environment) => Promise<T>,
  ): Promise<T> {
    const environment = await this.resolveForSession(sessionId);
    environment.activeCalls += 1;
    try {
      return await fn(environment);
    } finally {
      environment.activeCalls -= 1;
    }
  }

  async callBackend(
    sessionId: string,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    return await this.withEnvironment(sessionId, async (environment) => {
      if (!environment.running) throw new Error(`Environment ${environment.id} is not running.`);
      return await environment.running.backend.call(name, args, signal);
    });
  }

  async listExtensions(sessionId: string): Promise<ManagedExtension[]> {
    return await this.withEnvironment(sessionId, async (environment) => {
      const control = environment.running?.control;
      if (!control) throw new Error(`Extension control is unavailable in ${environment.id}.`);
      return await control.list();
    });
  }

  async setExtensionEnabled(
    sessionId: string,
    extensionId: string,
    enabled: boolean,
  ): Promise<ManagementResult> {
    return await this.withEnvironment(sessionId, async (environment) => {
      const control = environment.running?.control;
      if (!control) throw new Error(`Extension control is unavailable in ${environment.id}.`);
      if (extensionId === control.extensionId) {
        throw new Error("The control extension cannot disable itself.");
      }
      return await control.setEnabled(extensionId, enabled);
    });
  }

  async reloadExtension(sessionId: string, extensionId: string): Promise<ManagementResult> {
    return await this.withEnvironment(sessionId, async (environment) => {
      const control = environment.running?.control;
      if (!control) throw new Error(`Extension control is unavailable in ${environment.id}.`);
      if (extensionId === control.extensionId) {
        throw new Error("The control extension cannot reload itself.");
      }
      return await control.reload(extensionId);
    });
  }

  get(id: string): Environment | undefined {
    return this.#environments.get(id);
  }

  boundEnvironmentId(sessionId: string): string | undefined {
    return this.#bindings.get(sessionId);
  }

  async shutdownAll(): Promise<void> {
    await mkdir(this.config.dataRoot, { recursive: true });
    for (const environment of this.#environments.values()) {
      await this.#shutdown(environment).catch((error: unknown) => {
        log.warn(`Shutting down ${environment.id}: ${errorMessage(error)}`);
      });
    }
  }
}

export type { Environment };
