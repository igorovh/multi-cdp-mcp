/** Proves two cloned Brave profiles can run independently through DevTools MCP. */
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.ts";
import {
  countRunningBrave,
  isEndpointAlive,
  launchBrave,
  stopBrave,
  type BraveProcess,
} from "../../src/browser/brave.ts";
import { Backend, type BackendTarget, type ConnectionMode } from "./lib/backend.ts";
import { CdpClient } from "../../src/browser/cdp.ts";
import { ExtensionControl } from "../../src/browser/control.ts";
import { errorMessage, log } from "./lib/log.ts";
import { parseExtensions, parsePages, urlFromPageLabel } from "./lib/parse.ts";
import { cloneEnvironment, prepareTemplate, prepareUnpackedExtensions } from "../../src/profile/manager.ts";
import {
  writeReport,
  type ExtensionObservation,
  type ReportData,
  type StepResult,
  type StepStatus,
  type UrlObservation,
} from "./lib/report.ts";

const keepBrowsersOpen = !process.argv.includes("--close");

const steps: StepResult[] = [];
const extensionObservations: ExtensionObservation[] = [];
const urlObservations: UrlObservation[] = [];
const notes: string[] = [];
const versions: Record<string, string> = {
  bun: Bun.version,
  node: process.versions.node ?? "n/a",
  "chrome-devtools-mcp": "1.9.0",
};
let connectionMode: ConnectionMode | "not determined" = "not determined";

interface Environment {
  id: string;
  port: number;
  dir: string;
  extensionPaths: string[];
  brave: BraveProcess | null;
  backend: Backend | null;
  cdp: CdpClient | null;
  control: ExtensionControl | null;
}

const environments: Environment[] = [];

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  log.step(name);
  const start = Date.now();
  try {
    const value = await fn();
    steps.push({ name, status: "pass", detail: "", durationMs: Date.now() - start });
    return value;
  } catch (error) {
    const detail = errorMessage(error);
    steps.push({ name, status: "fail", detail, durationMs: Date.now() - start });
    log.fail(detail);
    throw error;
  }
}

function recordStep(name: string, status: StepStatus, detail: string): void {
  steps.push({ name, status, detail, durationMs: 0 });
  if (status === "fail") log.fail(`${name}: ${detail}`);
  else if (status === "warn") log.warn(`${name}: ${detail}`);
  else log.info(`${name}: ${detail}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const bundledExtensions = [config.controlExtensionPath, config.devExtensionPath].filter(
  (path): path is string => path !== null,
);

const dataRoot = config.dataRoot;
const templateDir = join(dataRoot, "templates", "default");
const envsRoot = join(dataRoot, "envs");
const logDir = join(dataRoot, "logs");
const artifactRoot = join(process.cwd(), "docs", "feasibility");

async function preflight(): Promise<void> {
  if (!(await exists(config.braveExecutable))) {
    throw new Error(`Brave executable not found: ${config.braveExecutable}`);
  }
  if (!(await exists(config.backend.entrypoint))) {
    throw new Error(
      `chrome-devtools-mcp entrypoint not found: ${config.backend.entrypoint}. Run \`bun install\`.`,
    );
  }

  const running = await countRunningBrave();
  if (running > 0 && config.profileSource.mode === "clone") {
    throw new Error(
      `${running} brave.exe process(es) are running. A live profile is not a consistent ` +
        `snapshot — close Brave completely and re-run.`,
    );
  }
  if (running > 0) {
    notes.push(`${running} brave.exe process(es) were already running at start.`);
  }

  versions["profile source"] = config.profileSource.mode;

  await mkdir(dataRoot, { recursive: true });
  await mkdir(envsRoot, { recursive: true });
  await mkdir(logDir, { recursive: true });
  await mkdir(artifactRoot, { recursive: true });
  log.ok("Preflight checks passed");
}

