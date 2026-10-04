import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { BackendAdapter } from "../backend/adapter.ts";
import type { ProxyConfig } from "../config.ts";
import { EnvironmentManager, type Route } from "../environment/manager.ts";
import { errorMessage, log } from "../logging.ts";
import { type CallerIdentity, missingIdentityMessage, resolveIdentity } from "./identity.ts";
import { PageTools } from "./page-tools.ts";
import { exposeDownstreamTools, MANAGEMENT_TOOL_NAMES, managementTools } from "./tools.ts";

type Args = Record<string, unknown>;

export const SERVER_INSTRUCTIONS = `Persistent, isolated Brave environments plus chrome-devtools tools.
Identity: calls route by _meta.sessionID. If a call fails with "No caller identity", pass callerId: "<your session ID>" on every call (same value each time), or environmentId to address an environment directly.
Environment: cdp_environment_create({name, headless?, fresh?, devExtensionPaths?}), cdp_environment_list(), cdp_environment_select({environmentId}), cdp_environment_stop({environmentId?}), cdp_environment_release().
Extensions: cdp_extension_list() (check controllable), cdp_extension_set_enabled({extensionId, enabled}), cdp_extension_reload({extensionId}), install_extension({path}).
Pages: list_pages(), select_page({pageId, bringToFront?}), new_page({url}), navigate_page({pageId, url, timeout?}), take_snapshot({pageId}), take_screenshot({pageId}).
Input: click/hover({pageId, uid | selector | x+y, bringToFront?}), fill_form({pageId, elements}), press_key({pageId, key}).
Script: evaluate_script({pageId, function, timeout?, bringToFront?}); keep in-page waits short.
Debug: list_console_messages({pageId}), list_network_requests({pageId}).
Hidden tabs throttle timers and requestAnimationFrame: pass bringToFront: true for timing-sensitive work.`;

function text(value: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function stringArg(args: Args, name: string, required = true): string | undefined {
  const value = args[name];
  if (typeof value === "string" && value.length > 0) return value;
  if (required) throw new Error(`"${name}" must be a non-empty string.`);
  return undefined;
}

function booleanArg(args: Args, name: string): boolean {
  const value = args[name];
  if (typeof value !== "boolean") throw new Error(`"${name}" must be a boolean.`);
  return value;
}

function stringArrayArg(args: Args, name: string): string[] {
  const value = args[name];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry)) {
    throw new Error(`"${name}" must be an array of non-empty strings.`);
  }
  return value as string[];
}

function withAccessHint(result: CallToolResult, name: string): CallToolResult {
  if (!result.isError) return result;
  const message = result.content.find((item) => item.type === "text");
  if (!message || message.type !== "text" || !message.text.includes("Access denied")) return result;
  return {
    ...result,
    content: [
      ...result.content,
      {
        type: "text",
        text:
          `${name} may only read paths under the environment's devExtensionPaths, the OS temp ` +
          "directory, or backend.filesystemRoots in the proxy config.json. Alternatively create " +
          "an environment with devExtensionPaths: [<that directory>].",
      },
    ],
  };
}

export class ProxyServer {
  readonly server: Server;
  readonly transport = new StdioServerTransport();
  readonly #pageTools: PageTools;
  #closed = false;

