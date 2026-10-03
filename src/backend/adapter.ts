import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ProxyConfig } from "../config.ts";
import { errorMessage, log } from "../logging.ts";

export interface BackendOptions {
  environmentId: string;
  browserUrl: string;
  logDir: string;
  /** Directories path-taking tools may use; the backend also allows the OS temp directory. */
  filesystemRoots: string[];
}

function buildArgs(
  config: ProxyConfig,
  options: { browserUrl?: string; roots?: string[] },
): string[] {
  const args = [config.backend.entrypoint];
  if (options.browserUrl) args.push(`--browserUrl=${options.browserUrl}`);
  if (config.backend.enableExtensionTools) args.push("--categoryExtensions");
  for (const root of options.roots ?? []) args.push(`--filesystemRoot=${root}`);
  args.push("--usageStatistics=false");
  return args;
}

/** Owns one backend per environment and preserves downstream result structures. */
export class BackendAdapter {
  private constructor(
    readonly environmentId: string,
    private readonly client: Client,
    private readonly transport: StdioClientTransport,
    private readonly timeoutMs: number,
    readonly tools: Tool[],
  ) {}

  static async start(config: ProxyConfig, options: BackendOptions): Promise<BackendAdapter> {
    await mkdir(options.logDir, { recursive: true });
    await mkdir(options.filesystemRoots[0]!, { recursive: true });
    const logStream = createWriteStream(
      join(options.logDir, `backend-${options.environmentId}.log`),
      { flags: "a" },
    );

    const transport = new StdioClientTransport({
      command: config.backend.runtime,
      args: buildArgs(config, {
        browserUrl: options.browserUrl,
        roots: options.filesystemRoots,
      }),
      stderr: "pipe",
    });

    const client = new Client({ name: "multi-cdp-mcp", version: "0.1.0" });
    await client.connect(transport);
    transport.stderr?.pipe(logStream);

    const { tools } = await client.listTools();
    log.debug(`Backend for ${options.environmentId} exposes ${tools.length} tools`);
    return new BackendAdapter(
      options.environmentId,
      client,
      transport,
      config.limits.toolTimeoutMs,
      tools,
    );
  }

  /** Spawns a throwaway backend purely to read the tool schemas; never opens a browser. */
  static async discoverTools(config: ProxyConfig): Promise<Tool[]> {
    const transport = new StdioClientTransport({
      command: config.backend.runtime,
      // An unreachable endpoint: the backend connects lazily, so listTools stays cheap.
      args: buildArgs(config, { browserUrl: "http://127.0.0.1:1" }),
      stderr: "ignore",
    });
    const client = new Client({ name: "multi-cdp-mcp-discovery", version: "0.1.0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      return tools;
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<CallToolResult> {
    const timeout = options.timeoutMs ?? this.timeoutMs;
    try {
      return (await this.client.callTool({ name, arguments: args }, undefined, {
        timeout,
        signal: options.signal,
      })) as CallToolResult;
    } catch (error) {
      if (/Request timed out/i.test(errorMessage(error))) {
        throw new Error(
          `${name} did not finish within ${Math.round(timeout / 1000)} s (proxy timeout). The ` +
            "browser may still be busy with it. Background tabs throttle timers and " +
            "requestAnimationFrame: pass bringToFront: true, keep in-page waits short, or " +
            "pass a timeout for evaluate_script.",
        );
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    try {
      await this.client.close();
    } catch (error) {
      log.debug(`Closing backend for ${this.environmentId}: ${errorMessage(error)}`);
    }
    await this.transport.close().catch(() => {});
  }
}
