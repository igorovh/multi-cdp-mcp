import { describe, expect, test } from "bun:test";
import { buildArgs, type LaunchOptions } from "./launcher.ts";

const base: LaunchOptions = {
  executable: "/usr/bin/chromium",
  userDataDir: "/data/env",
  remoteDebuggingPort: 9400,
  logDir: "/data/logs",
  extensionPaths: [],
};

describe("browser arguments", () => {
  test("blocks sync, and Edge's implicit sign-in, merging user --disable-features", () => {
    const args = buildArgs({
      ...base,
      kind: "edge",
      disableSync: true,
      extraArgs: ["--lang=en-US", "--disable-features=Translate,msImplicitSignin"],
    });
    expect(args).toContain("--disable-sync");
    expect(args).toContain("--lang=en-US");
    expect(args.filter((arg) => arg.startsWith("--disable-features="))).toEqual([
      "--disable-features=msImplicitSignin,Translate",
    ]);
    expect(args.at(-1)).toBe("about:blank");
  });

  test("leaves sync alone when allowed", () => {
    const args = buildArgs({ ...base, kind: "edge", disableSync: false });
    expect(args.some((arg) => arg.includes("sync") || arg.includes("Signin"))).toBe(false);
  });
});