async function startBackend(environment: Environment): Promise<void> {
  const baseOptions = {
    entrypoint: config.backend.entrypoint,
    runtime: config.backend.runtime,
    enableExtensionTools: config.backend.enableExtensionTools,
    logDir,
    environmentId: environment.id,
    filesystemRoot: join(artifactRoot, environment.id),
  };

  const attempts: BackendTarget[] = [
    { mode: "browser-url", browserUrl: `http://127.0.0.1:${environment.port}` },
    {
      mode: "backend-launch",
      executablePath: config.braveExecutable,
      userDataDir: environment.dir,
    },
  ];

  let lastError = "";
  for (const target of attempts) {
    // Only fall back to backend-launch after browser-url has actually failed.
    if (target.mode === "backend-launch" && connectionMode === "browser-url") break;
    try {
      const backend = await Backend.start(baseOptions, target);
      const probe = await backend.call("list_pages");
      if (probe.isError) throw new Error(probe.text);
      if (config.backend.enableExtensionTools && !backend.hasTool("list_extensions")) {
        throw new Error("Extension tools were requested but list_extensions is not exposed.");
      }
      environment.backend = backend;
      connectionMode = target.mode;
      return;
    } catch (error) {
      lastError = errorMessage(error);
      log.warn(`Backend attempt "${target.mode}" failed for ${environment.id}: ${lastError}`);
      if (target.mode === "browser-url") {
        notes.push(`browser-url connection failed for ${environment.id}: ${lastError}`);
      }
    }
  }

  throw new Error(`No working backend connection for ${environment.id}. Last error: ${lastError}`);
}

async function selectFirstPage(environment: Environment): Promise<void> {
  const backend = environment.backend!;
  const result = await backend.call("list_pages");
  const pages = parsePages(result.text);
  if (pages.length === 0) {
    const created = await backend.call("new_page", { url: "about:blank" });
    if (created.isError) throw new Error(`new_page failed: ${created.text}`);
    const retry = await backend.call("list_pages");
    const retryPages = parsePages(retry.text);
    if (retryPages.length === 0) throw new Error("No pages available after new_page.");
    backend.selectedPageId = retryPages[0]!.id;
    return;
  }
  backend.selectedPageId = (pages.find((page) => page.selected) ?? pages[0]!).id;
}

/** Records both the unpacked CDP list and complete chrome.management list. */
async function probeExtensions(environment: Environment, label: string): Promise<void> {
  const backend = environment.backend!;

  if (backend.hasTool("list_extensions")) {
    const result = await backend.call("list_extensions");
    if (result.isError) {
      recordStep(`${label} (list_extensions)`, "fail", result.text.slice(0, 200));
    } else {
      const parsed = parseExtensions(result.text);
      recordStep(
        `${label} (list_extensions)`,
        parsed.length > 0 ? "pass" : "warn",
        `${parsed.length} reported`,
      );
    }
  } else {
    recordStep(`${label} (list_extensions)`, "skip", "Tool not exposed by this connection.");
  }

  if (!environment.control) {
    recordStep(`${label} (chrome.management)`, "skip", "Control extension not attached.");
    return;
  }

  try {
    const managed = await environment.control.list();
    for (const extension of managed) {
      extensionObservations.push({
        environmentId: environment.id,
        name: `${extension.name} ${extension.version} [${extension.installType}]`,
        id: extension.id,
        enabled: extension.enabled,
      });
    }
    const enabled = managed.filter((extension) => extension.enabled).length;
    recordStep(
      `${label} (chrome.management)`,
      managed.length > 0 ? "pass" : "fail",
      `${managed.length} installed, ${enabled} enabled`,
    );
  } catch (error) {
    recordStep(`${label} (chrome.management)`, "fail", errorMessage(error));
  }
}

async function attachControl(environment: Environment): Promise<void> {
  if (!environment.brave) throw new Error(`${environment.id} has no running browser.`);
  environment.cdp = await CdpClient.connect(environment.brave.webSocketDebuggerUrl);
  environment.control = await ExtensionControl.attach(environment.cdp);
}

/** Toggling the dev fixture off and on is the end-to-end check for extension control. */
async function probeExtensionToggle(environment: Environment): Promise<void> {
  const label = `toggle dev extension ${environment.id}`;
  const probe = config.devExtensionProbe;
  if (!environment.control || !probe) {
    recordStep(label, "skip", "No control extension or probe configured.");
    return;
  }

  const managed = await environment.control.list();
  const fixture = managed.find((extension) => extension.name === "multi-cdp-mcp dev fixture");
  if (!fixture) {
    recordStep(label, "skip", "Dev fixture not installed.");
    return;
  }

  const off = await environment.control.setEnabled(fixture.id, false);
  const whileDisabled = await readMarker(environment, probe);
  const on = await environment.control.setEnabled(fixture.id, true);
  const whileEnabled = await readMarker(environment, probe);

  const passed =
    off.ok && on.ok && whileDisabled !== probe.expected && whileEnabled === probe.expected;
  recordStep(
    label,
    passed ? "pass" : "fail",
    `disabled=${whileDisabled ?? "absent"} enabled=${whileEnabled ?? "absent"}` +
      `${off.error ? ` off:${off.error}` : ""}${on.error ? ` on:${on.error}` : ""}`,
  );
}

