import { mkdir, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { BackendAdapter } from "../backend/adapter.ts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ManagedExtension, ManagementResult } from "../browser/control.ts";
import { CdpClient } from "../browser/cdp.ts";
import { ExtensionControl, repairUnpackedExtensions } from "../browser/control.ts";
import { resolveBrowser, type DetectedBrowser } from "../browser/detect.ts";
import {
  launchBrowser,
  portInUse,
  reconnectBrowser,
  stopBrowser,
  type BrowserProcess,
} from "../browser/launcher.ts";
import { PageInput } from "../browser/input.ts";
import {
  environmentsDir,
  logsDir,
  templateDir,
  type ProxyConfig,
} from "../config.ts";
import { errorMessage, log } from "../logging.ts";
import {
  dedupePaths,
  enableDeveloperMode,
  extensionIdFromPath,
  manifestName,
  prepareUnpackedExtensions,
  unpackedSourceExtensions,
  validateExtensionDirectory,
} from "../profile/extensions.ts";
import {
  acquireProfileLock,
  cloneEnvironment,
  createFreshProfile,
  prepareTemplate,
} from "../profile/manager.ts";
import { EnvironmentRegistry, type EnvironmentRecord } from "./registry.ts";

export type EnvironmentState = "stopped" | "starting" | "running" | "failed";

export type ExtensionControlState = "available" | "unavailable" | "not-running";

export interface EnvironmentView
  extends Omit<
    EnvironmentRecord,
    | "ownerSessionId"
    | "extensionPaths"
    | "devExtensionPaths"
    | "browserPid"
    | "templateUnpackedPaths"
    | "disabledExtensionIds"
  > {
  state: EnvironmentState;
  ownedByCaller: boolean;
  owner: "self" | "other" | null;
  ownerId: string | null;
  devExtensionPaths: string[];
  extensionControl: ExtensionControlState;
  extensionControlError?: string;
  lastError?: string;
}

/** Either the caller's bound environment or one addressed explicitly by ID. */
export type Route = { sessionId: string; environmentId?: undefined } | { environmentId: string };

export interface ListedExtension extends ManagedExtension {
  source: "control" | "dev" | "profile" | "template-unpacked" | "other";
  controllable: boolean;
  lockedReason?: string;
}

interface RunningParts {
  browser: BrowserProcess;
  backend: BackendAdapter;
  cdp: CdpClient;
  control: ExtensionControl | null;
  input: PageInput;
  releaseLock: () => Promise<void>;
}

function withHint(result: ManagementResult): ManagementResult {
  if (result.ok || !result.error) return result;
  if (result.error.includes("cannot be modified by user")) {
    return {
      ...result,
      hint:
        "Chromium locks this extension, usually because its install record was cloned from " +
        "the template. cdp_extension_list shows lockedReason. Load its directory through " +
        "devExtensionPaths in a new environment to control it.",
    };
  }
  if (result.error.includes("Failed to find extension")) {
    return {
      ...result,
      hint: "The extension is not loaded in this environment; check cdp_extension_list for IDs.",
    };
  }
  return result;
}

class Environment {
  state: EnvironmentState = "stopped";
  running: RunningParts | null = null;
  /** Number of tool calls in flight; an environment is never evicted while non-zero. */
  activeCalls = 0;
  lastError: string | null = null;
  controlError: string | null = null;

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
  #browser: DetectedBrowser | null = null;
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

  /** Resolved on first launch, so the proxy starts and lists tools even without a browser. */
  #detectBrowser(): DetectedBrowser {
    if (!this.#browser) {
      this.#browser = resolveBrowser(this.config.browser.executable);
      log.info(`Using ${this.#browser.kind} browser at ${this.#browser.executable}`);
    }
    return this.#browser;
  }

  #sourceUserDataDir(): string {
    const configured = this.config.profileSource.sourceUserDataDir;
    if (configured !== "auto") return configured;
    const detected = this.#detectBrowser().userDataDir;
    if (!detected) {
      throw new Error(
        "Cannot infer the profile to clone for this browser; set profileSource.sourceUserDataDir.",
      );
    }
    return detected;
  }

  /** Template preparation is shared and must happen at most once per proxy run. */
  #ensureTemplate(): Promise<string> {
    if (this.#templateReady) return this.#templateReady;
    const ready = Promise.resolve().then(() =>
      prepareTemplate({
        mode: this.config.profileSource.mode,
        sourceUserDataDir:
          this.config.profileSource.mode === "clone" ? this.#sourceUserDataDir() : "",
        templateDir: templateDir(this.config),
        maxTemplateSizeGb: this.config.profileSource.maxTemplateSizeGb,
        refresh: this.config.profileSource.refreshTemplate,
      }),
    );
    // A failed preparation (for example a missing source profile) may be retried.
    ready.catch(() => {
      if (this.#templateReady === ready) this.#templateReady = null;
    });
    this.#templateReady = ready;
    return ready;
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

  list(sessionId: string | null): EnvironmentView[] {
    return [...this.#environments.values()].map((environment) => this.view(environment, sessionId));
  }

  view(environment: Environment, sessionId: string | null): EnvironmentView {
    const {
      ownerSessionId,
      extensionPaths: _extensionPaths,
      templateUnpackedPaths: _templateUnpackedPaths,
      disabledExtensionIds: _disabledExtensionIds,
      browserPid: _browserPid,
      ...record
    } = environment.record;
    const self = sessionId !== null && ownerSessionId === sessionId;
    return {
      ...record,
      state: environment.state,
      ownedByCaller: self,
      owner: self ? "self" : ownerSessionId ? "other" : null,
      ownerId: ownerSessionId,
      extensionControl: !environment.running
        ? "not-running"
        : environment.running.control
          ? "available"
          : "unavailable",
      ...(environment.controlError ? { extensionControlError: environment.controlError } : {}),
      ...(environment.lastError ? { lastError: environment.lastError } : {}),
    };
  }

  #ownershipError(id: string, owner: string, sessionId: string, action: "stop" | "delete"): Error {
    const recovery =
      action === "stop"
        ? `pass environmentId: "${id}" explicitly`
        : `take it over first with cdp_environment_select({ environmentId: "${id}" })`;
    return new Error(
      `Environment "${id}" belongs to caller "${owner}", not "${sessionId}". To ${action} it, ` +
        `call again with callerId: "${owner}", or ${recovery}.`,
    );
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
    for (const path of options.devExtensionPaths ?? []) await validateExtensionDirectory(path);

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

  /** Stop keeps the profile, so an explicitly named environment may be stopped by any caller. */
  async stop(id: string, sessionId: string, options: { explicit?: boolean } = {}): Promise<void> {
    const environment = this.#environments.get(id);
    if (!environment) throw new Error(`Unknown environment "${id}".`);
    const owner = environment.record.ownerSessionId;
    if (owner && owner !== sessionId) {
      if (!options.explicit) throw this.#ownershipError(id, owner, sessionId, "stop");
      log.warn(`Environment ${id} owned by ${owner} stopped explicitly by ${sessionId}`);
    }
    if (environment.activeCalls > 0 || environment.state === "starting") {
      throw new Error(`Environment "${id}" is busy; try again once it is idle.`);
    }
    if (environment.running) await this.#shutdown(environment);
    else await this.#stopOrphan(environment);
  }

  /** Stops a browser left running by a crashed proxy without launching a new one. */
  async #stopOrphan(environment: Environment): Promise<void> {
    const record = environment.record;
    if (!record.browserPid && record.port <= 0) return;
    const releaseLock = await acquireProfileLock(record.profileDir);
    try {
      const browser = await reconnectBrowser({
        userDataDir: record.profileDir,
        remoteDebuggingPort: record.port,
      });
      if (browser) await stopBrowser(browser);
    } finally {
      await releaseLock();
    }
    record.browserPid = undefined;
    record.browserVersion = undefined;
    record.port = 0;
    await this.registry.upsert(record);
  }

  async delete(id: string, sessionId: string, force = false): Promise<void> {
    const environment = this.#environments.get(id);
    if (!environment) throw new Error(`Unknown environment "${id}".`);
    const owner = environment.record.ownerSessionId;
    if (owner && owner !== sessionId) throw this.#ownershipError(id, owner, sessionId, "delete");
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
    if (environment.running) await this.#shutdown(environment);
    else await this.#stopOrphan(environment);
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
      await stopBrowser(parts.browser);
    } finally {
      await parts.releaseLock();
      environment.record.browserPid = undefined;
      environment.record.browserVersion = undefined;
      environment.record.port = 0;
      this.#reservedPorts.delete(parts.browser.port);
      await this.registry.upsert(environment.record);
    }
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
          environment.record.templateUnpackedPaths = (
            await unpackedSourceExtensions(environment.record.profileDir)
          ).map((extension) => extension.path);
        }
        environment.record.seeded = true;
        await this.registry.upsert(environment.record);
      }

      const detected = this.#detectBrowser();
      const releaseLock = await acquireProfileLock(environment.record.profileDir);
      let browser: BrowserProcess | null = null;
      let cdp: CdpClient | null = null;
      let backend: BackendAdapter | null = null;
      try {
        browser = await reconnectBrowser({
          userDataDir: environment.record.profileDir,
          remoteDebuggingPort: environment.record.port,
        });

        const extensionPaths = browser ? [] : await this.#extensionPaths(environment, detected);
        if (extensionPaths.length > 0) await enableDeveloperMode(environment.record.profileDir);

        const port = browser?.port ?? (await this.#allocatePort());
        if (browser) {
          if (this.#reservedPorts.has(port)) {
            throw new Error(`Recovered port ${port} is already reserved by another environment.`);
          }
          this.#reservedPorts.add(port);
        }
        environment.record.port = port;

        browser ??= await launchBrowser({
          executable: detected.executable,
          userDataDir: environment.record.profileDir,
          remoteDebuggingPort: port,
          logDir: logsDir(this.config),
          headless: environment.record.headless,
          extraArgs: this.config.browser.extraArgs,
          disableSync: !this.config.browser.allowSync,
          kind: detected.kind,
          timeoutMs: this.config.limits.startupTimeoutMs,
          extensionPaths,
        });

        cdp = await CdpClient.connect(browser.webSocketDebuggerUrl);
        backend = await BackendAdapter.start(this.config, {
          environmentId: environment.id,
          browserUrl: `http://127.0.0.1:${port}`,
          logDir: logsDir(this.config),
          filesystemRoots: [
            join(this.config.dataRoot, "artifacts", environment.id),
            ...this.config.backend.filesystemRoots,
            ...this.config.extensions.devExtensionPaths,
            ...environment.record.devExtensionPaths,
          ],
        });

        // Optional: without it, enable/disable is unavailable but everything else works.
        let control = await this.#attachControl(environment, cdp, 10_000);
        const repairable = extensionPaths.length > 0 && detected.kind !== "chrome";
        if (repairable && (await this.#needsRepair(environment, control))) {
          control = await this.#repair(environment, detected, cdp, control);
        }

        environment.running = { browser, backend, cdp, control, input: new PageInput(cdp), releaseLock };
        environment.state = "running";
        environment.lastError = null;
        environment.record.lastUsedAt = new Date().toISOString();
        environment.record.browserPid = browser.pid;
        environment.record.browserVersion = browser.browserVersion;
        await this.registry.upsert(environment.record);
        log.ok(`Environment ${environment.id} running on port ${port}`);
        return environment;
      } catch (error) {
        if (environment.record.port > 0) this.#reservedPorts.delete(environment.record.port);
        await backend?.close().catch(() => {});
        cdp?.close();
        if (browser) await stopBrowser(browser).catch(() => {});
        await releaseLock();
        throw error;
      }
    } catch (error) {
      environment.state = "failed";
      environment.lastError = errorMessage(error);
      throw error;
    }
  }

  /**
   * Template "load unpacked" builds are reloaded via --load-extension so they stay
   * controllable; a dev build with the same manifest name replaces them.
   */
  async #extensionPaths(environment: Environment, detected: DetectedBrowser): Promise<string[]> {
    const record = environment.record;
    const devPaths: string[] = [];
    for (const path of [...this.config.extensions.devExtensionPaths, ...record.devExtensionPaths]) {
      try {
        await validateExtensionDirectory(path);
        devPaths.push(path);
      } catch (error) {
        log.warn(`Skipping dev extension in ${record.id}: ${errorMessage(error)}`);
      }
    }

    if (this.config.extensions.materializeProfileExtensions) {
      const unpacked = await prepareUnpackedExtensions(record.profileDir);
      record.extensionPaths = unpacked.map((extension) => extension.path);
      if (record.profileMode === "template" && record.templateUnpackedPaths === undefined) {
        // Environments seeded before this field existed: the template still has the records.
        const template = templateDir(this.config);
        record.templateUnpackedPaths = (await unpackedSourceExtensions(template)).map((e) => e.path);
      }
    }

    const devNames = new Set(
      (await Promise.all(devPaths.map((path) => manifestName(path)))).filter(
        (name): name is string => name !== null,
      ),
    );
    const templateUnpacked: string[] = [];
    for (const path of record.templateUnpackedPaths ?? []) {
      const name = await manifestName(path);
      if (name === null) continue;
      if (devNames.has(name)) {
        log.info(`Skipping template build of "${name}" in ${record.id}; a dev build replaces it`);
        continue;
      }
      templateUnpacked.push(path);
    }

    try {
      await stat(join(this.config.extensions.controlExtensionPath, "manifest.json"));
      environment.controlError = null;
    } catch {
      environment.controlError =
        `control extension missing at ${this.config.extensions.controlExtensionPath} ` +
        "(check extensions.controlExtensionPath in config.json)";
    }
    if (detected.kind === "chrome") {
      environment.controlError =
        "Google Chrome 137+ ignores --load-extension, so extension control and dev builds are " +
        "unavailable; set browser.executable to Chromium, Brave or Edge";
      log.warn(`${record.id}: ${environment.controlError}`);
    }

    await this.registry.upsert(record);
    return dedupePaths([
      this.config.extensions.controlExtensionPath,
      ...devPaths,
      ...record.extensionPaths,
      ...templateUnpacked,
    ]);
  }

  /** IDs loaded from the command line that should be enabled after startup. */
  #expectedEnabledIds(environment: Environment): Set<string> {
    const record = environment.record;
    const ids = new Set(
      [
        this.config.extensions.controlExtensionPath,
        ...this.config.extensions.devExtensionPaths,
        ...record.devExtensionPaths,
        ...(record.templateUnpackedPaths ?? []),
      ].map((path) => extensionIdFromPath(path)),
    );
    for (const path of record.extensionPaths) {
      const id = path.split(/[\\/]/).at(-2);
      if (id) ids.add(id);
    }
    for (const id of record.disabledExtensionIds ?? []) ids.delete(id);
    return ids;
  }

  async #needsRepair(environment: Environment, control: ExtensionControl | null): Promise<boolean> {
    if (!control) return true;
    try {
      const expected = this.#expectedEnabledIds(environment);
      return (await control.list()).some((extension) => expected.has(extension.id) && !extension.enabled);
    } catch {
      return false;
    }
  }

  /** Edge can come up with developer mode off and every unpacked extension disabled. */
  async #repair(
    environment: Environment,
    detected: DetectedBrowser,
    cdp: CdpClient,
    control: ExtensionControl | null,
  ): Promise<ExtensionControl | null> {
    try {
      const scheme = detected.kind === "edge" ? "edge" : "chrome";
      const ids = [...this.#expectedEnabledIds(environment)];
      const enabled = await repairUnpackedExtensions(cdp, scheme, ids);
      log.info(`Re-enabled ${enabled} unpacked extension(s) in ${environment.id}`);
    } catch (error) {
      log.warn(`Could not repair extensions in ${environment.id}: ${errorMessage(error)}`);
      return control;
    }
    return control ?? (await this.#attachControl(environment, cdp, 5_000));
  }

  async #attachControl(
    environment: Environment,
    cdp: CdpClient,
    waitMs: number,
  ): Promise<ExtensionControl | null> {
    try {
      const control = await ExtensionControl.attach(cdp, {
        waitMs,
        expectedId: extensionIdFromPath(this.config.extensions.controlExtensionPath),
      });
      environment.controlError = null;
      return control;
    } catch (error) {
      environment.controlError ??= errorMessage(error);
      log.warn(`No extension control for ${environment.id}: ${environment.controlError}`);
      return null;
    }
  }

  /** Re-attaches lazily, because a dormant or restarted worker makes the first attach fail. */
  async #control(environment: Environment): Promise<ExtensionControl> {
    const running = environment.running;
    if (!running) throw new Error(`Environment ${environment.id} is not running.`);
    if (running.control && (await running.control.alive())) return running.control;
    running.control = await this.#attachControl(environment, running.cdp, 3_000);
    if (running.control) return running.control;
    if (this.#browser?.kind === "chrome") {
      throw new Error(`Extension control is unavailable in ${environment.id}: ${environment.controlError}.`);
    }
    throw new Error(
      `Extension control is unavailable in ${environment.id}: ${environment.controlError}. ` +
        "Enable/disable/reload need the bundled control extension, which the proxy loads " +
        "with --load-extension when it launches the browser. Recover with cdp_environment_stop " +
        "and retry (the next call relaunches the browser), or create a new environment. " +
        "Downstream tools such as install_extension and list_extensions do not need it.",
    );
  }

  async #resolve(route: Route): Promise<Environment> {
    if (route.environmentId === undefined) return await this.resolveForSession(route.sessionId);
    const environment = this.#environments.get(route.environmentId);
    if (!environment) throw new Error(`Unknown environment "${route.environmentId}".`);
    return await this.#ensureRunning(environment);
  }

  async withEnvironment<T>(
    route: Route,
    fn: (environment: Environment, running: RunningParts) => Promise<T>,
  ): Promise<T> {
    const environment = await this.#resolve(route);
    environment.activeCalls += 1;
    try {
      if (!environment.running) throw new Error(`Environment ${environment.id} is not running.`);
      return await fn(environment, environment.running);
    } finally {
      environment.activeCalls -= 1;
    }
  }

  async callBackend(
    route: Route,
    name: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<CallToolResult> {
    return await this.withEnvironment(route, async (_environment, running) => {
      return await running.backend.call(name, args, options);
    });
  }

  async listExtensions(route: Route): Promise<ListedExtension[]> {
    return await this.withEnvironment(route, async (environment) => {
      const control = await this.#control(environment);
      const record = environment.record;
      const ids = (paths: string[]) => new Set(paths.map((path) => extensionIdFromPath(path)));
      const dev = ids([...this.config.extensions.devExtensionPaths, ...record.devExtensionPaths]);
      const templateUnpacked = ids(record.templateUnpackedPaths ?? []);
      const profile = new Set(
        record.extensionPaths
          .map((path) => path.split(/[\\/]/).at(-2))
          .filter((id): id is string => Boolean(id)),
      );
      return (await control.list()).map((extension) => {
        const source: ListedExtension["source"] =
          extension.id === control.extensionId
            ? "control"
            : dev.has(extension.id)
              ? "dev"
              : profile.has(extension.id)
                ? "profile"
                : templateUnpacked.has(extension.id)
                  ? "template-unpacked"
                  : "other";
        const locked = extension.enabled ? !extension.mayDisable : extension.mayEnable === false;
        return {
          ...extension,
          source,
          controllable: source !== "control" && !locked,
          ...(locked
            ? {
                lockedReason:
                  `Chromium will not let it be ${extension.enabled ? "disabled" : "enabled"}` +
                  (extension.disabledReason ? ` (disabledReason: ${extension.disabledReason})` : "") +
                  ". Usually a cloned install record; pass its directory in devExtensionPaths " +
                  "of a new environment.",
              }
            : {}),
        };
      });
    });
  }

  async setExtensionEnabled(
    route: Route,
    extensionId: string,
    enabled: boolean,
  ): Promise<ManagementResult> {
    return await this.withEnvironment(route, async (environment) => {
      const control = await this.#control(environment);
      if (extensionId === control.extensionId) {
        throw new Error("The control extension cannot disable itself.");
      }
      const result = withHint(await control.setEnabled(extensionId, enabled));
      if (result.ok) {
        const disabled = new Set(environment.record.disabledExtensionIds ?? []);
        if (enabled) disabled.delete(extensionId);
        else disabled.add(extensionId);
        environment.record.disabledExtensionIds = [...disabled];
        await this.registry.upsert(environment.record);
      }
      return result;
    });
  }

  async reloadExtension(route: Route, extensionId: string): Promise<ManagementResult> {
    return await this.withEnvironment(route, async (environment) => {
      const control = await this.#control(environment);
      if (extensionId === control.extensionId) {
        throw new Error("The control extension cannot reload itself.");
      }
      return withHint(await control.reload(extensionId));
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
