/** Scripted MCP client for docs/demo.tape: three fake agent conversations, local test pages. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PAGES: Record<string, string> = {
  "/shop/checkout": "Acme Shop · Checkout",
  "/docs/getting-started": "Acme Docs · Getting started",
  "/crm/login": "Acme CRM · Sign in",
};
const site = Bun.serve({
  port: 4173,
  hostname: "127.0.0.1",
  fetch: (request) => {
    const title = PAGES[new URL(request.url).pathname] ?? "Acme";
    return new Response(`<!doctype html><meta charset="utf-8"><title>${title}</title><h1>${title}</h1>`, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
});

const root = join(tmpdir(), "multi-cdp-mcp-demo");
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
const configPath = join(root, "config.json");
await writeFile(
  configPath,
  JSON.stringify({ dataRoot: root, browser: { portRange: { start: 9700, end: 9709 } } }),
);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(import.meta.dir, "..", "..", "src", "index.ts")],
  env: { ...(process.env as Record<string, string>), MULTI_CDP_MCP_CONFIG: configPath },
  stderr: "ignore",
});
const client = new Client({ name: "demo", version: "0" });
await client.connect(transport);

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;
const cyan = (text: string) => `\x1b[36m${text}\x1b[0m`;
const green = (text: string) => `\x1b[32m${text}\x1b[0m`;

async function call(session: string, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = (await client.callTool({
    name,
    arguments: args,
    _meta: { "ai.opencode/sessionID": session },
  })) as CallToolResult;
  const text = result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
  if (result.isError) throw new Error(`${name}: ${text}`);
  return text;
}

async function evaluate<T>(session: string, fn: string): Promise<T> {
  const text = await call(session, "evaluate_script", { function: fn, pageId: 1 });
  return JSON.parse(/```json\s*\n([\s\S]*?)\n```/.exec(text)![1]!) as T;
}

const agents = [
  { session: "ses_checkout", env: "shop-checkout", path: "/shop/checkout" },
  { session: "ses_docs", env: "docs-research", path: "/docs/getting-started" },
  { session: "ses_crm", env: "crm-qa", path: "/crm/login" },
];

console.log(bold("3 agent conversations → 1 MCP server → 3 isolated browsers\n"));
await Promise.all(
  agents.map(async ({ session, env, path }) => {
    await call(session, "cdp_environment_create", { name: env });
    await call(session, "navigate_page", { pageId: 1, type: "url", url: `http://127.0.0.1:4173${path}` });
    const title = await evaluate<string>(session, "() => document.title");
    console.log(`${cyan(session.padEnd(13))} → ${env.padEnd(14)} ${green(`"${title}"`)}`);
  }),
);

console.log(`\n${cyan("ses_checkout")} sets cookie ${bold("cart=3-items")}`);
await evaluate(agents[0]!.session, "() => { document.cookie = 'cart=3-items; max-age=86400'; return true; }");
for (const { session } of agents) {
  const cookie = await evaluate<string>(session, "() => document.cookie");
  console.log(`  ${session.padEnd(13)} sees ${cookie ? green(cookie) : dim("(nothing)")}`);
}

console.log(`\n${bold("cdp_environment_list")}`);
const list = JSON.parse(await call("ses_checkout", "cdp_environment_list")) as Array<{
  id: string;
  state: string;
  port: number;
  ownerId: string;
}>;
console.log(dim(`  ${"ID".padEnd(15)}${"STATE".padEnd(9)}${"PORT".padEnd(6)}OWNER`));
for (const environment of list.sort((a, b) => a.port - b.port)) {
  console.log(
    `  ${environment.id.padEnd(15)}${green(environment.state.padEnd(9))}${String(environment.port).padEnd(6)}${environment.ownerId}`,
  );
}

console.log(`\n${bold("cdp_environment_stop")} shop-checkout ${dim("(profile kept)")}`);
await call("ses_checkout", "cdp_environment_stop", { environmentId: "shop-checkout" });
await call("ses_checkout", "navigate_page", { pageId: 1, type: "url", url: "http://127.0.0.1:4173/shop/checkout" });
const resumed = await evaluate<string>("ses_checkout", "() => document.cookie");
console.log(`resumed on next call, cookie still there: ${green(resumed)}`);

await call("ses_checkout", "cdp_environment_delete_all", { confirm: "DELETE ALL ENVIRONMENTS", force: true });
await client.close();
site.stop(true);
await rm(root, { recursive: true, force: true }).catch(() => {});
console.log(dim("\ndemo complete"));
process.exit(0);