  private constructor(
    private readonly manager: EnvironmentManager,
    private readonly tools: Tool[],
    config: ProxyConfig,
  ) {
    this.#pageTools = new PageTools(manager, config);
    this.server = new Server(
      { name: "multi-cdp-mcp", version: "0.1.0" },
      { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
    );
    this.#registerHandlers();
    this.server.onclose = () => {
      if (!this.#closed) void this.manager.shutdownAll();
    };
  }

  static async create(config: ProxyConfig): Promise<ProxyServer> {
    const [manager, downstream] = await Promise.all([
      EnvironmentManager.create(config),
      BackendAdapter.discoverTools(config),
    ]);
    const tools = [
      ...managementTools,
      ...exposeDownstreamTools(downstream, { compact: config.backend.compactToolSchemas }),
    ];
    return new ProxyServer(manager, tools, config);
  }

  #registerHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.tools }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const args = { ...(request.params.arguments ?? {}) } as Args;
      const name = request.params.name;
      const meta = request.params._meta as Record<string, unknown> | undefined;
      const explicitEnvironment = stringArg(args, "environmentId", false);
      const identity = resolveIdentity({
        meta,
        args,
        transportSessionId: extra.sessionId,
        allowNameIdentity: name === "cdp_environment_create",
      });
      delete args.callerId;

      try {
        if (name === "cdp_environment_list") return text(this.manager.list(identity?.id ?? null));
        if (!identity) return text(missingIdentityMessage(meta), true);
        log.debug(`${name} from ${identity.id} (${identity.source})`);

        if (MANAGEMENT_TOOL_NAMES.has(name)) {
          return await this.#callManagement(name, args, identity, explicitEnvironment);
        }

        delete args.environmentId;
        const route = await this.#route(identity, explicitEnvironment);
        if (this.#pageTools.handles(name)) {
          return await this.#pageTools.call(route, name, args, extra.signal);
        }
        const result = await this.manager.callBackend(route, name, args, { signal: extra.signal });
        return withAccessHint(result, name);
      } catch (error) {
        log.warn(`${name} failed for ${identity?.id ?? "unknown caller"}: ${errorMessage(error)}`);
        return text(errorMessage(error), true);
      }
    });
  }

  /** Explicit environments are bound for real identities and addressed directly otherwise. */
  async #route(identity: CallerIdentity, explicitEnvironment?: string): Promise<Route> {
    if (!explicitEnvironment) return { sessionId: identity.id };
    if (identity.source === "environment") return { environmentId: explicitEnvironment };
    await this.manager.select(identity.id, explicitEnvironment);
    return { sessionId: identity.id };
  }

  async #callManagement(
    name: string,
    args: Args,
    identity: CallerIdentity,
    explicitEnvironment?: string,
  ): Promise<CallToolResult> {
    const sessionId = identity.id;
    switch (name) {
      case "cdp_environment_create": {
        const fresh = args.fresh === undefined ? false : booleanArg(args, "fresh");
        const headless = args.headless === undefined ? undefined : booleanArg(args, "headless");
        const environment = await this.manager.createNamed(
          sessionId,
          stringArg(args, "name", false),
          { fresh, headless, devExtensionPaths: stringArrayArg(args, "devExtensionPaths") },
        );
        const view = this.manager.view(environment, sessionId);
        return text({
          id: environment.id,
          state: environment.state,
          port: environment.record.port,
          extensionControl: view.extensionControl,
          ...(view.extensionControlError ? { extensionControlError: view.extensionControlError } : {}),
          ...(identity.source === "name"
            ? { note: `No callerId was given; pass environmentId: "${environment.id}" on later calls.` }
            : {}),
        });
      }
      case "cdp_environment_select": {
        const environment = await this.manager.select(sessionId, stringArg(args, "environmentId")!);
        return text({ id: environment.id, state: environment.state, port: environment.record.port });
      }
      case "cdp_environment_stop": {
        const id = explicitEnvironment ?? this.manager.boundEnvironmentId(sessionId);
        if (!id) {
          throw new Error(
            "No environment is bound to this caller; pass environmentId (see cdp_environment_list).",
          );
        }
        await this.manager.stop(id, sessionId, { explicit: explicitEnvironment !== undefined });
        return text({ id, state: "stopped", profilePreserved: true });
      }
      case "cdp_environment_release": {
        const id = await this.manager.release(sessionId);
        return text(id ? { released: id } : { released: null, message: "No binding existed." });
      }
      case "cdp_environment_delete": {
        const id = stringArg(args, "environmentId")!;
        const force = args.force === undefined ? false : booleanArg(args, "force");
        await this.manager.delete(id, sessionId, force);
        return text({ deleted: id, profileDeleted: true });
      }
      case "cdp_environment_delete_all": {
        if (stringArg(args, "confirm") !== "DELETE ALL ENVIRONMENTS") {
          throw new Error('confirm must be exactly "DELETE ALL ENVIRONMENTS".');
        }
        const force = args.force === undefined ? false : booleanArg(args, "force");
        const deleted = await this.manager.deleteAll(sessionId, force);
        return text({ deleted, profilesDeleted: true });
      }
      case "cdp_extension_list":
        return text(await this.manager.listExtensions(await this.#route(identity, explicitEnvironment)));
      case "cdp_extension_set_enabled": {
        const result = await this.manager.setExtensionEnabled(
          await this.#route(identity, explicitEnvironment),
          stringArg(args, "extensionId")!,
          booleanArg(args, "enabled"),
        );
        return text(result, !result.ok);
      }
      case "cdp_extension_reload": {
        const result = await this.manager.reloadExtension(
          await this.#route(identity, explicitEnvironment),
          stringArg(args, "extensionId")!,
        );
        return text(result, !result.ok);
      }
      default:
        throw new Error(`Unknown management tool "${name}".`);
    }
  }

  async start(): Promise<void> {
    await this.server.connect(this.transport);
    log.ok(`multi-cdp-mcp ready: ${this.tools.length} tools`);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.manager.shutdownAll();
    await this.server.close().catch(() => {});
    await this.transport.close().catch(() => {});
  }
}
