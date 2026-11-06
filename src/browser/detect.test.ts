import { describe, expect, test } from "bun:test";
import { browserKind, resolveBrowser, type Host } from "./detect.ts";

function host(platform: NodeJS.Platform, installed: string[], env: Host["env"] = {}): Host {
  return {
    platform,
    env,
    home: platform === "win32" ? "C:\\Users\\me" : platform === "darwin" ? "/Users/me" : "/home/me",
    exists: (path) => installed.includes(path),
    which: (command) => (installed.includes(command) ? `/usr/bin/${command}` : null),
  };
}

describe("browser detection", () => {
  test("Windows prefers Brave over Edge and derives its user-data root", () => {
    const brave = "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe";
    const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
    const env = { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" };
    expect(resolveBrowser("auto", host("win32", [edge, brave], env))).toEqual({
      kind: "brave",
      executable: brave,
      userDataDir: "C:\\Users\\me\\AppData\\Local\\BraveSoftware\\Brave-Browser\\User Data",
    });
    expect(resolveBrowser("auto", host("win32", [edge], env)).userDataDir).toBe(
      "C:\\Users\\me\\AppData\\Local\\Microsoft\\Edge\\User Data",
    );
  });

  test("macOS finds apps in ~/Applications too", () => {
    const chrome = "/Users/me/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    expect(resolveBrowser("auto", host("darwin", [chrome]))).toEqual({
      kind: "chrome",
      executable: chrome,
      userDataDir: "/Users/me/Library/Application Support/Google/Chrome",
    });
  });

  test("Linux searches PATH and honours XDG_CONFIG_HOME", () => {
    const detected = resolveBrowser("auto", host("linux", ["chromium-browser"], { XDG_CONFIG_HOME: "/cfg" }));
    expect(detected).toEqual({
      kind: "chromium",
      executable: "/usr/bin/chromium-browser",
      userDataDir: "/cfg/chromium",
    });
  });

  test("an explicit path must exist and is classified", () => {
    const edge = "/opt/microsoft/msedge/microsoft-edge";
    expect(resolveBrowser(edge, host("linux", [edge])).kind).toBe("edge");
    expect(() => resolveBrowser("/nope/chrome", host("linux", []))).toThrow("does not exist");
  });

  test("fails with guidance when nothing is installed", () => {
    expect(() => resolveBrowser("auto", host("linux", []))).toThrow("browser.executable");
  });

  test("classifies common executables", () => {
    expect(browserKind("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")).toBe("chrome");
    expect(browserKind("C:\\Users\\me\\AppData\\Local\\Chromium\\Application\\chrome.exe")).toBe("chromium");
    expect(browserKind("/usr/bin/brave-browser")).toBe("brave");
    expect(browserKind("/opt/custom/browser")).toBe("unknown");
  });
});
