/** Phase 4 acceptance: three concurrent conversations against one proxy. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { fixtureExtension, prepareRun } from "./harness.ts";

// Deliberately contains spaces: validates argument-array handling end to end.
const run = await prepareRun("multi cdp mcp acceptance", { start: 9640, end: 9650 }, [fixtureExtension]);
const transport = run.transport();
const client = new Client({ name: "multi-cdp-mcp-acceptance", version: "0.1.0" });

async function raw(
  sessionID: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args, _meta: { sessionID } })) as CallToolResult;
}

async function call(
  sessionID: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  const result = await raw(sessionID, name, args);
  if (result.isError) throw new Error(`${name}: ${text(result)}`);
  return result;
}

function text(result: CallToolResult): string {
  return result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function pageId(result: CallToolResult): number {
  const match = /^([0-9]+):/m.exec(text(result));
  if (!match) throw new Error(`No page ID in ${text(result)}`);
  return Number(match[1]);
}

interface EnvironmentView {
  id: string;
  port: number;
  state: string;
  owner: "self" | "other" | null;
  ownedByCaller: boolean;
}

async function ownEnvironment(session: string): Promise<EnvironmentView> {
  const list = JSON.parse(text(await call(session, "cdp_environment_list"))) as EnvironmentView[];
  const own = list.find((environment) => environment.ownedByCaller);
  if (!own) throw new Error(`${session} has no environment: ${JSON.stringify(list)}`);
  return own;
}

await client.connect(transport);
const sessions = ["acceptance-a", "acceptance-b", "acceptance-c"];

try {
  // Two simultaneous first calls from A must share one startup. B and C start in parallel.
  const [a1, a2, b, c] = await Promise.all([
    call(sessions[0]!, "list_pages"),
    call(sessions[0]!, "list_pages"),
    call(sessions[1]!, "list_pages"),
    call(sessions[2]!, "list_pages"),
  ]);
  const own = await Promise.all(sessions.map(ownEnvironment));
  if (new Set(own.map((environment) => environment.id)).size !== 3) {
    throw new Error(`Sessions did not receive three environments: ${JSON.stringify(own)}`);
  }
  if (new Set(own.map((environment) => environment.port)).size !== 3) {
    throw new Error(`Environments did not receive distinct ports: ${JSON.stringify(own)}`);
  }
  console.error("+ concurrent first calls created exactly three isolated environments");

  await Promise.all([
    call(sessions[0]!, "navigate_page", {
      pageId: pageId(a1),
      type: "url",
      url: "https://example.com/?environment=a",
    }),
    call(sessions[1]!, "navigate_page", {
      pageId: pageId(b),
      type: "url",
      url: "https://example.org/?environment=b",
    }),
    call(sessions[2]!, "navigate_page", {
      pageId: pageId(c),
      type: "url",
      url: "https://www.iana.org/help/example-domains?environment=c",
    }),
  ]);
  const currentPages = await Promise.all(sessions.map((session) => call(session, "list_pages")));
  const urls = currentPages.map(text);
  if (!urls[0]?.includes("environment=a") || !urls[1]?.includes("environment=b") || !urls[2]?.includes("environment=c")) {
    throw new Error(`Navigation leaked or went to the wrong environment: ${JSON.stringify(urls)}`);
  }
  console.error("+ navigation and selected pages stayed isolated");

  const screenshot = await call(sessions[0]!, "take_screenshot", {
    pageId: pageId(currentPages[0]!),
    format: "png",
  });
  if (!screenshot.content.some((item) => item.type === "image")) {
    throw new Error("Screenshot image content was flattened or lost by the proxy.");
  }
  const downstreamError = await raw(sessions[0]!, "select_page", { pageId: 999999 });
  if (!downstreamError.isError) throw new Error("Structured downstream error was not preserved.");
  console.error("+ screenshots and structured errors passed through unchanged");

  const extensions = JSON.parse(text(await call(sessions[0]!, "cdp_extension_list"))) as Array<{
    id: string;
    name: string;
  }>;
  if (!extensions.some((extension) => extension.name === "multi-cdp-mcp dev fixture")) {
    throw new Error(`Required extensions missing: ${JSON.stringify(extensions)}`);
  }
  console.error(`+ ${extensions.length} extensions available, including the dev build`);

  await call(sessions[0]!, "cdp_environment_stop", { environmentId: own[0]!.id });
  await call(sessions[1]!, "list_pages");
  console.error("+ stopping one environment left the others usable");

  await call(sessions[1]!, "cdp_environment_release");
  await call("acceptance-d", "cdp_environment_select", { environmentId: own[1]!.id });
  await call("acceptance-d", "list_pages");
  console.error("+ an environment was deliberately handed to another conversation");

  await call("acceptance-d", "cdp_environment_stop", { environmentId: own[1]!.id });
  await call(sessions[2]!, "cdp_environment_stop", { environmentId: own[2]!.id });
} finally {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}

console.error("+ three-conversation acceptance test passed");
