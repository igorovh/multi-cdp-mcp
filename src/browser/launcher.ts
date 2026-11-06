import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { log } from "../logging.ts";
import { CdpClient } from "./cdp.ts";

export interface LaunchOptions {
  executable: string;
  userDataDir: string;
  remoteDebuggingPort: number;
  logDir: string;
  /** Unpacked extensions to load. Passed as one comma-separated --load-extension value. */
  extensionPaths: string[];
  headless?: boolean;
  extraArgs?: string[];
  timeoutMs?: number;
  /** Adds --disable-sync, and on Edge blocks implicit sign-in to the OS account. */
  disableSync?: boolean;
  kind?: string;
}

export interface BrowserProcess {
  /** 0 when the browser's PID could not be confirmed; it is then never force-killed. */
  pid: number;
  port: number;
  browserVersion: string;
  webSocketDebuggerUrl: string;
}

export function buildArgs(options: LaunchOptions): string[] {
  const args = [
    `--user-data-dir=${options.userDataDir}`,
    `--remote-debugging-port=${options.remoteDebuggingPort}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "--restore-last-session=false",
  ];
  if (options.extensionPaths.length > 0) {
    args.push(`--load-extension=${options.extensionPaths.join(",")}`);
  }
  if (options.headless) args.push("--headless=new");

  // Chromium honours only the last --disable-features, so user features are merged in.
  const features: string[] = [];
  if (options.disableSync) {
    args.push("--disable-sync");
    if (options.kind === "edge") features.push("msImplicitSignin");
  }
  for (const arg of options.extraArgs ?? []) {
    if (arg.startsWith("--disable-features=")) features.push(...arg.slice(19).split(",").filter(Boolean));
    else args.push(arg);
  }
  if (features.length > 0) args.push(`--disable-features=${[...new Set(features)].join(",")}`);
  args.push("about:blank");
  return args;
}

interface VersionInfo {
  Browser?: string;
  webSocketDebuggerUrl?: string;
}

async function probeEndpoint(port: number): Promise<VersionInfo | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return null;
    return (await response.json()) as VersionInfo;
  } catch {
    return null;
  }
}

export async function launchBrowser(options: LaunchOptions): Promise<BrowserProcess> {
  if (await probeEndpoint(options.remoteDebuggingPort)) {
    throw new Error(
      `Port ${options.remoteDebuggingPort} already serves a CDP endpoint. ` +
        "Another browser is using it; change browser.portRange in config.json.",
    );
  }

  await mkdir(options.logDir, { recursive: true });
  const logPath = join(options.logDir, `browser-${options.remoteDebuggingPort}.log`);
  const logFd = openSync(logPath, "a");

  // detached + unref, otherwise the browser dies with this process and cannot be
  // inspected manually afterwards. Argument array, never a joined shell string.
  const proc = spawn(options.executable, buildArgs(options), {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: false,
  });
  proc.unref();
  const pid = proc.pid;
  if (pid === undefined) throw new Error(`Failed to spawn ${options.executable}: no pid returned.`);

  const timeoutMs = options.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await probeEndpoint(options.remoteDebuggingPort);
    if (info?.webSocketDebuggerUrl) {
      log.ok(
        `Browser up on port ${options.remoteDebuggingPort} (pid ${pid}, ${info.Browser ?? "unknown build"})`,
      );
      return {
        pid,
        port: options.remoteDebuggingPort,
        browserVersion: info.Browser ?? "unknown",
        webSocketDebuggerUrl: info.webSocketDebuggerUrl,
      };
    }
    await Bun.sleep(500);
  }

  throw new Error(
    `The browser did not expose a CDP endpoint on port ${options.remoteDebuggingPort} within ` +
      `${Math.round(timeoutMs / 1000)}s. See ${logPath}.`,
  );
}

export async function portInUse(port: number): Promise<boolean> {
  return (await probeEndpoint(port)) !== null;
}

function samePath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === "win32" || process.platform === "darwin"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/** Reads the profile directory from chrome://version and the PID from SystemInfo. */
async function browserIdentity(
  webSocketDebuggerUrl: string,
): Promise<{ userDataDir: string; pid: number } | null> {
  let client: CdpClient | null = null;
  let targetId: string | null = null;
  try {
    client = await CdpClient.connect(webSocketDebuggerUrl, 5_000);
    ({ targetId } = await client.send<{ targetId: string }>("Target.createTarget", {
      url: "chrome://version",
      background: true,
    }));
    const sessionId = await client.attach(targetId);
    let profilePath: string | null = null;
    for (let attempt = 0; attempt < 20 && !profilePath; attempt++) {
      profilePath = await client
        .evaluate<string | null>(sessionId, "document.getElementById('profile_path')?.textContent ?? null")
        .catch(() => null);
      if (!profilePath) await Bun.sleep(100);
    }
    if (!profilePath) return null;
    const { processInfo } = await client.send<{ processInfo: Array<{ type: string; id: number }> }>(
      "SystemInfo.getProcessInfo",
    );
    return {
      userDataDir: dirname(profilePath.trim()),
      pid: processInfo.find((entry) => entry.type === "browser")?.id ?? 0,
    };
  } catch {
    return null;
  } finally {
    if (client && targetId) await client.send("Target.closeTarget", { targetId }).catch(() => {});
    client?.close();
  }
}

/** Reconnects only when the browser on the recorded port reports the expected profile. */
export async function reconnectBrowser(options: {
  userDataDir: string;
  remoteDebuggingPort: number;
}): Promise<BrowserProcess | null> {
  if (options.remoteDebuggingPort <= 0) return null;
  const info = await probeEndpoint(options.remoteDebuggingPort);
  if (!info?.webSocketDebuggerUrl) return null;
  const identity = await browserIdentity(info.webSocketDebuggerUrl);
  if (!identity || !samePath(identity.userDataDir, options.userDataDir)) return null;

  log.ok(
    `Reconnected to the browser on port ${options.remoteDebuggingPort} (pid ${identity.pid || "unknown"})`,
  );
  return {
    pid: identity.pid,
    port: options.remoteDebuggingPort,
    browserVersion: info.Browser ?? "unknown",
    webSocketDebuggerUrl: info.webSocketDebuggerUrl,
  };
}

async function forceKill(pid: number): Promise<void> {
  if (pid <= 0) return;
  if (process.platform === "win32") {
    const proc = Bun.spawn(["taskkill", "/PID", String(pid), "/T", "/F"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
    return;
  }
  // Launched detached, so the browser leads its own process group.
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

function pidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Asks the browser to shut down over CDP so the profile is flushed to disk. */
async function requestBrowserClose(webSocketDebuggerUrl: string): Promise<void> {
  await new Promise<void>((resolve) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(webSocketDebuggerUrl);
    } catch {
      resolve();
      return;
    }
    const finish = () => {
      try {
        socket.close();
      } catch {
        // Already closing.
      }
      resolve();
    };
    const timer = setTimeout(finish, 5_000);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    });
    socket.addEventListener("message", () => {
      clearTimeout(timer);
      finish();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      finish();
    });
  });
}

/** Closes the browser, preferring a graceful shutdown; force-kills only a confirmed PID. */
export async function stopBrowser(target: BrowserProcess): Promise<void> {
  await requestBrowserClose(target.webSocketDebuggerUrl);

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!(await probeEndpoint(target.port)) && !pidAlive(target.pid)) {
      log.ok(`Browser on port ${target.port} stopped`);
      return;
    }
    await Bun.sleep(500);
  }

  if (target.pid <= 0) {
    log.warn(`Browser on port ${target.port} did not exit and its PID is unknown; leaving it running.`);
    return;
  }
  log.warn(`Browser pid ${target.pid} did not exit cleanly; forcing.`);
  await forceKill(target.pid);
  await Bun.sleep(1_000);
}
