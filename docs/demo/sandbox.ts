/**
 * Builds an isolated OpenCode sandbox for docs/demo.tape: temporary home, XDG dirs and a fake
 * project, a free model and this repository's MCP server. Usage: bun docs/demo/sandbox.ts <root>
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const MODEL = process.env.DEMO_MODEL ?? "opencode/glm-5.3-flash-free";
const root = resolve(process.argv[2] ?? "demo-sandbox");
const repo = resolve(import.meta.dir, "..", "..");
const home = join(root, "home");
const project = join(home, "demo", "acme-shop");
const config = join(root, "config", "opencode");

await rm(root, { recursive: true, force: true });
for (const dir of [project, config, join(root, "data"), join(root, "state"), join(root, "cache")]) {
  await mkdir(dir, { recursive: true });
}

await writeFile(join(project, "README.md"), "# acme-shop\n\nStorefront and CRM for Acme Corp.\n");
await writeFile(
  join(project, "AGENTS.md"),
  "Use only the multi-cdp page tools (new_page, navigate_page, take_snapshot, click, fill_form). " +
    "Never sign in unless asked. Answer in one short sentence.\n",
);
await writeFile(
  join(root, "multi-cdp.json"),
  JSON.stringify({ dataRoot: join(root, "multi-cdp"), browser: { portRange: { start: 9700, end: 9709 } } }),
);

// The browser must see the real profile variables; the sandbox only fakes them for OpenCode.
const realEnv = Object.fromEntries(
  ["USERPROFILE", "HOME", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP"]
    .map((key) => [key, process.env[key]])
    .filter((entry): entry is [string, string] => entry[1] !== undefined),
);
const deny = [
  ...["shell", "edit", "write", "webfetch", "websearch", "subagent", "external_directory"],
  // Each session keeps its own environment; the demo is about isolation, not handover.
  "multi-cdp_cdp_environment_*",
];

await writeFile(
  join(config, "opencode.jsonc"),
  JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      model: MODEL,
      username: "dana",
      update: "disable",
      share: "disabled",
      permissions: [
        { action: "*", resource: "*", effect: "allow" },
        ...deny.map((action) => ({ action, resource: "*", effect: "deny" })),
      ],
      mcp: {
        servers: {
          "multi-cdp": {
            type: "local",
            command: [process.execPath, "run", join(repo, "src", "index.ts")],
            environment: { ...realEnv, MULTI_CDP_MCP_CONFIG: join(root, "multi-cdp.json") },
            codemode: false,
            timeout: { startup: 60000, catalog: 30000, execution: 600000 },
          },
        },
      },
    },
    null,
    2,
  ),
);
await writeFile(
  join(config, "cli.json"),
  JSON.stringify({ tabs: { scope: "global", layout: "vertical", mode: "auto" } }, null, 2),
);
console.log(project);