async function readMarker(
  environment: Environment,
  probe: { url: string; expression: string },
): Promise<string | undefined> {
  const backend = environment.backend!;
  const navigation = await backend.call("navigate_page", { type: "url", url: probe.url });
  if (navigation.isError) return undefined;
  const evaluation = await backend.call("evaluate_script", {
    function: `() => String(${probe.expression})`,
  });
  if (evaluation.isError) return undefined;
  return evaluation.text.includes("loaded") ? "loaded" : undefined;
}

/** Proves the unpacked dev extension was loaded and its content script executed. */
async function probeDevExtension(environment: Environment): Promise<void> {
  const probe = config.devExtensionProbe;
  const label = `dev extension ${environment.id}`;
  if (!config.devExtensionPath || !probe) {
    recordStep(label, "skip", "No dev extension configured.");
    return;
  }

  const backend = environment.backend!;
  const navigation = await backend.call("navigate_page", { type: "url", url: probe.url });
  if (navigation.isError) {
    recordStep(label, "fail", navigation.text.slice(0, 200));
    return;
  }

  const evaluation = await backend.call("evaluate_script", {
    function: `() => String(${probe.expression})`,
  });
  if (evaluation.isError) {
    recordStep(label, "fail", evaluation.text.slice(0, 200));
    return;
  }
  const matched = evaluation.text.includes(probe.expected);
  recordStep(
    label,
    matched ? "pass" : "fail",
    matched
      ? `Content script marked the page (${probe.expected})`
      : `Expected "${probe.expected}"; got: ${evaluation.text.slice(0, 120)}`,
  );
}

const SESSION_COOKIE = /auth|session|token|sid|login/i;

/** Names only: enough to see whether a session survived cloning, without logging secrets. */
async function sessionCookieSummary(environment: Environment, url: string): Promise<string> {
  if (!environment.cdp) return "No CDP connection; confirm sign-in manually.";
  try {
    const domain = new URL(url).hostname.split(".").slice(-2).join(".");
    const names = await environment.cdp.cookieNames(domain);
    const sessionLike = names.filter((name) => SESSION_COOKIE.test(name));
    return `${names.length} cookie(s), ${sessionLike.length} session-like: ${sessionLike.slice(0, 4).join(", ") || "none"}`;
  } catch (error) {
    return `Cookie check failed: ${errorMessage(error)}`;
  }
}

async function probeUrls(environment: Environment): Promise<void> {
  const backend = environment.backend!;
  const targets = config.testUrls.length > 0 ? config.testUrls : ["https://example.com/"];
  if (config.testUrls.length === 0) {
    notes.push("config.testUrls is empty; only a placeholder URL was checked.");
  }

  for (const url of targets) {
    const navigation = await backend.call("navigate_page", { type: "url", url });
    if (navigation.isError) {
      urlObservations.push({
        environmentId: environment.id,
        url,
        finalUrl: "-",
        status: "error",
        detail: navigation.text.slice(0, 200),
      });
      continue;
    }
    const pages = parsePages(navigation.text);
    const current = pages.find((page) => page.id === backend.selectedPageId) ?? pages[0];
    urlObservations.push({
      environmentId: environment.id,
      url,
      finalUrl: current ? urlFromPageLabel(current.label) : "unknown",
      status: "loaded",
      detail: await sessionCookieSummary(environment, url),
    });
  }
}

async function probeScreenshot(environment: Environment): Promise<void> {
  const backend = environment.backend!;
  const filePath = join(artifactRoot, environment.id, "page.png");
  const result = await backend.call("take_screenshot", { format: "png", filePath });
  if (result.isError) {
    recordStep(`screenshot ${environment.id}`, "fail", result.text.slice(0, 200));
    return;
  }
  recordStep(`screenshot ${environment.id}`, "pass", filePath);
}

