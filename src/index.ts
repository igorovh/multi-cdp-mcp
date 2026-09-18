#!/usr/bin/env bun
import { loadConfig } from "./config.ts";
import { errorMessage, log } from "./logging.ts";
import { ProxyServer } from "./server/server.ts";

let proxy: ProxyServer | null = null;
let closing = false;

async function close(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  log.info(`Received ${signal}; stopping environments`);
  await proxy?.close();
  process.exit(0);
}

process.on("SIGINT", () => void close("SIGINT"));
process.on("SIGTERM", () => void close("SIGTERM"));

try {
  const config = await loadConfig();
  proxy = await ProxyServer.create(config);
  await proxy.start();
} catch (error) {
  log.fail(errorMessage(error));
  process.exit(1);
}
