import type { CdpClient } from "./cdp.ts";

export interface ManagedExtension {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  installType: string;
  type: string;
  mayDisable: boolean;
}

export interface ManagementResult {
  ok: boolean;
  id: string;
  enabled?: boolean;
  error?: string;
}

/** Adds enable/disable through chrome.management, which the CDP domain lacks. */
export class ExtensionControl {
  private constructor(
    private readonly client: CdpClient,
    private readonly sessionId: string,
    readonly extensionId: string,
  ) {}

  /** Several extensions expose a /background.js worker, so probe for the injected API. */
  static async attach(
    client: CdpClient,
    options: { waitMs?: number } = {},
  ): Promise<ExtensionControl> {
    const deadline = Date.now() + (options.waitMs ?? 0);
    let workerCount = 0;
    do {
      const workers = await client.extensionWorkers();
      workerCount = workers.length;
      for (const worker of workers) {
        try {
          const sessionId = await client.attach(worker.targetId);
          const context = await client.evaluate<string>(sessionId, "globalThis.multiCdpMcp?.context");
          if (!context) continue;
          const extensionId = worker.url.slice("chrome-extension://".length).split("/")[0]!;
          return new ExtensionControl(client, sessionId, extensionId);
        } catch {
          // Not the control extension, or not attachable.
        }
      }
      if (Date.now() < deadline) await Bun.sleep(250);
    } while (Date.now() < deadline);

    throw new Error(`Control extension not found among ${workerCount} extension service worker(s).`);
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
}
