/** Child process for registry.test.ts: opens the shared registry and upserts its own records. */
import type { ProxyConfig } from "../../config.ts";
import { EnvironmentRegistry, type EnvironmentRecord } from "../registry.ts";

const [dataRoot, writer, count] = process.argv.slice(2) as [string, string, string];
const config = { dataRoot, browser: { headless: true } } as ProxyConfig;
const registry = await EnvironmentRegistry.open(config);

for (let index = 0; index < Number(count); index++) {
  const now = new Date().toISOString();
  const record: EnvironmentRecord = {
    id: `${writer}-${index}`,
    profileDir: `${dataRoot}/envs/${writer}-${index}`,
    port: 0,
    ownerSessionId: null,
    createdAt: now,
    lastUsedAt: now,
    seeded: false,
    extensionPaths: [],
    profileMode: "fresh",
    devExtensionPaths: [],
    headless: true,
  };
  await registry.upsert(record);
}
