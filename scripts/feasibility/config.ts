import { homedir } from "node:os";
import { join } from "node:path";

const LOCALAPPDATA = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");

/** Clone a source, start fresh, or reuse an explicitly prepared template. */
export type ProfileSourceMode = "clone" | "fresh" | "template";

export interface FeasibilityConfig {
  braveExecutable: string;
  /** Root for all generated data. Kept outside the repository on purpose. */
  dataRoot: string;
  profileSource: {
    mode: ProfileSourceMode;
    /** Only used by `clone`. The Brave user data root, not a single `Default` folder. */
    sourceUserDataDir: string;
  };
  /** Environments created by the harness. Two are enough to prove isolation. */
  environments: Array<{ id: string; remoteDebuggingPort: number }>;
  backend: {
    /** Resolved entrypoint of the pinned chrome-devtools-mcp install. */
    entrypoint: string;
    /** Runtime used to spawn the backend. Bun first, `node` is the fallback. */
    runtime: "bun" | "node";
    /** Extension tools over a browserUrl connection. The main thing being measured. */
    enableExtensionTools: boolean;
  };
  /** URLs checked for retained authentication. Add your own. */
  testUrls: string[];
  /** Unpacked extension build loaded via --load-extension, or null. */
  devExtensionPath: string | null;
  /** Page the dev extension's content script is expected to modify. */
  devExtensionProbe: { url: string; expression: string; expected: string } | null;
  /** Holds management permission because CDP has no extension enable/disable. */
  controlExtensionPath: string;
  /** Abort the copy if the source exceeds this, to avoid a surprise multi-GB clone. */
  maxTemplateSizeGb: number;
}

export const config: FeasibilityConfig = {
  braveExecutable: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",

  dataRoot: join(LOCALAPPDATA, "multi-cdp-mcp"),

  profileSource: {
    mode: "clone",
    sourceUserDataDir: join(LOCALAPPDATA, "BraveSoftware", "Brave-Browser", "User Data"),
  },

  environments: [
    { id: "test-a", remoteDebuggingPort: 9222 },
    { id: "test-b", remoteDebuggingPort: 9223 },
  ],

  backend: {
    entrypoint: join(
      process.cwd(),
      "node_modules",
      "chrome-devtools-mcp",
      "build",
      "src",
      "bin",
      "chrome-devtools-mcp.js",
    ),
    runtime: "bun",
    enableExtensionTools: true,
  },

  testUrls: ["https://www.twitch.tv/", "https://kick.com/"],

  devExtensionPath: join(import.meta.dir, "fixtures", "dev-extension"),

  controlExtensionPath: join(process.cwd(), "extensions", "control"),

  devExtensionProbe: {
    url: "https://example.com/",
    expression: "document.documentElement.dataset.multiCdpMcpFixture",
    expected: "loaded",
  },

  maxTemplateSizeGb: 5,
};
