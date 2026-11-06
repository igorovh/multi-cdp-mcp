import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, win32 } from "node:path";
import { log } from "../logging.ts";

export interface ProfileExtension {
  id: string;
  name: string;
  version: string;
  path: string;
}

/** Chromium's `extensions::Manifest::Location::kUnpacked`. */
const LOCATION_UNPACKED = 4;

function idFromDigest(bytes: Buffer): string {
  return [...createHash("sha256").update(bytes).digest("hex").slice(0, 32)]
    .map((char) => String.fromCharCode(97 + Number.parseInt(char, 16)))
    .join("");
}

export function extensionIdFromKey(base64Key: string): string {
  return idFromDigest(Buffer.from(base64Key, "base64"));
}

/** Mirrors crx_file::id_util::GenerateIdForPath, including Windows drive-letter normalisation. */
export function extensionIdFromPath(path: string, platform = process.platform): string {
  if (platform === "win32") {
    let normalized = win32.resolve(path);
    if (/^[a-z]:/.test(normalized)) normalized = normalized[0]!.toUpperCase() + normalized.slice(1);
    return idFromDigest(Buffer.from(normalized, "utf16le"));
  }
  return idFromDigest(Buffer.from(posix.resolve(path), "utf8"));
}

function compareVersions(a: string, b: string): number {
  const left = a.split(/[._]/).map(Number);
  const right = b.split(/[._]/).map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function readManifest(directory: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

export async function manifestName(directory: string): Promise<string | null> {
  const manifest = await readManifest(directory);
  return typeof manifest?.name === "string" ? manifest.name : null;
}

interface SecurePreferences {
  extensions?: {
    settings?: Record<
      string,
      {
        path?: string;
        location?: number;
        manifest?: { name?: string; version?: string; key?: string };
      }
    >;
  };
}

async function readSettings(profileRoot: string): Promise<NonNullable<SecurePreferences["extensions"]>["settings"]> {
  const preferencesPath = join(profileRoot, "Default", "Secure Preferences");
  try {
    const parsed = JSON.parse(await readFile(preferencesPath, "utf8")) as SecurePreferences;
    return parsed.extensions?.settings ?? {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn(`Cannot read ${preferencesPath}: ${(error as Error).message}`);
    }
    return {};
  }
}

/** Extensions under Default/Extensions whose on-disk manifest key reproduces the directory's ID. */
async function scanKeyedExtensions(profileRoot: string): Promise<Map<string, ProfileExtension>> {
  const found = new Map<string, ProfileExtension>();
  const root = join(profileRoot, "Default", "Extensions");
  let ids: string[];
  try {
    ids = await readdir(root);
  } catch {
    return found;
  }
  for (const id of ids) {
    if (!/^[a-p]{32}$/.test(id)) continue;
    let versions: string[];
    try {
      versions = await readdir(join(root, id));
    } catch {
      continue;
    }
    for (const version of versions) {
      const path = join(root, id, version);
      const manifest = await readManifest(path);
      if (typeof manifest?.key !== "string" || extensionIdFromKey(manifest.key) !== id) continue;
      const candidate: ProfileExtension = {
        id,
        name: String(manifest.name ?? id),
        version: String(manifest.version ?? version),
        path,
      };
      const current = found.get(id);
      if (!current || compareVersions(candidate.version, current.version) > 0) found.set(id, candidate);
    }
  }
  return found;
}

/**
 * Re-declares profile extensions as unpacked with their original IDs. Chromium drops the
 * copied manifest from Secure Preferences after the first launch, so later launches rely
 * on the key that the first materialisation wrote into each on-disk manifest.
 */
export async function prepareUnpackedExtensions(profileRoot: string): Promise<ProfileExtension[]> {
  const found = await scanKeyedExtensions(profileRoot);
  const settings = await readSettings(profileRoot);
  for (const [id, entry] of Object.entries(settings ?? {})) {
    const { path: relativePath, manifest } = entry;
    if (!relativePath || isAbsolute(relativePath)) continue;
    if (!manifest?.key || !manifest.name || !manifest.version) continue;

    const directory = join(profileRoot, "Default", "Extensions", relativePath);
    const onDisk = await readManifest(directory);
    if (!onDisk) {
      log.warn(`Skipping ${manifest.name}: no readable manifest in ${directory}`);
      continue;
    }
    if (onDisk.key !== manifest.key) {
      onDisk.key = manifest.key;
      await writeFile(join(directory, "manifest.json"), JSON.stringify(onDisk, null, 2), "utf8");
    }
    found.set(id, { id, name: manifest.name, version: manifest.version, path: directory });
  }

  const result = [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
  log.ok(`Prepared ${result.length} unpacked extension(s) from ${profileRoot}`);
  return result;
}

/**
 * "Load unpacked" extensions recorded in a source profile. A clone inherits their records
 * with an invalid MAC, so Chromium keeps them disabled and refuses to let anyone enable them.
 */
export async function unpackedSourceExtensions(profileRoot: string): Promise<ProfileExtension[]> {
  const result: ProfileExtension[] = [];
  for (const [id, entry] of Object.entries((await readSettings(profileRoot)) ?? {})) {
    if (entry.location !== LOCATION_UNPACKED || !entry.path || !isAbsolute(entry.path)) continue;
    try {
      if (!(await stat(join(entry.path, "manifest.json"))).isFile()) continue;
    } catch {
      continue;
    }
    const manifest = await readManifest(entry.path);
    result.push({
      id,
      name: String(manifest?.name ?? id),
      version: String(manifest?.version ?? ""),
      path: entry.path,
    });
  }
  return result;
}

/** Rejects paths that --load-extension would misparse or that are not unpacked extensions. */
export async function validateExtensionDirectory(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error(`Extension path must be absolute: ${path}`);
  // --load-extension takes one comma-separated list.
  if (path.includes(",")) throw new Error(`Extension path must not contain a comma: ${path}`);
  try {
    if ((await stat(join(path, "manifest.json"))).isFile()) return;
  } catch {
    // Reported below.
  }
  throw new Error(`No manifest.json in extension directory: ${path}`);
}

/**
 * Chromium 134+ disables command-line extensions on restart while developer mode is off;
 * Edge does so after some restarts too. The preference must be set before launch.
 */
export async function enableDeveloperMode(profileRoot: string): Promise<void> {
  const path = join(profileRoot, "Default", "Preferences");
  let preferences: Record<string, unknown> = {};
  try {
    preferences = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn(`Cannot read ${path}; leaving developer mode unchanged: ${(error as Error).message}`);
      return;
    }
  }
  const extensions = (preferences.extensions ??= {}) as Record<string, unknown>;
  const ui = (extensions.ui ??= {}) as Record<string, unknown>;
  if (ui.developer_mode === true) return;
  ui.developer_mode = true;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(preferences), "utf8");
}

/** Order-preserving de-duplication; Windows and macOS paths compare case-insensitively. */
export function dedupePaths(paths: string[], platform = process.platform): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const resolved = platform === "win32" ? win32.resolve(path) : posix.resolve(path);
    const key = platform === "win32" || platform === "darwin" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(path);
  }
  return result;
}
