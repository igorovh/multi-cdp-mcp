import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const stringProperty = (description: string): object => ({ type: "string", description });

const CALLER_ID = {
  type: "string",
  description: "Session ID when _meta.sessionID is absent.",
};
const ENVIRONMENT_ID = {
  type: "string",
  description: "Address this environment directly.",
};

export const managementTools: Tool[] = [
  {
    name: "cdp_environment_create",
    description: "Create, start and bind a persistent Brave environment.",
    inputSchema: {
      type: "object",
      properties: {
        name: stringProperty("Stable environment ID; generated when omitted."),
        fresh: { type: "boolean", description: "Empty profile instead of the template." },
        headless: { type: "boolean", description: "false opens a visible window." },
        devExtensionPaths: {
          type: "array",
          items: { type: "string" },
          description: "Unpacked extension directories loaded only in this environment.",
        },
      },
    },
  },
  {
    name: "cdp_environment_list",
    description: "List environments with state, owner and extension-control availability.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "cdp_environment_select",
    description: "Bind an existing environment (resumes it; takes it over when idle).",
    inputSchema: {
      type: "object",
      properties: { environmentId: stringProperty("Environment ID.") },
      required: ["environmentId"],
    },
  },
  {
    name: "cdp_environment_stop",
    description: "Stop an environment's browser, keeping its profile.",
    inputSchema: {
      type: "object",
      properties: {
        environmentId: stringProperty("Defaults to the bound environment. Explicit IDs may stop any idle environment."),
      },
    },
  },
  {
    name: "cdp_environment_release",
    description: "Unbind the caller's environment without stopping it.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "cdp_environment_delete",
    description: "Permanently delete one environment and its profile.",
    inputSchema: {
      type: "object",
      properties: {
        environmentId: stringProperty("Environment ID."),
        force: { type: "boolean", description: "Stop it first if running." },
      },
      required: ["environmentId"],
    },
  },
  {
    name: "cdp_environment_delete_all",
    description: "Permanently delete every environment and profile.",
    inputSchema: {
      type: "object",
      properties: {
        confirm: { type: "string", description: "Exactly: DELETE ALL ENVIRONMENTS" },
        force: { type: "boolean", description: "Stop running environments first." },
      },
      required: ["confirm"],
    },
  },
  {
    name: "cdp_extension_list",
    description: "List extensions with ID, enabled state, source and whether they are controllable.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "cdp_extension_set_enabled",
    description: "Enable or disable an extension by ID.",
    inputSchema: {
      type: "object",
      properties: {
        extensionId: stringProperty("Extension ID."),
        enabled: { type: "boolean", description: "true enables, false disables." },
      },
      required: ["extensionId", "enabled"],
    },
  },
  {
    name: "cdp_extension_reload",
    description: "Reload an extension by disabling and re-enabling it.",
    inputSchema: {
      type: "object",
      properties: { extensionId: stringProperty("Extension ID.") },
      required: ["extensionId"],
    },
  },
];

for (const tool of managementTools) {
  tool.inputSchema.properties ??= {};
  if (tool.name !== "cdp_environment_list") tool.inputSchema.properties.callerId = CALLER_ID;
  if (tool.name.startsWith("cdp_extension_")) {
    tool.inputSchema.properties.environmentId = ENVIRONMENT_ID;
  }
}

/** Proxy-handled parameters; they are stripped before the call reaches the backend. */
export const PROXY_PAGE_PARAMS: Record<string, Record<string, object>> = {
  evaluate_script: {
    timeout: {
      type: "integer",
      description: "In-page time limit in ms (max 170000). The script is rejected when exceeded.",
    },
    bringToFront: { type: "boolean", description: "Focus the page first; hidden tabs throttle timers." },
  },
  click: {
    selector: { type: "string", description: "CSS selector; alternative to uid." },
    x: { type: "number", description: "Viewport x; use with y instead of uid." },
    y: { type: "number", description: "Viewport y." },
    bringToFront: { type: "boolean", description: "Focus the page first." },
  },
  hover: {
    selector: { type: "string", description: "CSS selector; alternative to uid." },
    x: { type: "number", description: "Viewport x; use with y instead of uid." },
    y: { type: "number", description: "Viewport y." },
    bringToFront: { type: "boolean", description: "Focus the page first." },
  },
};

function firstSentence(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  const match = /^(.+?[.!?])(\s|$)/.exec(trimmed);
  const sentence = match?.[1] ?? trimmed;
  return sentence.length <= max ? sentence : `${sentence.slice(0, max - 1).trimEnd()}…`;
}

function compactSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactSchema);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "$schema" || key === "additionalProperties") continue;
    if (key === "description" && typeof entry === "string") {
      result[key] = firstSentence(entry, 120);
    } else if (key === "properties" && entry && typeof entry === "object") {
      result[key] = Object.fromEntries(
        Object.entries(entry).map(([name, schema]) => [name, compactSchema(schema)]),
      );
    } else {
      result[key] = compactSchema(entry);
    }
  }
  return result;
}

export function exposeDownstreamTools(tools: Tool[], options: { compact?: boolean } = {}): Tool[] {
  return tools.map((tool) => {
    const inputSchema = (options.compact ? compactSchema(tool.inputSchema) : tool.inputSchema) as Tool["inputSchema"];
    const properties: Record<string, object> = {
      ...(inputSchema.properties ?? {}),
      ...(PROXY_PAGE_PARAMS[tool.name] ?? {}),
      environmentId: ENVIRONMENT_ID,
      callerId: CALLER_ID,
    };
    let required = inputSchema.required;
    if (tool.name === "click" || tool.name === "hover") {
      required = required?.filter((name) => name !== "uid");
      properties.uid = {
        type: "string",
        description: "Element uid from take_snapshot; or pass selector or x/y.",
      };
    }
    return {
      ...tool,
      description: options.compact
        ? firstSentence(tool.description ?? "", 200)
        : tool.description,
      inputSchema: { ...inputSchema, properties, ...(required ? { required } : {}) },
    };
  });
}

export const MANAGEMENT_TOOL_NAMES = new Set(managementTools.map((tool) => tool.name));
