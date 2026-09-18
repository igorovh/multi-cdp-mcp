/**
 * Compares what list_extensions reports over a browser-url connection versus a
 * backend-launched (pipe) connection on the same cloned profile. Decides the
 * transport question in section 6 of PLAN.md with a measurement.
 */
import { join } from "node:path";
import { config } from "./config.ts";
import { launchBrave, stopBrave } from "./lib/brave.ts";
import { Backend, type BackendTarget } from "./lib/backend.ts";
import { errorMessage, log } from "./lib/log.ts";
import { parseExtensions } from "./lib/parse.ts";
import { cloneEnvironment } from "./lib/profile.ts";

const templateDir = join(config.dataRoot, "templates", "default");
const logDir = join(config.dataRoot, "logs");
const artifactRoot = join(process.cwd(), "docs", "feasibility");

async function report(label: string, backend: Backend): Promise<void> {
  const result = await backend.call("list_extensions");
  if (result.isError) {
    log.fail(`${label}: ${result.text.slice(0, 200)}`);
    return;
  }
  const parsed = parseExtensions(result.text);
  log.ok(`${label}: ${parsed.length} extension(s)`);
  for (const extension of parsed) {
    log.info(`  ${extension.enabled ? "enabled " : "disabled"} ${extension.name} (${extension.id})`);
  }
}

async function measure(label: string, dir: string, target: BackendTarget): Promise<void> {
  log.step(label);
  await cloneEnvironment(templateDir, dir);
  const backend = await Backend.start(
    {
      entrypoint: config.backend.entrypoint,
      runtime: config.backend.runtime,
      enableExtensionTools: true,
      logDir,
      environmentId: label,
      filesystemRoot: join(artifactRoot, label),
    },
    target,
  );
  try {
    await Bun.sleep(8_000);
    await report(label, backend);
  } finally {
    await backend.close();
  }
}

const launchedDir = join(config.dataRoot, "envs", "probe-pipe");
await measure("backend-launch", launchedDir, {
  mode: "backend-launch",
  executablePath: config.braveExecutable,
  userDataDir: launchedDir,
});

log.step("browser-url");
const browserUrlDir = join(config.dataRoot, "envs", "probe-url");
await cloneEnvironment(templateDir, browserUrlDir);
const brave = await launchBrave({
  executable: config.braveExecutable,
  userDataDir: browserUrlDir,
  remoteDebuggingPort: 9334,
  logDir,
  devExtensionPath: null,
});
try {
  await Bun.sleep(8_000);
  const backend = await Backend.start(
    {
      entrypoint: config.backend.entrypoint,
      runtime: config.backend.runtime,
      enableExtensionTools: true,
      logDir,
      environmentId: "browser-url",
      filesystemRoot: join(artifactRoot, "browser-url"),
    },
    { mode: "browser-url", browserUrl: `http://127.0.0.1:${brave.port}` },
  );
  try {
    await report("browser-url", backend);
  } finally {
    await backend.close();
  }
} catch (error) {
  log.fail(errorMessage(error));
} finally {
  await stopBrave(brave);
}
