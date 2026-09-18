# Multi-CDP MCP — Implementation Plan

## 1. Goal

Build a local MCP proxy that lets multiple OpenCode conversations control independent Brave browser environments concurrently.

The primary use case is browser extension development: each environment should start with the usual extensions and authenticated websites, and agents should manage their browser sessions without manual tab attachment.

Example:

```text
OpenCode conversation A -> environment A -> DevTools MCP A -> Brave + profile A
OpenCode conversation B -> environment B -> DevTools MCP B -> Brave + profile B
OpenCode conversation C -> environment C -> DevTools MCP C -> Brave + profile C
```

The proxy may be shared by conversations. Browser state and downstream MCP connections must be routed to the correct environment.

## 2. Agreed Direction

- Implement an MCP proxy, rather than an OpenCode-specific plugin, as the core product.
- Start with the official `chrome-devtools-mcp` as the downstream backend.
- Use Brave on Windows as the first target browser and platform.
- Keep official downstream tools instead of reimplementing browser automation.
- Give each environment a separate browser process and persistent user data directory.
- Initialize new profiles from a prepared template containing standard extensions and login state.
- Create environments lazily when browser tools are first used.
- Preserve profiles when stopping browser processes so environments can be resumed.
- Keep environments addressable independently of an OpenCode conversation, allowing deliberate reuse from another conversation.
- Leave room for a separate Playwright backend later. Do not automatically start both backends or attach both to the same browser.

CDP is the browser protocol; Chrome DevTools MCP is the agent-facing tool server. This project proxies MCP calls and manages resources. It does not need to implement a new CDP automation framework.

## 3. Most Important Requirements

### Concurrent operation

- Three active OpenCode conversations can navigate, inspect, and interact concurrently.
- A conversation cannot accidentally switch, inspect, or close another conversation's browser through ordinary routed tools.
- Stopping or crashing one environment does not stop the others.
- Multiple simultaneous first calls for one conversation create exactly one environment.

### Authentication and extensions

- New environments are initialized from a known Brave profile template.
- Required standard extensions are installed, enabled, and actually execute in each environment.
- The extension under development can be loaded from a configured build directory.
- Required websites remain authenticated after cloning where their authentication mechanisms allow it.
- Existing environment profiles retain subsequent logins and extension settings across restarts.

### Agent-driven workflow

- No manual extension-toolbar click or tab adoption is required for normal operation.
- Agents can create, list, select, stop, and resume environments through tools.
- Normal tool calls are automatically routed using the invoking conversation's identity.
- Environment creation returns a stable ID and useful status; a CDP endpoint can be included when that transport is used.
- A CDP URL is a connection endpoint, not a browser preview UI.

## 4. First Task Tomorrow: Validate Brave Profiles Before Building the Proxy

This is the highest-value feasibility test. Do not build the complete routing system before proving the authentication and extension requirements.

1. Record the installed Brave version and select a pinned Chrome DevTools MCP version for the experiment.
2. Prepare a dedicated template profile, optionally initialized from the user's existing Brave data directory while its owning browser is closed.
3. Ensure the template contains the required logins and standard extensions, then close its browser before copying it.
4. Create two independent copies in directories outside this repository.
5. Start both copies concurrently with Brave.
6. Check the specific websites that matter to the user for retained authentication.
7. Check that standard extensions and the development extension work in both browsers.
8. Connect independent DevTools MCP processes and perform navigation, screenshots, and console/network inspection.
9. Stop one environment and confirm the other still works.
10. Restart the stopped environment using the same directory and verify its retained state.

Record outcomes without recording cookies, tokens, or private page contents. Report authentication results per website rather than claiming universal login preservation.

If a required login does not survive cloning, determine whether it survives a one-time login inside a persistent environment. Decide whether that behavior meets the user's needs before proceeding.

## 5. Profile Model

### Template profile

A closed, reusable Brave user data directory containing the desired starting state.

