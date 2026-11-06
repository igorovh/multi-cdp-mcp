export type IdentitySource = "meta" | "callerId" | "transport" | "environment" | "name";

export interface CallerIdentity {
  id: string;
  source: IdentitySource;
}

/** `_meta` keys accepted as a conversation ID, most specific first. */
export const META_IDENTITY_KEYS = [
  "ai.opencode/sessionID",
  "sessionID",
  "sessionId",
  "opencode/sessionID",
] as const;

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function environmentIdentity(environmentId: string): string {
  return `explicit:${environmentId}`;
}

/**
 * Precedence: `_meta` session ID, `callerId` argument, transport session, then an
 * identity scoped to the explicit `environmentId` (or the `name` being created).
 */
export function resolveIdentity(input: {
  meta?: Record<string, unknown>;
  args: Record<string, unknown>;
  transportSessionId?: string;
  allowNameIdentity?: boolean;
}): CallerIdentity | null {
  for (const key of META_IDENTITY_KEYS) {
    const value = nonEmpty(input.meta?.[key]);
    if (value) return { id: value, source: "meta" };
  }
  const callerId = nonEmpty(input.args.callerId);
  if (callerId) return { id: callerId, source: "callerId" };
  const transport = nonEmpty(input.transportSessionId);
  if (transport) return { id: transport, source: "transport" };
  const environmentId = nonEmpty(input.args.environmentId);
  if (environmentId) return { id: environmentIdentity(environmentId), source: "environment" };
  const name = input.allowNameIdentity ? nonEmpty(input.args.name) : undefined;
  if (name) return { id: environmentIdentity(name), source: "name" };
  return null;
}

export function missingIdentityMessage(meta: Record<string, unknown> | undefined): string {
  const keys = Object.keys(meta ?? {});
  return (
    "No caller identity: the request carried no _meta.sessionID " +
    `(received _meta keys: ${keys.length > 0 ? keys.join(", ") : "none"}). ` +
    'Pass callerId: "<your conversation/session ID>" on every multi-cdp call, ' +
    'or pass environmentId: "<id>" to address an existing environment directly ' +
    "(cdp_environment_list works without identity)."
  );
}
