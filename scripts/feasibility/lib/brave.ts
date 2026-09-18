import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { log } from "./log.ts";

export interface LaunchOptions {
  executable: string;
  userDataDir: string;
  remoteDebuggingPort: number;
  logDir: string;
  devExtensionPath: string | null;
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
  if (options.devExtensionPath) {
    args.push(`--load-extension=${options.devExtensionPath}`);
  }
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

export async function launchBrave(options: LaunchOptions): Promise<BraveProcess> {
  if (await probeEndpoint(options.remoteDebuggingPort)) {
    throw new Error(
      `Port ${options.remoteDebuggingPort} already serves a CDP endpoint. ` +
        `Another browser is using it; choose a different port in config.ts.`,
    );
  }

  await mkdir(options.logDir, { recursive: true });
  const logPath = join(options.logDir, `brave-${options.remoteDebuggingPort}.log`);
  const logFile = await open(logPath, "a");

  // Argument array, never a joined shell string: every path here contains spaces.
  const proc = Bun.spawn([options.executable, ...buildArgs(options)], {
    stdout: logFile.fd,
    stderr: logFile.fd,
    stdin: "ignore",
  });
  proc.unref();

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const info = await probeEndpoint(options.remoteDebuggingPort);
    if (info?.webSocketDebuggerUrl) {
      log.ok(
        `Brave up on port ${options.remoteDebuggingPort} (pid ${proc.pid}, ${info.Browser ?? "unknown build"})`,
      );
      return {
        pid: proc.pid,
        port: options.remoteDebuggingPort,
        browserVersion: info.Browser ?? "unknown",
        webSocketDebuggerUrl: info.webSocketDebuggerUrl,
      };
    }
    await Bun.sleep(500);
  }

  throw new Error(
    `Brave did not expose a CDP endpoint on port ${options.remoteDebuggingPort} within 30s. ` +
      `See ${logPath}.`,
  );
}

async function taskkill(pid: number, force: boolean): Promise<void> {
  const args = ["/PID", String(pid), "/T"];
  if (force) args.push("/F");
  const proc = Bun.spawn(["taskkill", ...args], { stdout: "ignore", stderr: "ignore" });
  await proc.exited;
}

/** Closes the browser tree, preferring a graceful close so the profile is flushed. */
export async function stopBrave(target: BraveProcess): Promise<void> {
  await taskkill(target.pid, false);

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!(await probeEndpoint(target.port))) {
      log.ok(`Brave on port ${target.port} stopped`);
      return;
    }
    await Bun.sleep(500);
  }

  log.warn(`Brave on port ${target.port} ignored the close request; forcing.`);
  await taskkill(target.pid, true);
  await Bun.sleep(1_000);
}

export async function isEndpointAlive(port: number): Promise<boolean> {
  return (await probeEndpoint(port)) !== null;
}
