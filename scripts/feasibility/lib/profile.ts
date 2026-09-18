import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { log } from "./log.ts";

/**
 * Caches, crash dumps and singleton locks. Excluded because they are either
 * process-bound (a copied lock confuses the new browser) or large and rebuildable.
 */
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

/**
 * Copies a user data directory, skipping caches, crash dumps and singleton locks.
 * Per-file failures are collected instead of aborting: a single locked file must not
 * discard a multi-gigabyte copy.
 */
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
}

export async function prepareTemplate(options: PrepareTemplateOptions): Promise<string> {
  const { mode, sourceUserDataDir, templateDir, maxTemplateSizeGb } = options;

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

export interface ManagedExtension {
  id: string;
  name: string;
  version: string;
  path: string;
}

interface SecurePreferences {
  extensions?: {
    settings?: Record<
      string,
      { path?: string; manifest?: { name?: string; version?: string; key?: string } }
    >;
  };
}

/**
 * Turns the profile's Web Store extensions into unpacked ones that can be loaded with
 * --load-extension. A cloned profile loses its extension install records on the first
 * restart, because Chromium rejects the copied tracked-preference MACs. Re-declaring the
 * public key in each manifest keeps the original extension ID, so the extension's origin
 * — and therefore its stored settings — survive.
 */
export async function prepareUnpackedExtensions(profileRoot: string): Promise<ManagedExtension[]> {
  const preferencesPath = join(profileRoot, "Default", "Secure Preferences");
  let parsed: SecurePreferences;
  try {
    parsed = JSON.parse(await readFile(preferencesPath, "utf8")) as SecurePreferences;
  } catch (error) {
    log.warn(`Cannot read ${preferencesPath}: ${(error as Error).message}`);
    return [];
  }

  const found: ManagedExtension[] = [];
  for (const [id, entry] of Object.entries(parsed.extensions?.settings ?? {})) {
    const { path: relativePath, manifest } = entry;
    if (!relativePath || !manifest?.key || !manifest.name || !manifest.version) continue;
    // Absolute paths belong to component extensions shipped with the browser.
    if (isAbsolute(relativePath)) continue;

    const directory = join(profileRoot, "Default", "Extensions", relativePath);
    const manifestPath = join(directory, "manifest.json");
    let onDisk: Record<string, unknown>;
    try {
      onDisk = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    } catch {
      log.warn(`Skipping ${manifest.name}: no readable manifest at ${manifestPath}`);
      continue;
    }

    if (onDisk.key !== manifest.key) {
      onDisk.key = manifest.key;
      await writeFile(manifestPath, JSON.stringify(onDisk, null, 2), "utf8");
    }

    found.push({ id, name: manifest.name, version: manifest.version, path: directory });
  }

  log.ok(`Prepared ${found.length} unpacked extension(s) from ${profileRoot}`);
  return found;
}
