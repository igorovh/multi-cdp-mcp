import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dedupePaths,
  enableDeveloperMode,
  extensionIdFromKey,
  extensionIdFromPath,
  prepareUnpackedExtensions,
  unpackedSourceExtensions,
  validateExtensionDirectory,
} from "./extensions.ts";

const root = join(tmpdir(), "multi-cdp-mcp-ext-tests", String(process.pid));

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function publicKey(): string {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
  return publicKey.export({ type: "spki", format: "der" }).toString("base64");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value), "utf8");
}

describe("extension IDs", () => {
  test("match Chromium for Windows unpacked paths, including drive-letter case", () => {
    const expected = "cmocaegopgkcjbmolheeibcdbhbbgafk";
    expect(extensionIdFromPath(String.raw`E:\Projects\extension\dist`, "win32")).toBe(expected);
    expect(extensionIdFromPath(String.raw`e:\Projects\extension\dist`, "win32")).toBe(expected);
  });

  test("dedupes macOS paths case-insensitively and Linux paths exactly", () => {
    expect(dedupePaths(["/a/B", "/a/b"], "darwin")).toEqual(["/a/B"]);
    expect(dedupePaths(["/a/B", "/a/b"], "linux")).toEqual(["/a/B", "/a/b"]);
  });

  test("dedupes Windows paths case-insensitively", () => {
    expect(dedupePaths([String.raw`E:\a\b`, String.raw`e:\A\b`, String.raw`E:\c`], "win32")).toEqual([
      String.raw`E:\a\b`,
      String.raw`E:\c`,
    ]);
  });
});

describe("profile extension materialisation", () => {
  test("keeps extensions after Chromium drops the copied manifests (stop/restart)", async () => {
    const key = publicKey();
    const id = extensionIdFromKey(key);
    const directory = join(root, "Default", "Extensions", id, "1.0.0_0");
    await writeJson(join(directory, "manifest.json"), { name: "7TV", version: "1.0.0" });
    const preferences = join(root, "Default", "Secure Preferences");
    await writeJson(preferences, {
      extensions: {
        settings: { [id]: { path: join(id, "1.0.0_0"), manifest: { name: "7TV", version: "1.0.0", key } } },
      },
    });

    const first = await prepareUnpackedExtensions(root);
    expect(first.map((extension) => extension.id)).toEqual([id]);
    expect(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")).key).toBe(key);

    // After the first launch Chromium rewrites the record as a command-line extension.
    await writeJson(preferences, {
      extensions: { settings: { [id]: { path: join(id, "1.0.0_0"), location: 8, disable_reasons: [1] } } },
    });
    const second = await prepareUnpackedExtensions(root);
    expect(second.map((extension) => extension.path)).toEqual([directory]);
  });

  test("ignores directories whose manifest key does not reproduce the ID", async () => {
    const directory = join(root, "Default", "Extensions", "a".repeat(32), "1_0");
    await writeJson(join(directory, "manifest.json"), { name: "x", version: "1", key: publicKey() });
    expect(await prepareUnpackedExtensions(root)).toEqual([]);
  });

  test("finds existing 'load unpacked' builds recorded in a source profile", async () => {
    const build = join(root, "build");
    await writeJson(join(build, "manifest.json"), { name: "Example", version: "5.1.0" });
    await writeJson(join(root, "Default", "Secure Preferences"), {
      extensions: {
        settings: {
          bdldghfkmglbmlheppnailfjfklncfkh: { location: 4, path: build },
          mhjfbmdgcfjbbpaeojofohoefgiehjai: { location: 5, path: join(root, "component") },
          missing: { location: 4, path: join(root, "gone") },
        },
      },
    });
    expect(await unpackedSourceExtensions(root)).toEqual([
      { id: "bdldghfkmglbmlheppnailfjfklncfkh", name: "Example", version: "5.1.0", path: build },
    ]);
  });
});

describe("extension directories", () => {
  test("accepts an absolute directory with a manifest", async () => {
    await writeJson(join(root, "ok", "manifest.json"), { name: "ok", version: "1" });
    await validateExtensionDirectory(join(root, "ok"));
  });

  test("rejects relative paths, commas and missing manifests", async () => {
    await expect(validateExtensionDirectory("relative/dir")).rejects.toThrow("absolute");
    await expect(validateExtensionDirectory(join(root, "a,b"))).rejects.toThrow("comma");
    await expect(validateExtensionDirectory(join(root, "missing"))).rejects.toThrow("manifest.json");
  });
});

describe("developer mode", () => {
  test("creates the preference in a fresh profile", async () => {
    await enableDeveloperMode(root);
    const preferences = JSON.parse(await readFile(join(root, "Default", "Preferences"), "utf8"));
    expect(preferences.extensions.ui.developer_mode).toBe(true);
  });

  test("keeps existing preferences", async () => {
    await writeJson(join(root, "Default", "Preferences"), { profile: { name: "x" }, extensions: { ui: { developer_mode: false } } });
    await enableDeveloperMode(root);
    const preferences = JSON.parse(await readFile(join(root, "Default", "Preferences"), "utf8"));
    expect(preferences).toEqual({ profile: { name: "x" }, extensions: { ui: { developer_mode: true } } });
  });
});
