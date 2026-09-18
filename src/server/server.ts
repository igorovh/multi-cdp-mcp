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
import { EnvironmentManager } from "../environment/manager.ts";
import { errorMessage, log } from "../logging.ts";
import { exposeDownstreamTools, MANAGEMENT_TOOL_NAMES, managementTools } from "./tools.ts";

type Args = Record<string, unknown>;

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

function requestSessionId(
  request: { params?: { _meta?: Record<string, unknown> } },
  transportSessionId?: string,
): string | undefined {
  const openCodeSession = request.params?._meta?.sessionID;
  if (typeof openCodeSession === "string" && openCodeSession.length > 0) return openCodeSession;
  return transportSessionId;
}

export class ProxyServer {
  readonly server: Server;
  readonly transport = new StdioServerTransport();
  #closed = false;

  private constructor(
    private readonly manager: EnvironmentManager,
    private readonly tools: Tool[],
  ) {
    this.server = new Server(
      { name: "multi-cdp-mcp", version: "0.1.0" },
      {
        capabilities: { tools: {} },
        instructions:
          "Browser calls are automatically routed by OpenCode session. Use cdp_environment_* " +
          "for lifecycle and cdp_extension_* for extension state.",
      },
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
    const tools = [...managementTools, ...exposeDownstreamTools(downstream)];
    return new ProxyServer(manager, tools);
  }

  #registerHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.tools }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const args = { ...(request.params.arguments ?? {}) } as Args;
      const name = request.params.name;
      const explicitEnvironment = stringArg(args, "environmentId", false);
      const explicitCaller = stringArg(args, "callerId", false);

      let sessionId = requestSessionId(request, extra.sessionId) ?? explicitCaller;
      if (!sessionId && explicitEnvironment) sessionId = `explicit:${explicitEnvironment}`;
      if (!sessionId) {
        return text(
          "No conversation identity was provided. OpenCode must send _meta.sessionID; " +
            "other clients must pass environmentId.",
          true,
        );
      }

      try {
        if (MANAGEMENT_TOOL_NAMES.has(name)) {
          delete args.callerId;
          if (explicitEnvironment && name.startsWith("cdp_extension_")) {
            await this.manager.select(sessionId, explicitEnvironment);
          }
          return await this.#callManagement(name, args, sessionId);
        }

        delete args.environmentId;
        delete args.callerId;
        if (explicitEnvironment) await this.manager.select(sessionId, explicitEnvironment);
        return await this.manager.callBackend(sessionId, name, args, extra.signal);
      } catch (error) {
        log.warn(`${name} failed for ${sessionId}: ${errorMessage(error)}`);
        return text(errorMessage(error), true);
      }
    });
  }

  async #callManagement(name: string, args: Args, sessionId: string): Promise<CallToolResult> {
    switch (name) {
      case "cdp_environment_create": {
        const fresh = args.fresh === undefined ? false : booleanArg(args, "fresh");
        const headless = args.headless === undefined ? undefined : booleanArg(args, "headless");
        const environment = await this.manager.createNamed(
          sessionId,
          stringArg(args, "name", false),
          { fresh, headless, devExtensionPaths: stringArrayArg(args, "devExtensionPaths") },
        );
        return text({ id: environment.id, state: environment.state, port: environment.record.port });
      }
      case "cdp_environment_list":
        return text(this.manager.list(sessionId));
      case "cdp_environment_select": {
        const environment = await this.manager.select(sessionId, stringArg(args, "environmentId")!);
        return text({ id: environment.id, state: environment.state, port: environment.record.port });
      }
      case "cdp_environment_stop": {
        const id =
          stringArg(args, "environmentId", false) ?? this.manager.boundEnvironmentId(sessionId);
        if (!id) throw new Error("No environment selected and no environmentId was provided.");
        await this.manager.stop(id, sessionId);
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
        return text(await this.manager.listExtensions(sessionId));
      case "cdp_extension_set_enabled": {
        const result = await this.manager.setExtensionEnabled(
          sessionId,
          stringArg(args, "extensionId")!,
          booleanArg(args, "enabled"),
        );
        return text(result, !result.ok);
      }
      case "cdp_extension_reload": {
        const result = await this.manager.reloadExtension(
          sessionId,
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
