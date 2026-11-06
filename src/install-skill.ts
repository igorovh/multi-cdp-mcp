import { cp, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL = "multi-cdp-browser";

/** Copies the bundled agent skill into OpenCode's global skills directory. */
export async function installSkill(env: Record<string, string | undefined> = process.env): Promise<string> {
  const source = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".opencode", "skills", SKILL);
  const config = env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  const target = join(config, "opencode", "skills", SKILL);
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, force: true });
  return target;
}
