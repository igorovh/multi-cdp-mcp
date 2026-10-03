import { cp, mkdir, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { log } from "../logging.ts";

/** Process-bound files and large rebuildable caches that must not enter a clone. */
const PRUNED_SEGMENTS = new Set([
  "Crashpad",
  "CrashpadMetrics-active.pma",
  "BrowserMetrics",
  "BrowserMetrics-spare.pma",
  "GrShaderCache",
  "ShaderCache",
  "GPUPersistentCache",
  "GPUCache",
  "Cache",
  "Code Cache",
  "DawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "component_crx_cache",
  "extensions_crx_cache",
  "SingletonLock",
  "SingletonCookie",
  "SingletonSocket",
  "lockfile",
]);

function isPruned(sourceRoot: string, path: string): boolean {
  const rel = relative(sourceRoot, path);
  if (rel === "") return false;
  return rel.split(sep).some((segment) => PRUNED_SEGMENTS.has(segment));
}

export async function directorySizeBytes(root: string): Promise<number> {
  let total = 0;
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (isPruned(root, path)) continue;
      if (entry.isDirectory()) {
        queue.push(path);
      } else if (entry.isFile()) {
        try {
          total += (await stat(path)).size;
        } catch {
          // Files can vanish mid-walk; ignore.
        }
      }
    }
  }
  return total;
}

export function formatGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export interface CopyStats {
  files: number;
  bytes: number;
  skipped: Array<{ path: string; reason: string }>;
}

/** Copies a profile while collecting per-file failures instead of discarding the clone. */
export async function copyProfile(source: string, destination: string): Promise<CopyStats> {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });

  const stats: CopyStats = { files: 0, bytes: 0, skipped: [] };
  const queue: string[] = [""];

  while (queue.length > 0) {
    const relDir = queue.pop()!;
    const sourceDir = join(source, relDir);
    const targetDir = join(destination, relDir);

    let entries;
    try {
      entries = await readdir(sourceDir, { withFileTypes: true });
    } catch (error) {
      stats.skipped.push({ path: relDir || ".", reason: (error as Error).message });
      continue;
    }

    await mkdir(targetDir, { recursive: true });

    for (const entry of entries) {
      const sourcePath = join(sourceDir, entry.name);
      if (isPruned(source, sourcePath)) continue;

      if (entry.isDirectory()) {
        queue.push(join(relDir, entry.name));
        continue;
      }
      // Symlinks in a Chromium profile are singleton locks; they must not be carried over.
      if (!entry.isFile()) continue;

      try {
        await cp(sourcePath, join(targetDir, entry.name), { force: true, dereference: false });
        stats.files += 1;
        stats.bytes += (await stat(sourcePath)).size;
      } catch (error) {
        stats.skipped.push({ path: join(relDir, entry.name), reason: (error as Error).message });
      }
    }
  }

  if (stats.skipped.length > 0) {
    log.warn(`Skipped ${stats.skipped.length} unreadable file(s) while copying ${source}`);
    for (const entry of stats.skipped.slice(0, 5)) {
      log.warn(`  ${entry.path}: ${entry.reason}`);
    }
  }
  return stats;
}

/** Creates an empty user data directory that Brave will populate on first run. */
export async function createFreshProfile(destination: string): Promise<void> {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, "First Run"), "", "utf8");
}

export interface PrepareTemplateOptions {
  mode: "clone" | "fresh" | "template";
  sourceUserDataDir: string;
  templateDir: string;
  maxTemplateSizeGb: number;
  refresh?: boolean;
}

export async function prepareTemplate(options: PrepareTemplateOptions): Promise<string> {
  const { mode, sourceUserDataDir, templateDir, maxTemplateSizeGb, refresh = true } = options;

  if (mode === "template") {
    if (!(await exists(templateDir))) {
      throw new Error(`Template mode selected but ${templateDir} does not exist.`);
    }
    log.info(`Reusing existing template at ${templateDir}`);
    return templateDir;
  }

  if (mode === "fresh") {
    await createFreshProfile(templateDir);
    log.ok(`Created empty template at ${templateDir}`);
    return templateDir;
  }

  if (!refresh && (await exists(templateDir))) {
    log.info(`Reusing existing cloned template at ${templateDir}`);
    return templateDir;
  }

  if (!(await exists(sourceUserDataDir))) {
    throw new Error(`Source user data directory not found: ${sourceUserDataDir}`);
  }

  const size = await directorySizeBytes(sourceUserDataDir);
  log.info(`Source profile size after pruning caches: ${formatGb(size)}`);
  if (size > maxTemplateSizeGb * 1024 ** 3) {
    throw new Error(
      `Source profile is ${formatGb(size)}, above the ${maxTemplateSizeGb} GB limit. ` +
        `Raise maxTemplateSizeGb in config.ts if this is expected.`,
    );
  }

  const stats = await copyProfile(sourceUserDataDir, templateDir);
  log.ok(`Template written to ${templateDir} (${stats.files} files, ${formatGb(stats.bytes)})`);
  return templateDir;
}

export async function cloneEnvironment(templateDir: string, environmentDir: string): Promise<void> {
  await copyProfile(templateDir, environmentDir);
}

const LOCK_FILE = ".multi-cdp-mcp.lock";

interface LockContents {
  pid: number;
  acquiredAt: string;
}

async function processAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Exclusively leases a profile across proxy processes and takes over dead owners. */
export async function acquireProfileLock(profileDir: string): Promise<() => Promise<void>> {
  const lockPath = join(profileDir, LOCK_FILE);
  await mkdir(profileDir, { recursive: true });
  const contents: LockContents = { pid: process.pid, acquiredAt: new Date().toISOString() };
  let acquired = false;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(JSON.stringify(contents), "utf8");
      } finally {
        await handle.close();
      }
      acquired = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let existing: LockContents | null = null;
      try {
        existing = JSON.parse(await readFile(lockPath, "utf8")) as LockContents;
      } catch {
        // A writer may still be filling the newly-created file. Do not steal it.
        await Bun.sleep(100);
        continue;
      }
      if (await processAlive(existing.pid)) {
        throw new Error(
          `Profile ${profileDir} is locked by process ${existing.pid} since ${existing.acquiredAt}.`,
        );
      }
      log.debug(`Taking over stale profile lock from pid ${existing.pid}`);
      await rm(lockPath, { force: true });
    }
  }
  if (!acquired) throw new Error(`Could not acquire profile lock at ${lockPath}.`);

  return async () => {
    try {
      const current = JSON.parse(await readFile(lockPath, "utf8")) as LockContents;
      if (current.pid === process.pid) await rm(lockPath, { force: true });
    } catch {
      // Already removed.
    }
  };
}

export { prepareUnpackedExtensions } from "./extensions.ts";
