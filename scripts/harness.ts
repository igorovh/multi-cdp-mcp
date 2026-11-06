import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const fixtureExtension = join(process.cwd(), "scripts", "fixtures", "dev-extension");

/**
 * Writes an isolated proxy config. MULTI_CDP_BROWSER picks the browser (default "auto");
 * MULTI_CDP_CLONE_FROM clones that user-data directory instead of starting fresh.
 */
export async function prepareRun(
  name: string,
  portRange: { start: number; end: number },
  devExtensionPaths: string[] = [],
): Promise<{ root: string; transport: () => StdioClientTransport }> {
  const root = join(tmpdir(), name);
  const configPath = join(root, "config.json");
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const cloneFrom = process.env.MULTI_CDP_CLONE_FROM;
  await writeFile(
    configPath,
    JSON.stringify(
      {
        dataRoot: root,
        profileSource: cloneFrom
          ? { mode: "clone", sourceUserDataDir: cloneFrom, refreshTemplate: true }
          : { mode: "fresh" },
        extensions: { devExtensionPaths },
        browser: { executable: process.env.MULTI_CDP_BROWSER ?? "auto", portRange },
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
  return {
    root,
    transport: () =>
      new StdioClientTransport({
        command: process.execPath,
        args: [join(process.cwd(), "src", "index.ts")],
        env,
        stderr: "inherit",
      }),
  };
}
