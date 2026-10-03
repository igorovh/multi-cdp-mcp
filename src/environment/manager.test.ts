import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { EnvironmentManager } from "./manager.ts";

const root = join(process.env.TEMP ?? process.env.LOCALAPPDATA!, "multi-cdp-mcp-manager-tests", String(process.pid));

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function managerWith(id: string): Promise<EnvironmentManager> {
  await mkdir(root, { recursive: true });
  const record = {
    id,
    profileDir: join(root, "envs", id),
    port: 0,
    ownerSessionId: null,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    seeded: true,
    extensionPaths: [],
    profileMode: "template",
    devExtensionPaths: [],
    headless: true,
  };
  await writeFile(join(root, "environments.json"), JSON.stringify({ version: 1, environments: [record] }));
  const config = { ...(await loadConfig()), dataRoot: root };
  return await EnvironmentManager.create(config);
}

describe("environment ownership", () => {
  test("stop names the owner and accepts an explicit environmentId", async () => {
    const manager = await managerWith("owned");
    manager.get("owned")!.record.ownerSessionId = "ses_owner";

    await expect(manager.stop("owned", "explicit:owned")).rejects.toThrow(/ses_owner/);
    await manager.stop("owned", "explicit:owned", { explicit: true });
  });

  test("delete by another caller names the owner and the takeover path", async () => {
    const manager = await managerWith("owned2");
    manager.get("owned2")!.record.ownerSessionId = "ses_owner";
    await expect(manager.delete("owned2", "ses_other")).rejects.toThrow(
      /ses_owner.*cdp_environment_select/,
    );
  });

  test("list works without identity and reports extension control state", async () => {
    const manager = await managerWith("listed");
    const [view] = manager.list(null);
    expect(view).toMatchObject({ id: "listed", owner: null, extensionControl: "not-running" });
  });
});
