import { describe, expect, test } from "bun:test";
import { missingIdentityMessage, resolveIdentity } from "./identity.ts";

describe("caller identity", () => {
  test("prefers _meta.sessionID over every other source", () => {
    expect(
      resolveIdentity({
        meta: { sessionID: "ses_meta" },
        args: { callerId: "ses_arg", environmentId: "env" },
        transportSessionId: "transport",
      }),
    ).toEqual({ id: "ses_meta", source: "meta" });
  });

  test("falls back to callerId, then transport, then the explicit environment", () => {
    expect(resolveIdentity({ args: { callerId: "ses_a", environmentId: "env" } })).toEqual({
      id: "ses_a",
      source: "callerId",
    });
    expect(resolveIdentity({ args: {}, transportSessionId: "t1" })).toEqual({
      id: "t1",
      source: "transport",
    });
    expect(resolveIdentity({ args: { environmentId: "env" } })).toEqual({
      id: "explicit:env",
      source: "environment",
    });
  });

  test("a created name and a later environmentId map to the same identity", () => {
    const created = resolveIdentity({ args: { name: "audit" }, allowNameIdentity: true });
    const later = resolveIdentity({ args: { environmentId: "audit" } });
    expect(created?.id).toBe(later!.id);
    expect(resolveIdentity({ args: { name: "audit" } })).toBeNull();
  });

  test("the missing-identity error names the parameter and the received metadata", () => {
    const message = missingIdentityMessage({ progressToken: 1 });
    expect(message).toContain("callerId");
    expect(message).toContain("environmentId");
    expect(message).toContain("progressToken");
  });
});
