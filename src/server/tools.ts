import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const stringProperty = (description: string): object => ({ type: "string", description });

export const managementTools: Tool[] = [
  {
    name: "cdp_environment_create",
    description: "Create, start and select a persistent Brave environment for this conversation.",
    inputSchema: {
      type: "object",
      properties: {
        name: stringProperty("Optional stable environment ID. Generated when omitted."),
        fresh: {
          type: "boolean",
          description: "Start from a completely empty profile instead of the configured template.",
        },
        headless: {
          type: "boolean",
          description:
            "Override the configured default for this environment. True runs without a window.",
        },
        devExtensionPaths: {
          type: "array",
          items: { type: "string" },
          description: "Additional unpacked extension build paths for this environment only.",
        },
      },
    },
  },
  {
    name: "cdp_environment_list",
    description: "List persistent browser environments and their lifecycle/ownership state.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "cdp_environment_select",
    description: "Select an existing environment for this conversation, resuming it if stopped.",
    inputSchema: {
      type: "object",
      properties: { environmentId: stringProperty("Environment ID to select.") },
      required: ["environmentId"],
    },
  },
  {
    name: "cdp_environment_stop",
    description: "Stop an environment's browser/backend while preserving its profile.",
    inputSchema: {
      type: "object",
      properties: {
        environmentId: stringProperty("Environment ID. Defaults to this conversation's selection."),
      },
    },
  },
  {
    name: "cdp_environment_release",
    description: "Release this conversation's environment binding without stopping or deleting it.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "cdp_environment_delete",
    description: "Permanently delete one environment and its profile directory.",
    inputSchema: {
      type: "object",
      properties: {
        environmentId: stringProperty("Environment ID to permanently delete."),
        force: {
          type: "boolean",
          description: "Stop a running environment before deleting it. Busy calls are never forced.",
        },
      },
      required: ["environmentId"],
    },
  },
  {
    name: "cdp_environment_delete_all",
    description: "Permanently delete every environment and profile after explicit confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        confirm: {
          type: "string",
          description: "Must be exactly DELETE ALL ENVIRONMENTS.",
        },
        force: {
          type: "boolean",
          description: "Stop running environments first. Busy calls are never forced.",
        },
      },
      required: ["confirm"],
    },
  },
  {
    name: "cdp_extension_list",
    description: "List every extension in the selected environment, including enabled state and ID.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "cdp_extension_set_enabled",
    description: "Enable or disable an extension in the selected environment by ID.",
    inputSchema: {
      type: "object",
      properties: {
        extensionId: stringProperty("Extension ID."),
        enabled: { type: "boolean", description: "True to enable; false to disable." },
      },
      required: ["extensionId", "enabled"],
    },
  },
  {
    name: "cdp_extension_reload",
    description: "Reload any extension by disabling and re-enabling it in place.",
    inputSchema: {
      type: "object",
      properties: { extensionId: stringProperty("Extension ID to reload.") },
      required: ["extensionId"],
    },
  },
];

for (const tool of managementTools) {
  tool.inputSchema.properties ??= {};
  tool.inputSchema.properties.callerId = {
    type: "string",
    description:
      "Explicit caller identity for MCP clients that do not send _meta.sessionID. " +
      "OpenCode callers normally omit this.",
  };
  if (tool.name.startsWith("cdp_extension_")) {
    tool.inputSchema.properties.environmentId = {
      type: "string",
      description: "Explicit environment for clients without OpenCode session metadata.",
    };
  }
}

export function exposeDownstreamTools(tools: Tool[]): Tool[] {
  return tools.map((tool) => ({
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        ...(tool.inputSchema.properties ?? {}),
        environmentId: {
          type: "string",
          description:
            "Optional explicit environment for clients without OpenCode session metadata. " +
            "OpenCode callers should omit this.",
        },
        callerId: {
          type: "string",
          description:
            "Explicit caller identity for clients without OpenCode session metadata. " +
            "Usually unnecessary when environmentId is provided.",
        },
      },
    },
  }));
}

export const MANAGEMENT_TOOL_NAMES = new Set(managementTools.map((tool) => tool.name));
