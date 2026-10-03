import { describe, expect, test } from "bun:test";
import { parseEvaluateResult, wrapWithTimeout } from "./page-tools.ts";
import { exposeDownstreamTools } from "./tools.ts";

// biome-ignore lint: the wrapper is evaluated exactly as the page would.
const compile = (source: string) => (0, eval)(`(${source})`) as (...args: unknown[]) => Promise<unknown>;

describe("evaluate_script timeout wrapper", () => {
  test("passes arguments and results through", async () => {
    const wrapped = compile(wrapWithTimeout("(a, b) => a + b // trailing comment", 1_000));
    expect(await wrapped(2, 3)).toBe(5);
  });

  test("rejects with a visibility hint when the limit is exceeded", async () => {
    const wrapped = compile(wrapWithTimeout("() => new Promise(() => {})", 20));
    await expect(wrapped()).rejects.toThrow(/timed out after 20 ms.*bringToFront/);
  });
});

describe("evaluate_script result parsing", () => {
  test("extracts the fenced JSON payload", () => {
    const result = {
      content: [{ type: "text" as const, text: 'Script ran on page and returned:\n```json\n{"token":"t"}\n```' }],
    };
    expect(parseEvaluateResult<{ token: string }>(result)).toEqual({ token: "t" });
  });

  test("throws the tool error text", () => {
    expect(() =>
      parseEvaluateResult({ content: [{ type: "text", text: "boom" }], isError: true }),
    ).toThrow("boom");
  });
});

describe("downstream tool exposure", () => {
  const click = {
    name: "click",
    description: "Clicks on the provided element. Second sentence with details.",
    inputSchema: {
      type: "object" as const,
      $schema: "http://json-schema.org/draft-07/schema#",
      properties: { pageId: { type: "number" }, uid: { type: "string", description: "The uid. More." } },
      required: ["pageId", "uid"],
    },
  };

  test("click accepts selector or coordinates instead of a required uid", () => {
    const [tool] = exposeDownstreamTools([click]);
    expect(tool!.inputSchema.required).toEqual(["pageId"]);
    expect(Object.keys(tool!.inputSchema.properties!)).toEqual(
      expect.arrayContaining(["selector", "x", "y", "bringToFront", "environmentId", "callerId"]),
    );
  });

  test("compact mode keeps first sentences and drops $schema", () => {
    const [tool] = exposeDownstreamTools([click], { compact: true });
    expect(tool!.description).toBe("Clicks on the provided element.");
    expect(JSON.stringify(tool)).not.toContain("$schema");
  });
});
