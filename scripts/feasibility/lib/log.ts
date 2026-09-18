const ICONS = { info: "·", ok: "+", warn: "!", fail: "x" } as const;

type Level = keyof typeof ICONS;

function write(level: Level, message: string): void {
  process.stderr.write(`${ICONS[level]} ${message}\n`);
}

export const log = {
  step: (name: string) => process.stderr.write(`\n=== ${name} ===\n`),
  info: (message: string) => write("info", message),
  ok: (message: string) => write("ok", message),
  warn: (message: string) => write("warn", message),
  fail: (message: string) => write("fail", message),
};

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
