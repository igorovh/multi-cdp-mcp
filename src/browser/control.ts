import type { CdpClient } from "./cdp.ts";

export interface ManagedExtension {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  installType: string;
  type: string;
  mayDisable: boolean;
  mayEnable?: boolean;
  disabledReason?: string;
}

export interface ManagementResult {
  ok: boolean;
  id: string;
  enabled?: boolean;
  error?: string;
  hint?: string;
}

const PROBE_TIMEOUT_MS = 3_000;

/** Adds enable/disable through chrome.management, which the CDP domain lacks. */
export class ExtensionControl {
  private constructor(
    private readonly client: CdpClient,
    private readonly sessionId: string,
    readonly extensionId: string,
  ) {}

  /**
   * Several extensions expose a /background.js worker, so probe for the injected API.
   * A dormant MV3 worker has no target; opening its page once wakes it.
   */
  static async attach(
    client: CdpClient,
    options: { waitMs?: number; expectedId?: string } = {},
  ): Promise<ExtensionControl> {
    const deadline = Date.now() + (options.waitMs ?? 0);
    let workerCount = 0;
    let woken = false;
    do {
      const workers = await client.extensionWorkers();
      workerCount = workers.length;
      const ordered = options.expectedId
        ? [...workers].sort((a, b) => Number(b.url.includes(options.expectedId!)) - Number(a.url.includes(options.expectedId!)))
        : workers;
      for (const worker of ordered) {
        try {
          const sessionId = await client.attach(worker.targetId);
          const context = await client.evaluate<string>(
            sessionId,
            "globalThis.multiCdpMcp?.context",
            { timeoutMs: PROBE_TIMEOUT_MS },
          );
          if (!context) continue;
          const extensionId = worker.url.slice("chrome-extension://".length).split("/")[0]!;
          return new ExtensionControl(client, sessionId, extensionId);
        } catch {
          // Not the control extension, or not attachable.
        }
      }
      if (!woken && options.expectedId) {
        woken = true;
        await ExtensionControl.#wake(client, options.expectedId);
        continue;
      }
      if (Date.now() < deadline) await Bun.sleep(250);
    } while (Date.now() < deadline);

    throw new Error(
      `control extension service worker not found among ${workerCount} extension worker(s)` +
        (options.expectedId ? ` (expected chrome-extension://${options.expectedId})` : ""),
    );
  }

  static async #wake(client: CdpClient, extensionId: string): Promise<void> {
    try {
      const { targetId } = await client.send<{ targetId: string }>("Target.createTarget", {
        url: `chrome-extension://${extensionId}/control.html`,
        background: true,
      });
      await Bun.sleep(500);
      await client.send("Target.closeTarget", { targetId }).catch(() => {});
    } catch {
      // The extension is not loaded; attach reports the failure.
    }
  }

  async list(): Promise<ManagedExtension[]> {
    return await this.client.evaluate<ManagedExtension[]>(
      this.sessionId,
      "globalThis.multiCdpMcp.listExtensions()",
    );
  }

  async setEnabled(id: string, enabled: boolean): Promise<ManagementResult> {
    return await this.client.evaluate<ManagementResult>(
      this.sessionId,
      `globalThis.multiCdpMcp.setEnabled(${JSON.stringify(id)}, ${enabled})`,
    );
  }

  async reload(id: string): Promise<ManagementResult> {
    return await this.client.evaluate<ManagementResult>(
      this.sessionId,
      `globalThis.multiCdpMcp.reload(${JSON.stringify(id)})`,
    );
  }

  async alive(): Promise<boolean> {
    try {
      return Boolean(
        await this.client.evaluate<string>(this.sessionId, "globalThis.multiCdpMcp?.context", {
          timeoutMs: PROBE_TIMEOUT_MS,
        }),
      );
    } catch {
      return false;
    }
  }
}
