/** stdout is reserved for the MCP transport, so every diagnostic goes to stderr. */

const ICONS = { info: "·", ok: "+", warn: "!", fail: "x" } as const;

type Level = keyof typeof ICONS;

let verbose = process.env.MULTI_CDP_MCP_VERBOSE === "1";

function write(level: Level, message: string): void {
  process.stderr.write(`${ICONS[level]} ${message}\n`);
}

export const log = {
  setVerbose(value: boolean): void {
    verbose = value;
  },
  step: (name: string) => process.stderr.write(`\n=== ${name} ===\n`),
  debug: (message: string) => {
    if (verbose) write("info", message);
  },
  info: (message: string) => write("info", message),
  ok: (message: string) => write("ok", message),
  warn: (message: string) => write("warn", message),
  fail: (message: string) => write("fail", message),
};

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
