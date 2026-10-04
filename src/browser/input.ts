import type { CdpClient } from "./cdp.ts";

export const PAGE_TOKEN_GLOBAL = "__multiCdpMcpPageToken";

export interface PointerTarget {
  token: string;
  point: { x: number; y: number } | null;
  error?: string;
}

/** In-page function for evaluate_script: tags the page and resolves a selector to a viewport point. */
export function pointerProbeFunction(selector?: string): string {
  return `() => {
  const token = (globalThis.${PAGE_TOKEN_GLOBAL} ??= Math.random().toString(36).slice(2) + Date.now().toString(36));
  const selector = ${JSON.stringify(selector ?? null)};
  if (selector === null) return { token, point: null };
  const element = document.querySelector(selector);
  if (!element) return { token, point: null, error: "No element matches selector " + JSON.stringify(selector) + "." };
  element.scrollIntoView({ block: "center", inline: "center" });
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return { token, point: null, error: "Element matching " + JSON.stringify(selector) + " has no size; it may be hidden." };
  return { token, point: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } };
}`;
}

/** Real CDP mouse input; the pointer stays where it was moved until the next input event. */
export class PageInput {
  #sessions = new Map<string, string>();

  constructor(private readonly cdp: CdpClient) {}

  async sessionForToken(token: string): Promise<string> {
    const targets = (await this.cdp.getTargets()).filter((target) => target.type === "page");
    for (const target of targets) {
      let sessionId = this.#sessions.get(target.targetId);
      try {
        sessionId ??= await this.cdp.attach(target.targetId);
        this.#sessions.set(target.targetId, sessionId);
        const value = await this.cdp.evaluate<string | undefined>(
          sessionId,
          `globalThis.${PAGE_TOKEN_GLOBAL}`,
          { userGesture: false, timeoutMs: 3_000 },
        );
        if (value === token) return sessionId;
      } catch {
        this.#sessions.delete(target.targetId);
      }
    }
    throw new Error("Could not map the page to a CDP target; call list_pages and retry.");
  }

  async bringToFront(sessionId: string): Promise<void> {
    await this.cdp.send("Page.bringToFront", {}, sessionId);
  }

  async move(sessionId: string, x: number, y: number): Promise<void> {
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, sessionId);
  }

  async click(sessionId: string, x: number, y: number, double = false): Promise<void> {
    await this.move(sessionId, x, y);
    for (const clickCount of double ? [1, 2] : [1]) {
      for (const type of ["mousePressed", "mouseReleased"]) {
        await this.cdp.send(
          "Input.dispatchMouseEvent",
          { type, x, y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount },
          sessionId,
        );
      }
    }
  }
}
