import { mkdir, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProxyConfig } from "../config.ts";
import { withFileLock, writeFileAtomic } from "../fs/locked-file.ts";
import { log } from "../logging.ts";
import { PRIVATE_DIR } from "../profile/manager.ts";

export interface EnvironmentRecord {
  id: string;
  profileDir: string;
  /** Last port used. Reallocated on every start; never treated as still valid. */
  port: number;
  ownerSessionId: string | null;
  createdAt: string;
  lastUsedAt: string;
  /** Whether the profile directory was already seeded from the template. */
  seeded: boolean;
  extensionPaths: string[];
  profileMode: "template" | "fresh";
  devExtensionPaths: string[];
  /** "Load unpacked" builds inherited from the template; resolved once per environment. */
  templateUnpackedPaths?: string[];
  headless: boolean;
  /** Extensions the caller disabled on purpose; startup repair leaves them disabled. */
  disabledExtensionIds?: string[];
  /** Hints for crash recovery only; live process identity is always verified. */
  browserPid?: number;
  browserVersion?: string;
}

interface RegistryFile {
  version: 1;
  environments: EnvironmentRecord[];
}

type Change = (records: Map<string, EnvironmentRecord>) => void;

/**
 * Persists profile identity; no saved process field is trusted as live state. Several server
 * processes share one file, so every write re-reads it under a lock and applies only its change.
 */
export class EnvironmentRegistry {
  #records = new Map<string, EnvironmentRecord>();
  #writing: Promise<void> = Promise.resolve();

  private constructor(private readonly path: string) {}

  get #lockPath(): string {
    return `${this.path}.lock`;
  }

  static async open(config: ProxyConfig): Promise<EnvironmentRegistry> {
    const path = join(config.dataRoot, "environments.json");
    const registry = new EnvironmentRegistry(path);
    await mkdir(dirname(path), { recursive: true, mode: PRIVATE_DIR });
    const records = await withFileLock(registry.#lockPath, () => registry.#read());
    for (const record of records.values()) {
      // A saved owner refers to a conversation from a previous run; drop the claim.
      registry.#records.set(record.id, {
        ...record,
        ownerSessionId: null,
        profileMode: record.profileMode ?? "template",
        devExtensionPaths: record.devExtensionPaths ?? [],
        headless: record.headless ?? config.browser.headless,
      });
    }
    return registry;
  }

  all(): EnvironmentRecord[] {
    return [...this.#records.values()];
  }

  async upsert(record: EnvironmentRecord): Promise<void> {
    const copy = { ...record };
    this.#records.set(record.id, copy);
    await this.#apply((records) => records.set(copy.id, copy));
  }

  async remove(id: string): Promise<void> {
    this.#records.delete(id);
    await this.#apply((records) => records.delete(id));
  }

  async #read(): Promise<Map<string, EnvironmentRecord>> {
    const records = new Map<string, EnvironmentRecord>();
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return records;
    }
    try {
      for (const record of (JSON.parse(raw) as RegistryFile).environments ?? []) {
        records.set(record.id, record);
      }
    } catch (error) {
      // Keep the unreadable file for inspection instead of silently overwriting it.
      const backup = `${this.path}.corrupt-${Date.now()}`;
      await rename(this.path, backup).catch(() => {});
      log.warn(`Moved unreadable registry to ${backup}: ${(error as Error).message}`);
    }
    return records;
  }

  /** Read, apply one change, write atomically; serialised in-process and locked across processes. */
  #apply(change: Change): Promise<void> {
    const next = this.#writing.catch(() => {}).then(() =>
      withFileLock(this.#lockPath, async () => {
        const records = await this.#read();
        change(records);
        const contents: RegistryFile = { version: 1, environments: [...records.values()] };
        await writeFileAtomic(this.path, JSON.stringify(contents, null, 2));
      }),
    );
    this.#writing = next;
    return next;
  }
}
