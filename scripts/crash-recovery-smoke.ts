/** Proves a new proxy reconnects to a verified Brave process after a hard proxy crash. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const LOCALAPPDATA = process.env.LOCALAPPDATA!;
const root = join(process.env.TEMP ?? LOCALAPPDATA, "multi-cdp-mcp-crash-smoke");
const configPath = join(root, "config.json");
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
await writeFile(
  configPath,
  JSON.stringify({
    dataRoot: root,
    profileSource: {
      mode: "clone",
      sourceUserDataDir: join(LOCALAPPDATA, "multi-cdp-mcp", "templates", "default"),
      refreshTemplate: true,
    },
    extensions: { controlExtensionPath: join(process.cwd(), "extensions", "control") },
    browser: { portRange: { start: 9620, end: 9625 } },
  }),
  "utf8",
);

const env = Object.fromEntries(
  Object.entries({ ...process.env, MULTI_CDP_MCP_CONFIG: configPath }).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  ),
);

function start(): { client: Client; transport: StdioClientTransport } {
  const transport = new StdioClientTransport({
    command: "bun",
    args: [join(process.cwd(), "src", "index.ts")],
    env,
    stderr: "inherit",
  });
  return { client: new Client({ name: "crash-smoke", version: "0.1.0" }), transport };
}

async function call(
  client: Client,
  sessionID: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  const result = (await client.callTool({
    name,
    arguments: args,
    _meta: { sessionID },
  })) as CallToolResult;
  if (result.isError) throw new Error(JSON.stringify(result.content));
  return result;
}

function text(result: CallToolResult): string {
  return result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

let first = start();
await first.client.connect(first.transport);
await call(first.client, "before-crash", "cdp_environment_create", { name: "crash-recovery" });
const before = JSON.parse(text(await call(first.client, "before-crash", "cdp_environment_list"))) as Array<{
  id: string;
  port: number;
}>;
const port = before.find((environment) => environment.id === "crash-recovery")!.port;

const proxyPid = (
  first.transport as unknown as { _process?: { pid?: number } }
)._process?.pid;
if (!proxyPid) throw new Error("Cannot obtain proxy pid from stdio transport.");
const killed = Bun.spawn(["taskkill", "/PID", String(proxyPid), "/F"], {
  stdout: "ignore",
  stderr: "ignore",
});
await killed.exited;
await Bun.sleep(2_000);

const endpoint = await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null);
if (!endpoint?.ok) throw new Error("Detached Brave did not survive the hard proxy crash.");
console.error(`+ Brave survived hard proxy crash on port ${port}`);

const second = start();
await second.client.connect(second.transport);
try {
  await call(second.client, "after-crash", "cdp_environment_select", {
    environmentId: "crash-recovery",
  });
  await call(second.client, "after-crash", "list_pages");
  const after = JSON.parse(
    text(await call(second.client, "after-crash", "cdp_environment_list")),
  ) as Array<{ id: string; port: number; state: string }>;
  const recovered = after.find((environment) => environment.id === "crash-recovery")!;
  if (recovered.port !== port || recovered.state !== "running") {
    throw new Error(`Unexpected recovered state: ${JSON.stringify(recovered)}`);
  }
  console.error(`+ new proxy reconnected to the verified existing browser`);
  await call(second.client, "after-crash", "cdp_environment_stop", {
    environmentId: "crash-recovery",
  });
} finally {
  await second.client.close().catch(() => {});
  await second.transport.close().catch(() => {});
}

console.error("+ crash-recovery smoke test passed");