- Copy the appropriate user data root and required browser metadata, not just an arbitrary `Default` subdirectory.
- Never copy a live profile as though it were a consistent snapshot.
- Exclude transient process artifacts from newly created copies where appropriate; never delete locks belonging to a live source profile.
- Keep profile data outside the repository, for example under `%LOCALAPPDATA%\multi-cdp-mcp\`.
- Make template updates explicit. They affect future clones, not existing environments.

### Persistent environment profile

Each environment owns one directory for its lifetime.

- Seed it once, then preserve its changes.
- Stop/resume must not recreate or overwrite the profile.
- Browser data cleanup is separate from stopping processes.
- Do not synchronize cookies or extension state between active environments.
- Use separate development-extension build paths when testing different worktrees or versions.

Authentication cloning is not guaranteed for every website or browser version. Persistent profiles preserve local state, but websites can expire or revoke server-side sessions. Installed extension presence also does not prove that browser launch options allow the extension to run.

## 6. Browser Launch and Connection Decision

Validate these two approaches during the feasibility test:

| Approach | Advantages | What must be verified |
| --- | --- | --- |
| Proxy launches Brave; DevTools MCP connects to its CDP endpoint | Explicit control over profiles, ports, browser lifetime, and launch arguments | Extension-management tools supported over the selected connection; Brave compatibility; correct disconnect behavior |
| DevTools MCP launches Brave with an explicit executable and profile | May retain pipe-based capabilities available when the backend owns browser launch | Launch defaults preserve extensions; browser lifecycle can be managed reliably; profile is never shared accidentally |

Prefer the first approach if it supports the required extension workflow. Do not commit to HTTP/WebSocket attachment before checking extension tools: current DevTools MCP documentation describes transport- and browser-version-dependent restrictions.

Distinguish ordinary extension operation on websites from automating extension actions, popup pages, and background/service-worker debugging. Validate the capabilities actually needed for this project.

Chrome DevTools MCP officially targets Chrome and Chrome for Testing. Brave is a compatibility target to test, not a guaranteed upstream-supported configuration.

## 7. Session Routing

OpenCode V2 documents the invoking conversation ID in:

```text
CallToolRequest.params._meta.sessionID
```

Use that metadata for automatic routing. Do not ask the model to remember to add an ID to every click.

Suggested internal relationships:

```text
conversation ID -> selected environment ID
environment ID  -> profile path + backend connection + browser lifecycle state
```

- Allocate a default environment on the first browser operation for an unbound conversation.
- Keep environment IDs stable and distinct from process IDs and CDP ports.
- Bind a conversation explicitly when it selects a named existing environment.
- Initially allow one controlling conversation per environment. Reuse from another conversation is an explicit handover.
- Reject ambiguous calls without conversation metadata or an explicit environment selector; never silently fall back to a shared global browser.
- For non-OpenCode MCP clients, support an explicit environment ID rather than assuming they send OpenCode metadata.
- Filter ordinary environment listings by ownership/binding where appropriate and return clear conflicts for busy environments.

Multiple MCP transport connections and multiple OpenCode conversations are different concepts. The implementation must isolate conversations even when they share one MCP connection.

## 8. Proposed Management Tools

Use the `cdp_environment_` prefix for management tools. These names describe the intended interface, not an existing implementation:

- `cdp_environment_create`: create a named environment from a configured template and bind it to the caller.
- `cdp_environment_list`: show environments and lifecycle state.
- `cdp_environment_select`: bind the caller to an existing environment, respecting ownership.
- `cdp_environment_stop`: stop that environment's processes while retaining its profile.
- `cdp_environment_release`: release the caller's binding without deleting the profile.

Ordinary browser calls can resume a stopped environment automatically. Profile deletion can be added later as a separate explicit operation.

## 9. Proxy Implementation

Suggested stack: TypeScript, Bun for development/package management, and a Windows-compatible Node runtime path for downstream processes. Use the official MCP SDK rather than writing a JSON-RPC transport from scratch.

Core responsibilities:

- **Profile manager:** seed, retain, and exclusively lease profile directories.
- **Environment manager:** lifecycle state, ownership, bindings, and resource limits.
- **Backend adapter:** start/connect to a pinned `chrome-devtools-mcp`, discover tools, forward calls, and close connections.
- **MCP server:** expose management tools and downstream tool schemas with stable names.
- **Persistent registry:** store environment metadata and reconcile it after proxy restart.

Implementation constraints:

- Preserve downstream results, images, errors, and supported metadata; do not flatten everything into text.
- Use one downstream MCP client connection per environment.
- Keep stdout exclusively for MCP transport; send diagnostics to stderr.
- Use single-flight startup and per-environment coordination, not a global browser-operation lock.
- Do not replay a potentially mutating tool call after a connection failure unless execution is known not to have started.
- Make cancellation and timeouts local to the affected call/environment.
- Do not evict an environment while a tool call is active.
- Validate Windows paths with spaces and use argument arrays instead of shell-built command strings.
- Avoid depending on `npx` shell launching for every environment; resolve the installed, pinned backend entrypoint where practical.
- Tool discovery should not require opening a user browser or allocating a working profile.
- Protect profiles against concurrent ownership across multiple proxy processes, not just within an in-memory map.
- On restart, verify process identity and resource ownership before reconnecting or cleaning up; do not trust a saved PID alone.

## 10. Implementation Phases

### Phase 1 — Feasibility (complete)

Prove cloned profiles, retained authentication, active extensions, and two independent Brave/DevTools environments. Select the launch transport based on observed results.

### Phase 2 — Minimal end-to-end proxy (complete)

Implement one backend, automatic OpenCode conversation routing, lazy environment creation, separate persistent profiles, and correct tool/result forwarding.

### Phase 3 — Lifecycle and reuse (complete)

Add named environments, explicit selection/handover, stop/resume, persistent registry, startup race handling, and crash recovery.

### Phase 4 — Verification and documentation (complete)

Run the three-conversation acceptance test on Windows/Brave. Document installation, template preparation, OpenCode V2 configuration, extension build paths, and troubleshooting. Pin the tested dependency versions.

### Later

- Independent Playwright backend using the same profile/environment infrastructure.
- Optional OpenCode UI/plugin integration.
- More platforms and browsers after the Windows/Brave workflow is proven.

## 11. Acceptance Criteria

- [x] Three concurrent conversation IDs automatically receive different environments.
- [x] Concurrent first calls do not create duplicate browsers for one environment.
- [x] Each environment has its own profile directory and downstream MCP connection.
- [x] Navigation, selected pages, and tool results do not leak across environments.
- [x] Closing or crashing one browser leaves the others usable.
- [ ] Required standard extensions execute on Twitch/Kick (service workers and management pass; visual site behaviour remains a manual check).
- [x] The development extension can be tested alongside them.
- [x] Authentication behavior is verified on Twitch and Kick (template sessions do not survive; one-time per-environment login is required).
- [x] Stop/resume preserves local profile state.
- [x] An environment can be deliberately reused from another conversation.
- [x] Screenshots and structured MCP errors are forwarded correctly.
- [x] Windows executable/profile paths containing spaces work.
- [x] No per-task browser-toolbar click or manual tab attachment is required.

## 12. Research Findings and References

Research baseline: 2026-09-18. Repository documentation and selected source files were inspected; third-party projects were not installed or validated locally.

- [OpenCode V2 MCP context](https://opencode.ai/v2/docs/mcp-servers#context): documents `_meta.sessionID` for session-originated MCP calls.
- [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp): preferred initial downstream backend.
- [DevTools configuration](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/configuration.md): executable/profile options, connection modes, and extension capability restrictions.
- [DevTools tool reference](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md): includes extension install/list/reload/action/uninstall tools, subject to compatibility.
- [zane-programs/playwright-mcp-multi](https://github.com/zane-programs/playwright-mcp-multi): useful reference for one official MCP child process and persistent profile per named environment. Missing template cloning, automatic OpenCode binding, and a DevTools backend. CI is Ubuntu-only.
- [sumyapp/playwright-parallel-mcp](https://github.com/sumyapp/playwright-parallel-mcp): advertises both backends, but inspected default process-launch configuration does not assign distinct profiles or isolated mode. Do not assume its process separation alone solves browser-profile contention.
- [anomalyco/browser-control](https://github.com/anomalyco/browser-control): supports named sessions in an existing browser, but its MCP default uses a process-level current session. It is not the selected profile-cloning/backend-management solution.
- [Playwright Chromium launch defaults](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/chromium/chromiumSwitches.ts): include `--disable-extensions`; relevant if adding a Playwright backend later.

## 13. Current Local State

- Project directory: `E:\Projekty\WebstormProjects\multi-cdp-mcp`.
- This plan is the first project file; implementation has not started.
- Node.js `24.15.0` was detected during setup research.
- Brave executable was found at `C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe`.
- Browser Control `0.7.1` was installed globally with Bun during exploration, and its extension was added to Brave. It is not a dependency of this planned proxy.
- The user manually started `browser-control serve` during troubleshooting. Check whether it is still running before performing unrelated cleanup; do not assume it belongs to this project.

**Starting point tomorrow:** validate two cloned Brave profiles with the actual required websites and extensions, then select the DevTools connection mode and implement the smallest working proxy.
