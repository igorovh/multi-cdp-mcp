import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./logging.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCALAPPDATA = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");

/** Clone a source, start fresh, or reuse an explicitly prepared template. */
export type ProfileSourceMode = "clone" | "fresh" | "template";

export interface ProxyConfig {
  braveExecutable: string;
  dataRoot: string;
  profileSource: {
    mode: ProfileSourceMode;
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
    runtime: "bun" | "node";
    enableExtensionTools: boolean;
    /** Extra directories that path-taking tools such as install_extension may read. */
    filesystemRoots: string[];
    /** Shorten downstream tool descriptions to reduce tool-discovery tokens. */
    compactToolSchemas: boolean;
  };
  browser: {
    headless: boolean;
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

function defaults(): ProxyConfig {
  const dataRoot = join(LOCALAPPDATA, "multi-cdp-mcp");
  return {
    braveExecutable: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    dataRoot,
    profileSource: {
      mode: "clone",
      sourceUserDataDir: join(LOCALAPPDATA, "BraveSoftware", "Brave-Browser", "User Data"),
      refreshTemplate: false,
      maxTemplateSizeGb: 5,
    },
    extensions: {
      controlExtensionPath: join(packageRoot, "extensions", "control"),
      devExtensionPaths: [],
      materializeProfileExtensions: true,
    },
    backend: {
      entrypoint: join(
        packageRoot,
        "node_modules",
        "chrome-devtools-mcp",
        "build",
        "src",
        "bin",
        "chrome-devtools-mcp.js",
      ),
      runtime: "bun",
      enableExtensionTools: true,
      filesystemRoots: [],
      compactToolSchemas: true,
    },
    browser: {
      headless: true,
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

export function configPath(): string {
  return (
    process.env.MULTI_CDP_MCP_CONFIG ?? join(LOCALAPPDATA, "multi-cdp-mcp", "config.json")
  );
}

export async function loadConfig(): Promise<ProxyConfig> {
  const base = defaults();
  const path = configPath();
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as DeepPartial<ProxyConfig>;
    log.info(`Loaded configuration from ${path}`);
    return merge(base, parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn(`Ignoring unreadable config at ${path}: ${(error as Error).message}`);
    } else {
      log.debug(`No config at ${path}; using defaults`);
    }
    return base;
  }
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
