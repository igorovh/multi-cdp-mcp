import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProxyConfig } from "../config.ts";
import { log } from "../logging.ts";

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
  /** Hints for crash recovery only; live process identity is always verified. */
  browserPid?: number;
  browserVersion?: string;
}

interface RegistryFile {
  version: 1;
  environments: EnvironmentRecord[];
}

/** Persists profile identity; no saved process field is trusted as live state. */
export class EnvironmentRegistry {
  #records = new Map<string, EnvironmentRecord>();
  #writing: Promise<void> = Promise.resolve();

  private constructor(private readonly path: string) {}

  static async open(config: ProxyConfig): Promise<EnvironmentRegistry> {
    const path = join(config.dataRoot, "environments.json");
    const registry = new EnvironmentRegistry(path);
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as RegistryFile;
      for (const record of parsed.environments ?? []) {
        // A saved owner refers to a conversation from a previous run; drop the claim.
        registry.#records.set(record.id, {
          ...record,
          ownerSessionId: null,
          profileMode: record.profileMode ?? "template",
          devExtensionPaths: record.devExtensionPaths ?? [],
          headless: record.headless ?? config.browser.headless,
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn(`Ignoring unreadable registry at ${path}: ${(error as Error).message}`);
      }
    }
    return registry;
  }

  all(): EnvironmentRecord[] {
    return [...this.#records.values()];
  }

  async upsert(record: EnvironmentRecord): Promise<void> {
    this.#records.set(record.id, { ...record });
    await this.#flush();
  }

  async remove(id: string): Promise<void> {
    this.#records.delete(id);
    await this.#flush();
  }

  /** Serialised writes through a temporary file, so a crash cannot truncate the registry. */
  #flush(): Promise<void> {
    this.#writing = this.#writing.then(async () => {
      const contents: RegistryFile = { version: 1, environments: this.all() };
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.tmp`;
      await writeFile(temporary, JSON.stringify(contents, null, 2), "utf8");
      await rename(temporary, this.path);
    });
    return this.#writing;
  }
}
