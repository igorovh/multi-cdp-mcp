/** Proves materialized profile extensions keep their original IDs across restarts. */
import { join } from "node:path";
import { config } from "./config.ts";
import { launchBrave, stopBrave } from "../../src/browser/brave.ts";
import { CdpClient } from "../../src/browser/cdp.ts";
import { errorMessage, log } from "./lib/log.ts";
import { cloneEnvironment, prepareUnpackedExtensions } from "../../src/profile/manager.ts";

const PORT = 9337;
const probeDir = join(config.dataRoot, "envs", "probe-persistence");
const logDir = join(config.dataRoot, "logs");

interface ManagedExtension {
  id: string;
  name: string;
  enabled: boolean;
  installType: string;
}

log.step("Clone and materialise extensions");
await cloneEnvironment(join(config.dataRoot, "templates", "default"), probeDir);
const unpacked = await prepareUnpackedExtensions(probeDir);
for (const extension of unpacked) {
  log.info(`  ${extension.name} ${extension.version} -> ${extension.id}`);
}

const extensionPaths = [
  config.controlExtensionPath,
  config.devExtensionPath,
  ...unpacked.map((extension) => extension.path),
].filter((path): path is string => path !== null);

async function inspect(round: string): Promise<void> {
  const brave = await launchBrave({
    executable: config.braveExecutable,
    userDataDir: probeDir,
    remoteDebuggingPort: PORT,
    logDir,
    extensionPaths,
  });
  const client = await CdpClient.connect(brave.webSocketDebuggerUrl);
  try {
    await Bun.sleep(8_000);
    const workers = await client.extensionWorkers();
    let managed: ManagedExtension[] = [];
    for (const worker of workers) {
      try {
        const sessionId = await client.attach(worker.targetId);
        const context = await client.evaluate<string>(sessionId, "globalThis.multiCdpMcp?.context");
        if (!context) continue;
        managed = await client.evaluate<ManagedExtension[]>(
          sessionId,
          "globalThis.multiCdpMcp.listExtensions()",
        );
        break;
      } catch {
        // Not the control extension.
      }
    }
    const expected = unpacked.map((extension) => extension.id);
    const present = expected.filter((id) => managed.some((item) => item.id === id));
    log.step(`Round ${round}`);
    log.info(`${workers.length} extension service worker(s) running`);
    log.info(`${managed.length} extension(s) via chrome.management`);
    if (present.length === expected.length) {
      log.ok(`All ${expected.length} original extension ID(s) still present`);
    } else {
      log.fail(`${present.length}/${expected.length} original extension ID(s) present`);
      for (const id of expected.filter((value) => !present.includes(value))) {
        log.fail(`  missing ${id} (${unpacked.find((e) => e.id === id)?.name})`);
      }
    }
  } catch (error) {
    log.fail(errorMessage(error));
  } finally {
    client.close();
    await stopBrave(brave);
  }
}

await inspect("1 (first launch)");
await inspect("2 (after restart)");
await inspect("3 (after second restart)");
