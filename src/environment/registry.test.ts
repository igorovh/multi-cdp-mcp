import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(tmpdir(), "multi-cdp-mcp-registry-tests", String(process.pid));
const writer = join(import.meta.dir, "__fixtures__", "registry-writer.ts");

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function runWriter(name: string, count: number): Promise<void> {
  const proc = Bun.spawn([process.execPath, writer, root, name, String(count)], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${name} exited with ${code}: ${await new Response(proc.stderr).text()}`);
}

describe("environment registry across processes", () => {
  // OpenCode runs one MCP server process per directory, all sharing the same dataRoot.
  test("keeps every record when several processes write at once", async () => {
    await mkdir(root, { recursive: true });
    const writers = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
    const perWriter = 15;
    await Promise.all(writers.map((name) => runWriter(name, perWriter)));

    const file = JSON.parse(await readFile(join(root, "environments.json"), "utf8")) as {
      environments: Array<{ id: string }>;
    };
    const ids = new Set(file.environments.map((environment) => environment.id));
    expect(ids.size).toBe(writers.length * perWriter);
  }, 60_000);
});
