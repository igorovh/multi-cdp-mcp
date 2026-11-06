import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock, writeFileAtomic } from "./locked-file.ts";

const root = join(tmpdir(), "multi-cdp-mcp-lock-tests", String(process.pid));
const lock = join(root, "registry.lock");

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("cross-process file lock", () => {
  test("takes over a lock left by a dead process and removes it afterwards", async () => {
    await mkdir(root, { recursive: true });
    await writeFile(lock, JSON.stringify({ pid: 2_147_483_647, token: "dead", acquiredAt: Date.now() }));
    expect(await withFileLock(lock, async () => "ran")).toBe("ran");
    expect(await readdir(root)).toEqual([]);
  });

  test("waits for a live holder instead of breaking its lock", async () => {
    await mkdir(root, { recursive: true });
    await writeFile(lock, JSON.stringify({ pid: process.pid, token: "live", acquiredAt: Date.now() }));
    await expect(withFileLock(lock, async () => "ran", { timeoutMs: 200 })).rejects.toThrow("Timed out");
    expect(JSON.parse(await readFile(lock, "utf8")).token).toBe("live");
  });
});

describe("atomic write", () => {
  test("replaces the file and leaves no temporary files", async () => {
    await mkdir(root, { recursive: true });
    const target = join(root, "data.json");
    await writeFileAtomic(target, "one");
    await writeFileAtomic(target, "two");
    expect(await readFile(target, "utf8")).toBe("two");
    expect(await readdir(root)).toEqual(["data.json"]);
  });
});
