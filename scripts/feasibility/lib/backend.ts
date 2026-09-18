import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage, log } from "./log.ts";

export type ConnectionMode = "browser-url" | "backend-launch";

export interface BackendOptions {
  entrypoint: string;
  runtime: "bun" | "node";
  enableExtensionTools: boolean;
  logDir: string;
  environmentId: string;
  /** Directory the backend may write screenshots into; it refuses paths outside its roots. */
  filesystemRoot: string;
}

export interface BrowserUrlTarget {
  mode: "browser-url";
  browserUrl: string;
}

export interface BackendLaunchTarget {
  mode: "backend-launch";
  executablePath: string;
  userDataDir: string;
}

export type BackendTarget = BrowserUrlTarget | BackendLaunchTarget;

export interface ToolCallResult {
  isError: boolean;
  text: string;
  imageCount: number;
}

function buildArgs(options: BackendOptions, target: BackendTarget): string[] {
  const args = [options.entrypoint];
  if (target.mode === "browser-url") {
    args.push(`--browserUrl=${target.browserUrl}`);
  } else {
    args.push(`--executablePath=${target.executablePath}`);
    args.push(`--userDataDir=${target.userDataDir}`);
  }
  if (options.enableExtensionTools) {
    args.push("--categoryExtensions");
  }
  args.push(`--filesystemRoot=${options.filesystemRoot}`);
  args.push("--usageStatistics=false");
  return args;
}

export class Backend {
  /** Set when page-id routing is on; page-scoped calls get this id injected. */
  selectedPageId: number | null = null;

  private constructor(
    readonly environmentId: string,
    readonly mode: ConnectionMode,
    private readonly client: Client,
    private readonly transport: StdioClientTransport,
    readonly toolNames: string[],
    private readonly pageIdTools: Set<string>,
  ) {}

  static async start(options: BackendOptions, target: BackendTarget): Promise<Backend> {
    await mkdir(options.logDir, { recursive: true });
    await mkdir(options.filesystemRoot, { recursive: true });
    const logStream = createWriteStream(
      join(options.logDir, `backend-${options.environmentId}-${target.mode}.log`),
      { flags: "a" },
    );

    const transport = new StdioClientTransport({
      command: options.runtime,
      args: buildArgs(options, target),
      stderr: "pipe",
    });

    const client = new Client({ name: "multi-cdp-mcp-feasibility", version: "0.0.0" });
    await client.connect(transport);
    transport.stderr?.pipe(logStream);

    const { tools } = await client.listTools();
    const toolNames = tools.map((tool) => tool.name).sort();
    const pageIdTools = new Set(
      tools
        .filter((tool) => {
          const required = tool.inputSchema?.required;
          return Array.isArray(required) && required.includes("pageId");
        })
        .map((tool) => tool.name),
    );
    log.ok(
      `Backend ready for ${options.environmentId} via ${target.mode}: ${toolNames.length} tools`,
    );
    return new Backend(
      options.environmentId,
      target.mode,
      client,
      transport,
      toolNames,
      pageIdTools,
    );
  }

  hasTool(name: string): boolean {
    return this.toolNames.includes(name);
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
    const callArgs = { ...args };
    if (this.pageIdTools.has(name) && callArgs.pageId === undefined && this.selectedPageId !== null) {
      callArgs.pageId = this.selectedPageId;
    }
    try {
      const result = await this.client.callTool({ name, arguments: callArgs }, undefined, {
        timeout: 60_000,
      });
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content
        .filter((item): item is { type: "text"; text: string } => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      return {
        isError: result.isError === true,
        text,
        imageCount: content.filter((item) => item.type === "image").length,
      };
    } catch (error) {
      return { isError: true, text: errorMessage(error), imageCount: 0 };
    }
  }

  async close(): Promise<void> {
    try {
      await this.client.close();
    } catch (error) {
      log.warn(`Closing backend for ${this.environmentId} failed: ${errorMessage(error)}`);
    }
    await this.transport.close().catch(() => {});
  }
}
