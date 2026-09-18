/**
 * Measures whether extension enable/disable/reload can be driven from the proxy.
 * The CDP Extensions domain only covers unpacked extensions and has no setEnabled,
 * so this drives chrome.management inside a bundled control extension.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.ts";
import { launchBrave, stopBrave, type BraveProcess } from "./lib/brave.ts";
import { CdpClient, type CdpTarget } from "./lib/cdp.ts";
import { errorMessage, log } from "./lib/log.ts";
import { cloneEnvironment } from "./lib/profile.ts";
import { writeReport, type ReportData, type StepResult } from "./lib/report.ts";

const PORT = 9335;
const CONTROL_NAME = "multi-cdp-mcp control";
const FIXTURE_NAME = "multi-cdp-mcp dev fixture";
const PROBE_URL = "https://example.com/";
const MARKER = "document.documentElement.dataset.multiCdpMcpFixture";

interface ManagedExtension {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  installType: string;
  type: string;
  mayDisable: boolean;
}

const steps: StepResult[] = [];
const notes: string[] = [];

function record(name: string, status: StepResult["status"], detail: string): void {
  steps.push({ name, status, detail, durationMs: 0 });
  if (status === "fail") log.fail(`${name}: ${detail}`);
  else if (status === "warn") log.warn(`${name}: ${detail}`);
  else log.ok(`${name}: ${detail}`);
}

const templateDir = join(config.dataRoot, "templates", "default");
const probeDir = join(config.dataRoot, "envs", "probe-management");
const logDir = join(config.dataRoot, "logs");
const extensionPaths = [config.controlExtensionPath, config.devExtensionPath].filter(
  (path): path is string => path !== null,
);

async function launch(): Promise<BraveProcess> {
  return await launchBrave({
    executable: config.braveExecutable,
    userDataDir: probeDir,
    remoteDebuggingPort: PORT,
    logDir,
    extensionPaths,
  });
}

/**
 * Prefers the control service worker: it is invisible, and an attached debugger keeps
 * it from going dormant. Falls back to the control page when the worker is asleep.
 */
async function attachToControl(
  client: CdpClient,
): Promise<{ sessionId: string; surface: string; extensionId: string }> {
  // Several extensions expose a /background.js worker, so identify ours by probing for
  // the injected API rather than by URL.
  const workers: CdpTarget[] = await client.extensionWorkers();
  for (const candidate of workers) {
    const extensionId = candidate.url.slice("chrome-extension://".length).split("/")[0]!;
    try {
      const sessionId = await client.attach(candidate.targetId);
      const context = await client.evaluate<string>(sessionId, "globalThis.multiCdpMcp?.context");
      if (context) return { sessionId, surface: `service worker (${context})`, extensionId };
    } catch (error) {
      log.warn(`Attach to ${candidate.url} failed: ${errorMessage(error)}`);
    }
  }
  throw new Error(
    `Control extension not found among ${workers.length} extension service worker(s).`,
  );
}

async function listExtensions(client: CdpClient, sessionId: string): Promise<ManagedExtension[]> {
  return await client.evaluate<ManagedExtension[]>(
    sessionId,
    "globalThis.multiCdpMcp.listExtensions()",
  );
}

async function markerOnPage(client: CdpClient): Promise<string | undefined> {
  const { targetId } = await client.send<{ targetId: string }>("Target.createTarget", {
    url: PROBE_URL,
  });
  try {
    await Bun.sleep(4_000);
    const sessionId = await client.attach(targetId);
    return await client.evaluate<string | undefined>(sessionId, MARKER);
  } finally {
    await client.send("Target.closeTarget", { targetId }).catch(() => {});
  }
}

log.step("Clone probe environment");
await cloneEnvironment(templateDir, probeDir);

let brave = await launch();
let client = await CdpClient.connect(brave.webSocketDebuggerUrl);
await Bun.sleep(6_000);

let disabledTargetId = "";

