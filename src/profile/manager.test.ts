import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireProfileLock } from "./manager.ts";

const root = join(tmpdir(), "multi-cdp-mcp-unit-tests", String(process.pid));

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("profile locking", () => {
  test("rejects a second owner and can be acquired after release", async () => {
    await mkdir(root, { recursive: true });
    const release = await acquireProfileLock(root);
    await expect(acquireProfileLock(root)).rejects.toThrow("is locked by process");
    await release();

    const releaseAgain = await acquireProfileLock(root);
    await releaseAgain();
  });

  test("takes over a stale lock", async () => {
    await mkdir(root, { recursive: true });
    await Bun.write(
      join(root, ".multi-cdp-mcp.lock"),
      JSON.stringify({ pid: 2_147_483_647, acquiredAt: new Date(0).toISOString() }),
    );
    const release = await acquireProfileLock(root);
    await release();
  });
});
