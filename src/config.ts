import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./logging.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP = "multi-cdp-mcp";

/** Clone a source, start fresh, or reuse an explicitly prepared template. */
export type ProfileSourceMode = "clone" | "fresh" | "template";

export interface ProxyConfig {
  dataRoot: string;
  profileSource: {
    mode: ProfileSourceMode;
    /** `"auto"` uses the detected browser's own user-data root. */
    sourceUserDataDir: string;
    /** Rebuild the template even if one already exists. Only affects future clones. */
    refreshTemplate: boolean;
    maxTemplateSizeGb: number;
  };
  extensions: {
    /** Grants the proxy chrome.management, which CDP does not expose. */
    controlExtensionPath: string;
    /** Unpacked builds under development, loaded into every environment. */
    devExtensionPaths: string[];
    /** Re-declare profile extensions as unpacked so cloned install records survive. */
    materializeProfileExtensions: boolean;
  };
  backend: {
    entrypoint: string;
    /** Command that runs the backend; defaults to the runtime running this proxy. */
    runtime: string;
    enableExtensionTools: boolean;
    /** Extra directories that path-taking tools such as install_extension may read. */
    filesystemRoots: string[];
    /** Shorten downstream tool descriptions to reduce tool-discovery tokens. */
    compactToolSchemas: boolean;
  };
  browser: {
    /** `"auto"` or the path to a Chromium-based browser binary. */
    executable: string;
    headless: boolean;
    /** Keep browser sync and Edge's implicit sign-in to the OS account; off by default. */
    allowSync: boolean;
    extraArgs: string[];
    /** Ports are taken from this inclusive range, one per running environment. */
    portRange: { start: number; end: number };
  };
  limits: {
    maxEnvironments: number;
    startupTimeoutMs: number;
    /** Proxy-to-backend call timeout; stays below Puppeteer's fixed 180 s protocolTimeout. */
    toolTimeoutMs: number;
    /** Default navigate_page timeout when the caller passes none. */
    navigationTimeoutMs: number;
  };
}

type Env = Record<string, string | undefined>;

export function defaultDataRoot(platform = process.platform, env: Env = process.env, home = homedir()): string {
  if (platform === "win32") return win32.join(env.LOCALAPPDATA ?? win32.join(home, "AppData", "Local"), APP);
  if (platform === "darwin") return posix.join(home, "Library", "Application Support", APP);
  return posix.join(env.XDG_DATA_HOME ?? posix.join(home, ".local", "share"), APP);
}

export function configPath(platform = process.platform, env: Env = process.env, home = homedir()): string {
  if (env.MULTI_CDP_MCP_CONFIG) return env.MULTI_CDP_MCP_CONFIG;
  if (platform === "win32") return win32.join(defaultDataRoot(platform, env, home), "config.json");
  if (platform === "darwin") return posix.join(defaultDataRoot(platform, env, home), "config.json");
  return posix.join(env.XDG_CONFIG_HOME ?? posix.join(home, ".config"), APP, "config.json");
}

function backendEntrypoint(): string {
  // Resolved through the module system: bunx and global installs hoist dependencies.
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve("chrome-devtools-mcp/package.json");
  const manifest = require(manifestPath) as { bin: Record<string, string> };
  return join(dirname(manifestPath), manifest.bin["chrome-devtools-mcp"]!);
}

export function defaults(): ProxyConfig {
  return {
    dataRoot: defaultDataRoot(),
    profileSource: {
      mode: "fresh",
      sourceUserDataDir: "auto",
      refreshTemplate: false,
      maxTemplateSizeGb: 5,
    },
    extensions: {
      controlExtensionPath: join(packageRoot, "extensions", "control"),
      devExtensionPaths: [],
      materializeProfileExtensions: true,
    },
    backend: {
      entrypoint: backendEntrypoint(),
      runtime: process.execPath,
      enableExtensionTools: true,
      filesystemRoots: [],
      compactToolSchemas: true,
    },
    browser: {
      executable: "auto",
      headless: true,
      allowSync: false,
      extraArgs: [],
      portRange: { start: 9400, end: 9499 },
    },
    limits: {
      maxEnvironments: 8,
      startupTimeoutMs: 60_000,
      toolTimeoutMs: 150_000,
      navigationTimeoutMs: 30_000,
    },
  };
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

const REMOVED_KEYS: Record<string, string> = {
  braveExecutable: 'was removed; set browser.executable to the browser binary or "auto"',
};

/** Rejects unknown keys and values whose type differs from the default. */
function validate(base: unknown, value: unknown, path: string, errors: string[]): void {
  if (Array.isArray(base)) {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
      errors.push(`${path} must be an array of strings`);
    }
    return;
  }
  if (base && typeof base === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${path} must be an object`);
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      const child = path ? `${path}.${key}` : key;
      if (!(key in base)) {
        errors.push(REMOVED_KEYS[child] ? `${child} ${REMOVED_KEYS[child]}` : `unknown key ${child}`);
        continue;
      }
      validate((base as Record<string, unknown>)[key], entry, child, errors);
    }
    return;
  }
  if (typeof value !== typeof base) errors.push(`${path} must be a ${typeof base}`);
}

function merge<T extends object>(base: T, override: DeepPartial<T>): T {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const current = result[key as keyof T];
    if (
      current &&
      typeof current === "object" &&
      !Array.isArray(current) &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      result[key as keyof T] = merge(current as object, value as object) as T[keyof T];
    } else {
      result[key as keyof T] = value as T[keyof T];
    }
  }
  return result;
}

export function parseConfig(raw: unknown, base = defaults()): ProxyConfig {
  const errors: string[] = [];
  validate(base, raw, "", errors);
  if (errors.length > 0) throw new Error(`Invalid config: ${errors.join("; ")}.`);
  const config = merge(base, raw as DeepPartial<ProxyConfig>);
  if (!["clone", "fresh", "template"].includes(config.profileSource.mode)) {
    throw new Error('Invalid config: profileSource.mode must be "clone", "fresh" or "template".');
  }
  const { start, end } = config.browser.portRange;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1024 || end > 65535 || start > end) {
    throw new Error("Invalid config: browser.portRange must be integers within 1024-65535, start <= end.");
  }
  return config;
}

/** A missing file means defaults; an unreadable or invalid one stops the proxy. */
export async function loadConfig(path = configPath()): Promise<ProxyConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    log.debug(`No config at ${path}; using defaults`);
    return defaults();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Cannot parse ${path}: ${(error as Error).message}`);
  }
  const config = parseConfig(parsed);
  log.info(`Loaded configuration from ${path}`);
  return config;
}

export function templateDir(config: ProxyConfig): string {
  return join(config.dataRoot, "templates", "default");
}

export function environmentsDir(config: ProxyConfig): string {
  return join(config.dataRoot, "envs");
}

export function logsDir(config: ProxyConfig): string {
  return join(config.dataRoot, "logs");
}