try {
  log.step("Attach to control extension");
  const control = await attachToControl(client);
  record("attach to control", "pass", control.surface);

  log.step("chrome.management.getAll()");
  const all = await listExtensions(client, control.sessionId);
  const webStore = all.filter((item) => item.installType === "normal");
  record(
    "list via chrome.management",
    all.length > 2 ? "pass" : "fail",
    `${all.length} total, ${webStore.length} from the Web Store`,
  );
  for (const item of all) {
    log.info(`  ${item.enabled ? "on " : "off"} ${item.name} (${item.installType})`);
  }

  const fixture = all.find((item) => item.name === FIXTURE_NAME);
  const target = all.find(
    (item) =>
      item.installType === "normal" && item.type === "extension" && item.name !== CONTROL_NAME,
  );

  log.step("Disable the unpacked fixture");
  if (!fixture) {
    record("disable fixture", "skip", "Dev fixture not present.");
  } else {
    const before = await markerOnPage(client);
    const off = await client.evaluate<{ ok: boolean; enabled?: boolean; error?: string }>(
      control.sessionId,
      `globalThis.multiCdpMcp.setEnabled(${JSON.stringify(fixture.id)}, false)`,
    );
    const after = await markerOnPage(client);
    record(
      "disable fixture",
      off.ok && off.enabled === false && before === "loaded" && after === undefined
        ? "pass"
        : "fail",
      `marker before=${before ?? "absent"} after=${after ?? "absent"}; ${off.error ?? "no error"}`,
    );

    const on = await client.evaluate<{ ok: boolean; enabled?: boolean; error?: string }>(
      control.sessionId,
      `globalThis.multiCdpMcp.setEnabled(${JSON.stringify(fixture.id)}, true)`,
    );
    const restored = await markerOnPage(client);
    record(
      "re-enable fixture",
      on.ok && restored === "loaded" ? "pass" : "fail",
      `marker=${restored ?? "absent"}; ${on.error ?? "no error"}`,
    );
  }

  log.step("Disable a Web Store extension");
  if (!target) {
    record("disable web store extension", "skip", "No Web Store extension found.");
  } else {
    disabledTargetId = target.id;
    const workersBefore = (await client.extensionWorkers()).length;
    const off = await client.evaluate<{ ok: boolean; enabled?: boolean; error?: string }>(
      control.sessionId,
      `globalThis.multiCdpMcp.setEnabled(${JSON.stringify(target.id)}, false)`,
    );
    await Bun.sleep(2_000);
    const workersAfter = (await client.extensionWorkers()).length;
    record(
      "disable web store extension",
      off.ok && off.enabled === false ? "pass" : "fail",
      `${target.name}: workers ${workersBefore} -> ${workersAfter}; ${off.error ?? "no error"}`,
    );
  }
} catch (error) {
  record("probe", "fail", errorMessage(error));
} finally {
  client.close();
}

log.step("Stop and resume, then check the disabled state persisted");
await stopBrave(brave);
brave = await launch();
client = await CdpClient.connect(brave.webSocketDebuggerUrl);
await Bun.sleep(6_000);

try {
  const control = await attachToControl(client);
  const all = await listExtensions(client, control.sessionId);
  for (const item of all) {
    log.info(`  ${item.enabled ? "on " : "off"} ${item.name} (${item.id})`);
  }
  const target = all.find((item) => item.id === disabledTargetId);
  if (!disabledTargetId || !target) {
    record(
      "disabled state persists",
      "fail",
      `Disabled ${disabledTargetId || "nothing"}; after restart it is ${target ? "present" : "missing from getAll()"}`,
    );
  } else {
    record(
      "disabled state persists",
      target.enabled === false ? "pass" : "fail",
      `${target.name} enabled=${target.enabled} after restart`,
    );
    await client.evaluate(
      control.sessionId,
      `globalThis.multiCdpMcp.setEnabled(${JSON.stringify(disabledTargetId)}, true)`,
    );
    notes.push(`${target.name} was re-enabled at the end of the probe.`);
  }
} catch (error) {
  record("disabled state persists", "fail", errorMessage(error));
} finally {
  client.close();
  await stopBrave(brave);
}

const report: ReportData = {
  startedAt: new Date().toISOString(),
  versions: { bun: Bun.version, brave: brave.browserVersion },
  connectionMode: "direct CDP + control extension",
  steps,
  extensions: [],
  urls: [],
  notes,
};
const reportPath = join(process.cwd(), "docs", "extension-management-report.md");
await writeReport(reportPath, report);
await writeFile(
  join(process.cwd(), "docs", "feasibility", "extension-management.json"),
  JSON.stringify(steps, null, 2),
  "utf8",
);
log.step("Report");
log.info(reportPath);
