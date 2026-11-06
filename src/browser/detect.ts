import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export type BrowserKind = "chromium" | "brave" | "edge" | "chrome";

export interface DetectedBrowser {
  kind: BrowserKind | "unknown";
  executable: string;
  /** The browser's own user-data root, the default clone source. Null when unknown. */
  userDataDir: string | null;
}

export interface Host {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
  exists: (path: string) => boolean;
  which: (command: string) => string | null;
}

export const defaultHost: Host = {
  platform: process.platform,
  env: process.env,
  home: homedir(),
  exists: existsSync,
  which: (command) => Bun.which(command),
};

/** Auto-detection order. Google Chrome is last: branded builds ignore --load-extension. */
export const DETECTION_ORDER: BrowserKind[] = ["chromium", "brave", "edge", "chrome"];

interface Layout {
  executables: string[];
  userDataDir: string;
}

function windowsLayout(kind: BrowserKind, host: Host): Layout {
  const local = host.env.LOCALAPPDATA ?? win32.join(host.home, "AppData", "Local");
  const programFiles = [
    host.env.ProgramFiles ?? host.env.PROGRAMFILES ?? "C:\\Program Files",
    host.env["ProgramFiles(x86)"] ?? host.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)",
    local,
  ];
  const install = (...segments: string[]) => programFiles.map((root) => win32.join(root, ...segments));
  switch (kind) {
    case "chromium":
      return {
        executables: [win32.join(local, "Chromium", "Application", "chrome.exe")],
        userDataDir: win32.join(local, "Chromium", "User Data"),
      };
    case "brave":
      return {
        executables: install("BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
        userDataDir: win32.join(local, "BraveSoftware", "Brave-Browser", "User Data"),
      };
    case "edge":
      return {
        executables: install("Microsoft", "Edge", "Application", "msedge.exe"),
        userDataDir: win32.join(local, "Microsoft", "Edge", "User Data"),
      };
    case "chrome":
      return {
        executables: install("Google", "Chrome", "Application", "chrome.exe"),
        userDataDir: win32.join(local, "Google", "Chrome", "User Data"),
      };
  }
}

function macLayout(kind: BrowserKind, host: Host): Layout {
  const support = posix.join(host.home, "Library", "Application Support");
  const app = (name: string, binary = name) =>
    ["/Applications", posix.join(host.home, "Applications")].map((root) =>
      posix.join(root, `${name}.app`, "Contents", "MacOS", binary),
    );
  switch (kind) {
    case "chromium":
      return { executables: app("Chromium"), userDataDir: posix.join(support, "Chromium") };
    case "brave":
      return {
        executables: app("Brave Browser"),
        userDataDir: posix.join(support, "BraveSoftware", "Brave-Browser"),
      };
    case "edge":
      return { executables: app("Microsoft Edge"), userDataDir: posix.join(support, "Microsoft Edge") };
    case "chrome":
      return { executables: app("Google Chrome"), userDataDir: posix.join(support, "Google", "Chrome") };
  }
}

const LINUX_COMMANDS: Record<BrowserKind, string[]> = {
  chromium: ["chromium", "chromium-browser"],
  brave: ["brave-browser", "brave"],
  edge: ["microsoft-edge", "microsoft-edge-stable"],
  chrome: ["google-chrome", "google-chrome-stable"],
};

const LINUX_PROFILE: Record<BrowserKind, string[]> = {
  chromium: ["chromium"],
  brave: ["BraveSoftware", "Brave-Browser"],
  edge: ["microsoft-edge"],
  chrome: ["google-chrome"],
};

function linuxUserDataDir(kind: BrowserKind, host: Host): string {
  const config = host.env.XDG_CONFIG_HOME ?? posix.join(host.home, ".config");
  return posix.join(config, ...LINUX_PROFILE[kind]);
}

/** Classifies an executable path, so a configured path still gets a default clone source. */
export function browserKind(executable: string): BrowserKind | "unknown" {
  const path = executable.toLowerCase().replaceAll("\\", "/");
  if (/brave/.test(path)) return "brave";
  if (/msedge|microsoft[ -]edge/.test(path)) return "edge";
  if (/chromium/.test(path)) return "chromium";
  if (/google[ /-]chrome|\/chrome\/application\//.test(path)) return "chrome";
  return "unknown";
}

export function userDataDirFor(kind: BrowserKind | "unknown", host: Host = defaultHost): string | null {
  if (kind === "unknown") return null;
  if (host.platform === "win32") return windowsLayout(kind, host).userDataDir;
  if (host.platform === "darwin") return macLayout(kind, host).userDataDir;
  return linuxUserDataDir(kind, host);
}

function findExecutable(kind: BrowserKind, host: Host): string | null {
  if (host.platform === "win32") return windowsLayout(kind, host).executables.find(host.exists) ?? null;
  if (host.platform === "darwin") return macLayout(kind, host).executables.find(host.exists) ?? null;
  for (const command of LINUX_COMMANDS[kind]) {
    const path = host.which(command);
    if (path) return path;
  }
  return null;
}

/** Resolves `"auto"` to the first installed browser, or classifies an explicit path. */
export function resolveBrowser(executable: string, host: Host = defaultHost): DetectedBrowser {
  if (executable !== "auto") {
    if (!host.exists(executable)) {
      throw new Error(`browser.executable does not exist: ${executable}`);
    }
    const kind = browserKind(executable);
    return { kind, executable, userDataDir: userDataDirFor(kind, host) };
  }
  for (const kind of DETECTION_ORDER) {
    const found = findExecutable(kind, host);
    if (found) return { kind, executable: found, userDataDir: userDataDirFor(kind, host) };
  }
  throw new Error(
    "No Chromium-based browser found (looked for Chromium, Brave, Edge and Chrome). " +
      'Set browser.executable in config.json to the browser binary, or install one.',
  );
}
