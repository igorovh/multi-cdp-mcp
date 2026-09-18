import { homedir } from "node:os";
import { join } from "node:path";

const LOCALAPPDATA = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");

/**
 * How a new environment profile is seeded.
 *
 * - `clone`: copy an existing Brave user data directory into a reusable template,
 *   then clone that template per environment. Carries over logins and extensions.
 *   The source browser must be closed while it is copied.
 * - `fresh`: start every environment from an empty user data directory.
 *   Nothing is carried over; you log in and install extensions once per environment.
 * - `template`: reuse a template directory that was already prepared earlier,
 *   without touching the source browser again.
 */
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
  /** Unpacked extension build to load alongside the standard ones, or null. */
  devExtensionPath: string | null;
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

  testUrls: [],

  devExtensionPath: null,

  maxTemplateSizeGb: 5,
};
