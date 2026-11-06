import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";

interface LockContents {
  pid: number;
  token: string;
  acquiredAt: number;
}

const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sameLock(a: LockContents | null, b: LockContents | null): boolean {
  return a !== null && b !== null && a.token === b.token;
}

async function readLock(path: string): Promise<LockContents | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as LockContents;
  } catch {
    return null;
  }
}

/** A dead owner, or a lock held far longer than any registry write takes (PID reuse). */
async function isStale(path: string, contents: LockContents | null, staleMs: number): Promise<boolean> {
  if (contents) return !processAlive(contents.pid) || Date.now() - contents.acquiredAt > staleMs;
  // Empty or half-written: the writer may still be filling it, so only age decides.
  try {
    return Date.now() - (await stat(path)).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

/** Removes a stale lock by renaming it first, so two processes cannot both remove a fresh one. */
async function breakStaleLock(path: string, seen: LockContents | null): Promise<void> {
  const parked = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.stale`;
  try {
    await rename(path, parked);
  } catch {
    return;
  }
  const taken = await readLock(parked);
  if (seen && !sameLock(seen, taken)) {
    // Another process replaced the stale lock in the meantime; give its lock back.
    await rename(parked, path).catch(() => {});
    return;
  }
  await rm(parked, { force: true });
}

/** Runs `fn` while holding an exclusive cross-process lock file at `path`. */
export async function withFileLock<T>(
  path: string,
  fn: () => Promise<T>,
  options: { timeoutMs?: number; staleMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const staleMs = options.staleMs ?? 30_000;
  const contents: LockContents = { pid: process.pid, token: randomUUID(), acquiredAt: Date.now() };
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(JSON.stringify(contents), "utf8");
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      // Windows reports a lock that another process is deleting as EPERM, not EEXIST.
      if (code !== "EEXIST" && !RETRYABLE.has(code)) throw error;
      if (code !== "EEXIST") {
        if (Date.now() > deadline) throw error;
        await Bun.sleep(5 + Math.random() * 20);
        continue;
      }
    }
    const existing = await readLock(path);
    if (await isStale(path, existing, staleMs)) {
      await breakStaleLock(path, existing);
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${path} (held by pid ${existing?.pid ?? "unknown"}).`);
    }
    await Bun.sleep(5 + Math.random() * 20);
  }

  try {
    return await fn();
  } finally {
    if (sameLock(contents, await readLock(path))) await rm(path, { force: true });
  }
}

/** Writes through a unique temporary file and renames it into place. */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temporary, data, "utf8");
  // Windows refuses to replace a file another process is reading; retry briefly.
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temporary, path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!RETRYABLE.has(code) || attempt >= 40) {
        await rm(temporary, { force: true });
        throw error;
      }
      await Bun.sleep(25);
    }
  }
}
