import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { pointerProbeFunction, type PointerTarget } from "../browser/input.ts";
import type { ProxyConfig } from "../config.ts";
import type { EnvironmentManager, Route } from "../environment/manager.ts";

type Args = Record<string, unknown>;

export const MAX_EVALUATE_TIMEOUT_MS = 170_000;
const SLOW_EVALUATE_MS = 3_000;

function resultText(result: CallToolResult): string {
  return result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function appendText(result: CallToolResult, text: string): CallToolResult {
  return { ...result, content: [...result.content, { type: "text", text }] };
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Extracts the JSON payload that evaluate_script prints inside a ```json fence. */
export function parseEvaluateResult<T>(result: CallToolResult): T {
  const text = resultText(result);
  const match = /```json\s*\n([\s\S]*?)\n```/.exec(text);
  if (result.isError || !match) throw new Error(text || "evaluate_script returned no result.");
  return JSON.parse(match[1]!) as T;
}

/** Races the caller's function against an in-page timer so the backend call always ends. */
export function wrapWithTimeout(fn: string, timeoutMs: number): string {
  const body = fn.trim().replace(/;+\s*$/, "");
  return `async (...args) => {
  const fn = (
${body}
);
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const visibility = typeof document === "undefined" ? "n/a" : document.visibilityState;
      reject(new Error("evaluate_script timed out after ${timeoutMs} ms (document.visibilityState=" + visibility + "). Hidden tabs throttle timers and requestAnimationFrame; pass bringToFront: true, or a larger timeout."));
    }, ${timeoutMs});
  });
  try {
    return await Promise.race([Promise.resolve().then(() => fn(...args)), limit]);
  } finally {
    clearTimeout(timer);
  }
}`;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Proxy-side extensions of downstream page tools: timeouts, focus, selector/coordinate input. */
export class PageTools {
  constructor(
    private readonly manager: EnvironmentManager,
    private readonly config: ProxyConfig,
  ) {}

  handles(name: string): boolean {
    return ["evaluate_script", "click", "hover", "navigate_page", "new_page"].includes(name);
  }

  async call(route: Route, name: string, args: Args, signal?: AbortSignal): Promise<CallToolResult> {
    const bringToFront = args.bringToFront === true;
    delete args.bringToFront;
    const pageId = finiteNumber(args.pageId);
    if (bringToFront && pageId !== undefined && (name === "evaluate_script" || args.uid !== undefined)) {
      await this.manager.callBackend(route, "select_page", { pageId, bringToFront: true }, { signal });
    }

    switch (name) {
      case "evaluate_script":
        return await this.#evaluate(route, args, bringToFront, signal);
      case "click":
      case "hover":
        if (typeof args.uid === "string" && args.uid.length > 0) {
          delete args.selector;
          delete args.x;
          delete args.y;
          return await this.manager.callBackend(route, name, args, { signal });
        }
        return await this.#pointer(route, name, args, bringToFront, signal);
      default:
        return await this.#navigate(route, name, args, signal);
    }
  }

  async #evaluate(route: Route, args: Args, focused: boolean, signal?: AbortSignal): Promise<CallToolResult> {
    const requested = finiteNumber(args.timeout);
    delete args.timeout;
    const timeoutMs = Math.min(
      Math.max(1, Math.round(requested ?? this.config.limits.toolTimeoutMs - 20_000)),
      MAX_EVALUATE_TIMEOUT_MS,
    );
    if (typeof args.function === "string") args.function = wrapWithTimeout(args.function, timeoutMs);

    const started = Date.now();
    const result = await this.manager.callBackend(route, "evaluate_script", args, {
      signal,
      timeoutMs: Math.max(this.config.limits.toolTimeoutMs, timeoutMs + 15_000),
    });
    const pageId = finiteNumber(args.pageId);
    if (focused || pageId === undefined || Date.now() - started < SLOW_EVALUATE_MS) return result;

    const visibility = await this.#visibility(route, pageId, signal);
    return visibility === "hidden"
      ? appendText(
          result,
          "Warning: this page is hidden (background tab), so timers and requestAnimationFrame " +
            "are throttled. Pass bringToFront: true for timing-sensitive scripts.",
        )
      : result;
  }

  async #visibility(route: Route, pageId: number, signal?: AbortSignal): Promise<string | null> {
    try {
      const result = await this.manager.callBackend(
        route,
        "evaluate_script",
        { pageId, function: "() => document.visibilityState", waitForStableDom: false },
        { signal, timeoutMs: 10_000 },
      );
      return parseEvaluateResult<string>(result);
    } catch {
      return null;
    }
  }

  async #pointer(
    route: Route,
    name: "click" | "hover",
    args: Args,
    bringToFront: boolean,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    const selector = typeof args.selector === "string" && args.selector ? args.selector : undefined;
    const x = finiteNumber(args.x);
    const y = finiteNumber(args.y);
    if (!selector && (x === undefined || y === undefined)) {
      return errorResult(`${name} needs a uid, a selector, or both x and y.`);
    }
    const pageId = finiteNumber(args.pageId);

    const probe = await this.manager.callBackend(
      route,
      "evaluate_script",
      {
        ...(pageId !== undefined ? { pageId } : {}),
        function: pointerProbeFunction(selector),
        waitForStableDom: false,
      },
      { signal, timeoutMs: 20_000 },
    );
    const target = parseEvaluateResult<PointerTarget>(probe);
    if (target.error) return errorResult(target.error);
    const point = target.point ?? { x: x!, y: y! };

    return await this.manager.withEnvironment(route, async (_environment, running) => {
      const session = await running.input.sessionForToken(target.token);
      if (bringToFront) await running.input.bringToFront(session);
      if (name === "hover") await running.input.move(session, point.x, point.y);
      else await running.input.click(session, point.x, point.y, args.dblClick === true);
      const where = `(${Math.round(point.x)}, ${Math.round(point.y)})${selector ? ` for ${selector}` : ""}`;
      return {
        content: [
          {
            type: "text",
            text:
              name === "hover"
                ? `Moved the mouse to ${where}; it stays there until the next input.`
                : `Clicked at ${where}.`,
          },
        ],
      };
    });
  }

  async #navigate(route: Route, name: string, args: Args, signal?: AbortSignal): Promise<CallToolResult> {
    const requested = finiteNumber(args.timeout);
    const timeoutMs = requested && requested > 0 ? requested : this.config.limits.navigationTimeoutMs;
    args.timeout = timeoutMs;
    const result = await this.manager.callBackend(route, name, args, {
      signal,
      timeoutMs: Math.max(this.config.limits.toolTimeoutMs, timeoutMs + 30_000),
    });
    const text = resultText(result);
    if (!/timeout of \d+ ?ms exceeded|Navigation timeout/i.test(text)) return result;

    const pageId = finiteNumber(args.pageId);
    let state = "";
    try {
      const probe = await this.manager.callBackend(
        route,
        "evaluate_script",
        {
          ...(pageId !== undefined ? { pageId } : {}),
          function: "() => ({ url: location.href, title: document.title, readyState: document.readyState })",
          waitForStableDom: false,
        },
        { signal, timeoutMs: 10_000 },
      );
      state = ` Current page state: ${JSON.stringify(parseEvaluateResult(probe))}.`;
    } catch {
      // The page state is a best-effort addition.
    }
    return appendText(
      { ...result, isError: false },
      `Note: the load event did not fire within ${timeoutMs} ms, but the page is usually ` +
        `usable; check it before retrying.${state} Pass a larger timeout for slow sites.`,
    );
  }
}
