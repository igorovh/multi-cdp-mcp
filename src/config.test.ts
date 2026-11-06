import { describe, expect, test } from "bun:test";
import { configPath, defaultDataRoot, parseConfig } from "./config.ts";

describe("config", () => {
  test("data and config paths follow each platform's convention", () => {
    expect(defaultDataRoot("win32", { LOCALAPPDATA: "C:\\L" }, "C:\\me")).toContain("multi-cdp-mcp");
    expect(defaultDataRoot("darwin", {}, "/Users/me")).toBe("/Users/me/Library/Application Support/multi-cdp-mcp");
    expect(defaultDataRoot("linux", {}, "/home/me")).toBe("/home/me/.local/share/multi-cdp-mcp");
    expect(configPath("linux", { XDG_CONFIG_HOME: "/cfg" }, "/home/me")).toBe("/cfg/multi-cdp-mcp/config.json");
    expect(configPath("linux", { MULTI_CDP_MCP_CONFIG: "/x.json" }, "/home/me")).toBe("/x.json");
  });

  test("merges partial overrides over defaults", () => {
    const config = parseConfig({ browser: { executable: "/usr/bin/chromium" }, limits: { maxEnvironments: 2 } });
    expect(config.browser.executable).toBe("/usr/bin/chromium");
    expect(config.browser.headless).toBe(true);
    expect(config.limits.maxEnvironments).toBe(2);
    expect(config.profileSource.mode).toBe("fresh");
  });

  test("rejects the removed braveExecutable key with a migration hint", () => {
    expect(() => parseConfig({ braveExecutable: "C:\\brave.exe" })).toThrow(/braveExecutable.*browser\.executable/);
  });

  test("rejects unknown keys, wrong types and bad enums", () => {
    expect(() => parseConfig({ browser: { headles: true } })).toThrow("unknown key browser.headles");
    expect(() => parseConfig({ limits: { maxEnvironments: "8" } })).toThrow("limits.maxEnvironments must be a number");
    expect(() => parseConfig({ backend: { filesystemRoots: [1] } })).toThrow("array of strings");
    expect(() => parseConfig({ profileSource: { mode: "copy" } })).toThrow("profileSource.mode");
    expect(() => parseConfig({ browser: { portRange: { start: 9500, end: 9400 } } })).toThrow("portRange");
  });
});