async function main(): Promise<void> {
  await step("preflight", preflight);

  await step("prepare template", async () => {
    await prepareTemplate({
      mode: config.profileSource.mode,
      sourceUserDataDir: config.profileSource.sourceUserDataDir,
      templateDir,
      maxTemplateSizeGb: config.maxTemplateSizeGb,
    });
  });

  await step("clone environments", async () => {
    for (const entry of config.environments) {
      const dir = join(envsRoot, entry.id);
      await cloneEnvironment(templateDir, dir);
      const unpacked = await prepareUnpackedExtensions(dir);
      environments.push({
        id: entry.id,
        port: entry.remoteDebuggingPort,
        dir,
        extensionPaths: [...bundledExtensions, ...unpacked.map((extension) => extension.path)],
        brave: null,
        backend: null,
        cdp: null,
        control: null,
      });
      log.ok(`Cloned ${entry.id} -> ${dir} (${unpacked.length} profile extension(s))`);
    }
  });

  await step("launch browsers", async () => {
    for (const environment of environments) {
      environment.brave = await launchBrave({
        executable: config.braveExecutable,
        userDataDir: environment.dir,
        remoteDebuggingPort: environment.port,
        logDir,
        extensionPaths: environment.extensionPaths,
      });
      versions.brave = environment.brave.browserVersion;
    }
  });

  await step("connect backends", async () => {
    for (const environment of environments) {
      await startBackend(environment);
      await selectFirstPage(environment);
    }
    log.ok(`Connection mode in use: ${connectionMode}`);
  });

  await step("attach control extensions", async () => {
    // Service workers start lazily; give them a moment before looking for ours.
    await Bun.sleep(5_000);
    for (const environment of environments) {
      await attachControl(environment);
    }
  });

  await step("probe environments", async () => {
    for (const environment of environments) {
      await probeExtensions(environment, `extensions ${environment.id}`);
      await probeDevExtension(environment);
      await probeExtensionToggle(environment);
      await probeUrls(environment);
      await probeScreenshot(environment);
    }
  });

  await step("verify isolation", async () => {
    const [first, second] = environments;
    if (!first || !second) throw new Error("Isolation requires two environments.");

    await first.backend!.call("navigate_page", { type: "url", url: "https://example.com/" });
    await second.backend!.call("navigate_page", { type: "url", url: "https://example.org/" });

    const firstPages = parsePages((await first.backend!.call("list_pages")).text);
    const secondPages = parsePages((await second.backend!.call("list_pages")).text);
    const firstUrl = urlFromPageLabel(firstPages[0]?.label ?? "");
    const secondUrl = urlFromPageLabel(secondPages[0]?.label ?? "");

    if (firstUrl === secondUrl) {
      throw new Error(`Both environments report ${firstUrl}; navigation leaked across profiles.`);
    }
    recordStep("isolation: distinct navigation", "pass", `${firstUrl} vs ${secondUrl}`);

    await first.backend!.close();
    first.backend = null;
    first.cdp?.close();
    first.cdp = null;
    first.control = null;
    await stopBrave(first.brave!);
    first.brave = null;

    if (await isEndpointAlive(second.port)) {
      recordStep("isolation: survivor alive", "pass", `port ${second.port} still serving`);
    } else {
      throw new Error(`Stopping ${first.id} also took down ${second.id}.`);
    }

    const survivorPages = await second.backend!.call("list_pages");
    if (survivorPages.isError) {
      throw new Error(
        `Survivor backend broke after the other environment stopped: ${survivorPages.text}`,
      );
    }
  });

  await step("resume stopped environment", async () => {
    const first = environments[0]!;
    first.brave = await launchBrave({
      executable: config.braveExecutable,
      userDataDir: first.dir,
      remoteDebuggingPort: first.port,
      logDir,
      extensionPaths: first.extensionPaths,
    });
    await startBackend(first);
    await selectFirstPage(first);
    await Bun.sleep(5_000);
    await attachControl(first);
    await probeDevExtension(first);
    await probeExtensions(first, `extensions ${first.id} (after resume)`);
  });
}

async function teardown(): Promise<void> {
  for (const environment of environments) {
    if (environment.backend) {
      await environment.backend.close();
      environment.backend = null;
    }
    environment.cdp?.close();
    environment.cdp = null;
  }
  if (keepBrowsersOpen) {
    log.info("Browsers left running for manual inspection. Re-run with --close to shut them down.");
    for (const environment of environments) {
      if (environment.brave) log.info(`  ${environment.id}: pid ${environment.brave.pid}`);
    }
  } else {
    for (const environment of environments) {
      if (environment.brave) await stopBrave(environment.brave);
    }
  }
}

const report: ReportData = {
  startedAt: new Date().toISOString(),
  versions,
  connectionMode,
  steps,
  extensions: extensionObservations,
  urls: urlObservations,
  notes,
};

let exitCode = 0;
try {
  await main();
} catch {
  exitCode = 1;
} finally {
  await teardown();
  report.connectionMode = connectionMode;
  const reportPath = join(process.cwd(), "docs", "feasibility-report.md");
  await writeReport(reportPath, report);
  log.step("Report");
  log.info(reportPath);
  const failed = steps.filter((entry) => entry.status === "fail").length;
  if (failed > 0) log.fail(`${failed} step(s) failed`);
  else log.ok("All steps passed");
}

process.exit(exitCode);
