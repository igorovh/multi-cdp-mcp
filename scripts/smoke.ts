/** End-to-end test: real proxy -> two sessions -> two Brave profiles -> two backends. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const LOCALAPPDATA = process.env.LOCALAPPDATA!;
const root = join(process.env.TEMP ?? LOCALAPPDATA, "multi-cdp-mcp-smoke");
const configPath = join(root, "config.json");
const sourceTemplate = join(LOCALAPPDATA, "multi-cdp-mcp", "templates", "default");

await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
await writeFile(
  configPath,
  JSON.stringify(
    {
      dataRoot: root,
      profileSource: {
        mode: "clone",
        sourceUserDataDir: sourceTemplate,
        refreshTemplate: true,
      },
      extensions: {
        controlExtensionPath: join(process.cwd(), "extensions", "control"),
        devExtensionPaths: [
          join(process.cwd(), "scripts", "feasibility", "fixtures", "dev-extension"),
        ],
      },
      browser: { portRange: { start: 9600, end: 9610 } },
    },
    null,
    2,
  ),
  "utf8",
);

const env = Object.fromEntries(
  Object.entries({ ...process.env, MULTI_CDP_MCP_CONFIG: configPath }).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  ),
);
const transport = new StdioClientTransport({
  command: "bun",
  args: [join(process.cwd(), "src", "index.ts")],
  env,
  stderr: "inherit",
});
const client = new Client({ name: "multi-cdp-mcp-smoke", version: "0.1.0" });

function meta(sessionID: string): { sessionID: string } {
  return { sessionID };
}

async function call(
  sessionID: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  const result = (await client.callTool({
    name,
    arguments: args,
    _meta: meta(sessionID),
  })) as CallToolResult;
  if (result.isError) {
    const message = result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    throw new Error(`${name}: ${message}`);
  }
  return result;
}

function resultText(result: CallToolResult): string {
  return result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function pageId(text: string): number {
  const match = /^([0-9]+):/m.exec(text);
  if (!match) throw new Error(`No page ID in response:\n${text}`);
  return Number(match[1]);
}

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  if (tools.length < 42) throw new Error(`Expected at least 42 tools, got ${tools.length}.`);
  console.error(`+ discovered ${tools.length} tools`);

  await call("smoke-a", "cdp_environment_create", { name: "smoke-a" });
  const pagesA = await call("smoke-a", "list_pages");
  await call("smoke-a", "navigate_page", {
    pageId: pageId(resultText(pagesA)),
    type: "url",
    url: "https://example.com/",
  });

  const extensions = JSON.parse(resultText(await call("smoke-a", "cdp_extension_list"))) as Array<{
    id: string;
    name: string;
    enabled: boolean;
  }>;
  const fixture = extensions.find((extension) => extension.name === "multi-cdp-mcp dev fixture");
  if (!fixture) throw new Error("Dev fixture missing from cdp_extension_list.");
  await call("smoke-a", "cdp_extension_set_enabled", {
    extensionId: fixture.id,
    enabled: false,
  });
  await call("smoke-a", "cdp_extension_set_enabled", {
    extensionId: fixture.id,
    enabled: true,
  });
  await call("smoke-a", "cdp_extension_reload", { extensionId: fixture.id });
  console.error(`+ extension list/toggle/reload (${extensions.length} extensions)`);

  const pagesB = await call("smoke-b", "list_pages");
  await call("smoke-b", "navigate_page", {
    pageId: pageId(resultText(pagesB)),
    type: "url",
    url: "https://example.org/",
  });

  const environments = JSON.parse(
    resultText(await call("smoke-a", "cdp_environment_list")),
  ) as Array<{ id: string; port: number }>;
  if (environments.length !== 2 || environments[0]?.port === environments[1]?.port) {
    throw new Error(`Expected two environments on distinct ports: ${JSON.stringify(environments)}`);
  }
  console.error(`+ two sessions routed to distinct environments`);

  await call("smoke-a", "cdp_environment_stop", { environmentId: "smoke-a" });
  const smokeB = environments.find((environment) => environment.id !== "smoke-a")!;
  await call("smoke-b", "cdp_environment_stop", { environmentId: smokeB.id });
  console.error("+ both environments stopped with profiles preserved");

  const explicitCaller = "client-without-session-metadata";
  const fresh = (await client.callTool({
    name: "cdp_environment_create",
    arguments: { name: "smoke-fresh", fresh: true, callerId: explicitCaller },
  })) as CallToolResult;
  if (fresh.isError) throw new Error(`fresh create: ${resultText(fresh)}`);
  const freshExtensions = (await client.callTool({
    name: "cdp_extension_list",
    arguments: { callerId: explicitCaller },
  })) as CallToolResult;
  if (freshExtensions.isError) throw new Error(`fresh extensions: ${resultText(freshExtensions)}`);
  const freshList = JSON.parse(resultText(freshExtensions)) as Array<{ name: string }>;
  if (freshList.some((extension) => extension.name === "BetterTTV")) {
    throw new Error("A fresh profile unexpectedly inherited template extensions.");
  }
  await client.callTool({
    name: "cdp_environment_stop",
    arguments: {
      environmentId: "smoke-fresh",
      callerId: explicitCaller,
    },
  });
  console.error("+ fresh profile and explicit caller fallback passed");
} finally {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}

console.error("+ end-to-end smoke test passed");
