import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { log } from "../logging.ts";

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
}

export interface BraveProcess {
  pid: number;
  port: number;
  browserVersion: string;
  webSocketDebuggerUrl: string;
}

export async function countRunningBrave(): Promise<number> {
  const proc = Bun.spawn(["tasklist", "/FI", "IMAGENAME eq brave.exe", "/NH"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  return output.split("\n").filter((line) => line.toLowerCase().includes("brave.exe")).length;
}

function buildArgs(options: LaunchOptions): string[] {
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
  args.push(...(options.extraArgs ?? []));
  args.push("about:blank");
  return args;
}

interface VersionInfo {
  Browser?: string;
  webSocketDebuggerUrl?: string;
}

interface WindowsProcess {
  ProcessId?: number;
  ExecutablePath?: string | null;
  CommandLine?: string | null;
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

export async function launchBrave(options: LaunchOptions): Promise<BraveProcess> {
  if (await probeEndpoint(options.remoteDebuggingPort)) {
    throw new Error(
      `Port ${options.remoteDebuggingPort} already serves a CDP endpoint. ` +
        `Another browser is using it; choose a different port in config.ts.`,
    );
  }

  await mkdir(options.logDir, { recursive: true });
  const logPath = join(options.logDir, `brave-${options.remoteDebuggingPort}.log`);
  const logFd = openSync(logPath, "a");

  // detached + unref, otherwise the browser dies with this process and cannot be
  // inspected manually afterwards. Argument array, never a joined shell string:
  // every path here contains spaces.
  const proc = spawn(options.executable, buildArgs(options), {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: false,
  });
  proc.unref();
  const pid = proc.pid;
  if (pid === undefined) throw new Error("Failed to spawn Brave: no pid returned.");

  const timeoutMs = options.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await probeEndpoint(options.remoteDebuggingPort);
    if (info?.webSocketDebuggerUrl) {
      log.ok(
        `Brave up on port ${options.remoteDebuggingPort} (pid ${pid}, ${info.Browser ?? "unknown build"})`,
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
    `Brave did not expose a CDP endpoint on port ${options.remoteDebuggingPort} within ` +
      `${Math.round(timeoutMs / 1000)}s. See ${logPath}.`,
  );
}

export async function portInUse(port: number): Promise<boolean> {
  return (await probeEndpoint(port)) !== null;
}

/** Reconnects only after executable, profile, port and live CDP endpoint all match. */
export async function reconnectBrave(options: {
  executable: string;
  userDataDir: string;
  remoteDebuggingPort: number;
}): Promise<BraveProcess | null> {
  if (process.platform !== "win32" || options.remoteDebuggingPort <= 0) return null;
  const imageName = basename(options.executable).replaceAll("'", "''");
  const script =
    `Get-CimInstance Win32_Process -Filter "Name = '${imageName}'" | ` +
    "Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress";
  const proc = Bun.spawn(["powershell", "-NoProfile", "-Command", script], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0 || output.trim() === "") return null;

  let parsed: WindowsProcess | WindowsProcess[];
  try {
    parsed = JSON.parse(output) as WindowsProcess | WindowsProcess[];
  } catch {
    return null;
  }
  const expectedExe = options.executable.toLowerCase();
  const expectedProfile = options.userDataDir.toLowerCase();
  const expectedPort = `--remote-debugging-port=${options.remoteDebuggingPort}`;
  const match = (Array.isArray(parsed) ? parsed : [parsed]).find((entry) => {
    const executable = entry.ExecutablePath?.toLowerCase();
    const command = entry.CommandLine?.toLowerCase();
    return (
      entry.ProcessId &&
      executable === expectedExe &&
      command?.includes(expectedProfile) &&
      command.includes(expectedPort)
    );
  });
  if (!match?.ProcessId) return null;

  const info = await probeEndpoint(options.remoteDebuggingPort);
  if (!info?.webSocketDebuggerUrl) {
    throw new Error(
      `Found Brave pid ${match.ProcessId} for ${options.userDataDir}, but its saved CDP ` +
        `endpoint on port ${options.remoteDebuggingPort} does not respond.`,
    );
  }
  log.ok(`Reconnected to Brave on port ${options.remoteDebuggingPort} (pid ${match.ProcessId})`);
  return {
    pid: match.ProcessId,
    port: options.remoteDebuggingPort,
    browserVersion: info.Browser ?? "unknown",
    webSocketDebuggerUrl: info.webSocketDebuggerUrl,
  };
}

async function taskkill(pid: number, force: boolean): Promise<void> {
  const args = ["/PID", String(pid), "/T"];
  if (force) args.push("/F");
  const proc = Bun.spawn(["taskkill", ...args], { stdout: "ignore", stderr: "ignore" });
  await proc.exited;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Asks the browser to shut down over CDP. taskkill only closes windows, not the browser process. */
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

/** Closes the browser, preferring a graceful shutdown so the profile is flushed to disk. */
export async function stopBrave(target: BraveProcess): Promise<void> {
  await requestBrowserClose(target.webSocketDebuggerUrl);

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!(await probeEndpoint(target.port)) && !pidAlive(target.pid)) {
      log.ok(`Brave on port ${target.port} stopped`);
      return;
    }
    await Bun.sleep(500);
  }

  log.warn(`Brave pid ${target.pid} did not exit cleanly; forcing.`);
  await taskkill(target.pid, true);
  await Bun.sleep(1_000);
}

export async function isEndpointAlive(port: number): Promise<boolean> {
  return (await probeEndpoint(port)) !== null;
}
