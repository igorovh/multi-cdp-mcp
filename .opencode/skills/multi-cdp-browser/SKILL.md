---
name: Multi-CDP Browser
description: Control isolated persistent Brave environments through the multi-cdp MCP. Use this skill whenever the user asks to browse or interact with websites, inspect console/network/performance, take screenshots, test browser extensions, reload/enable/disable extensions, manage browser environments, or run concurrent browser work—even when they do not mention multi-cdp. Prefer this workflow over Playwright or standalone Chrome DevTools whenever multi-cdp tools are available.
compatibility: OpenCode V2 with the multi-cdp MCP server configured
---

# Multi-CDP Browser Workflow

Use the `multi-cdp` MCP tools for browser work. The proxy routes ordinary browser calls to
the environment bound to the invoking OpenCode conversation.

## Cheat sheet (do not search the catalog for these)

Call as `tools["multi-cdp"].<name>(args)` inside `execute`.

| Tool | Args |
| --- | --- |
| `cdp_environment_create` | `{ name?, headless?, fresh?, devExtensionPaths? }` |
| `cdp_environment_list` | `{}` (no identity needed; shows owner and `extensionControl`) |
| `cdp_environment_select` | `{ environmentId }` |
| `cdp_environment_stop` | `{ environmentId? }` |
| `cdp_extension_list` | `{}` (check `controllable` before toggling) |
| `cdp_extension_set_enabled` | `{ extensionId, enabled }` |
| `cdp_extension_reload` | `{ extensionId }` |
| `install_extension` | `{ path }` |
| `list_pages` / `select_page` | `{}` / `{ pageId, bringToFront? }` |
| `new_page` / `navigate_page` | `{ url }` / `{ pageId, url, timeout? }` |
| `take_snapshot` / `take_screenshot` | `{ pageId }` |
| `click` / `hover` | `{ pageId, uid \| selector \| x+y, bringToFront?, dblClick? }` |
| `fill_form` / `press_key` | `{ pageId, elements }` / `{ pageId, key }` |
| `evaluate_script` | `{ pageId, function, timeout?, bringToFront? }` |
| `list_console_messages` / `list_network_requests` | `{ pageId }` |

## Identity

- Calls route by `_meta.sessionID`. OpenCode Code Mode `execute` does not send it yet, so
  pass `callerId: "<current session ID>"` on **every** call, always the same value.
- Without `callerId`, `environmentId` alone addresses that environment directly.
  Creating with `name` and no `callerId` makes later `environmentId` calls consistent.
- `cdp_environment_stop({ environmentId })` stops any idle environment; deleting one owned
  by another identity needs `cdp_environment_select` first. Errors name the owner.

## Background tabs and auto-hiding controls

- Hidden tabs throttle timers and `requestAnimationFrame`. Pass `bringToFront: true` to
  `evaluate_script`, `click` or `hover` for timing-sensitive work, keep in-page waits
  ≤15 s and pass `timeout` (ms) to `evaluate_script` for longer ones.
- Player controls that hide on mouse-out invalidate snapshot `uid`s. Use
  `hover({ pageId, selector })` then `click({ pageId, selector })`; the pointer stays where
  `hover` left it.
- A navigation timeout usually means the load event was slow; the result includes the
  page's URL and `readyState`. Pass `timeout: 45000` for streaming sites.

## Choose visibility before the first browser call

- For routine navigation, screenshots, DOM, console, network, and performance work, let the
  first downstream browser call lazily create the default headless environment.
- For login, extension popups, toolbar actions, visual debugging, or user-assisted work,
  call `cdp_environment_create` first with `headless: false`.
- Use a stable `name` when the user will return to the environment later.
- Pass `fresh: true` only when the task needs a clean browser without template state.
- Pass `devExtensionPaths` when testing a build from a specific project or worktree.

`install_extension` only reads the OS temp directory, `devExtensionPaths` and the
configured `backend.filesystemRoots`; prefer `devExtensionPaths` for worktree builds.

## Reuse and isolation

1. Use the currently bound environment unless the user asks for another one.
2. Check `cdp_environment_list` before creating extra named environments.
3. Use `cdp_environment_select` only for deliberate reuse or handover.
4. Never assume two conversations share tabs, cookies, selected pages, or extension state.
5. When calling page-scoped downstream tools, obtain the current `pageId` from `list_pages`.

## Extension development

1. Build the extension before asking the browser to reload it.
2. Use `cdp_extension_list` to resolve IDs and enabled state.
3. Use `cdp_extension_reload` after changing an existing build.
4. Use `cdp_extension_set_enabled` for deterministic enable/disable tests.
5. Use a visible environment for popup, toolbar, permission-dialog, or user-gesture work.
6. Verify behaviour through observable page effects, console output, or network activity—not
   merely by checking that the extension is listed.

Cloned streaming sites sessions do not remain authenticated. For those sites, create or
select a visible persistent environment and ask the user to sign in once. Stop/resume keeps
the environment's new login and extension state.

## Lifecycle

- `cdp_environment_stop` closes processes but preserves the profile for later resume.
- `cdp_environment_release` gives up the conversation binding without stopping the browser.
- A normal browser call resumes a stopped bound environment automatically.
- Prefer stop over deletion when the environment may be useful again.

## Destructive operations

Delete profiles only when the user explicitly asks to delete them.

- `cdp_environment_delete` permanently removes one profile. Use `force: true` only when the
  user explicitly wants a running environment stopped and deleted.
- `cdp_environment_delete_all` permanently removes every environment. Call it only after an
  explicit delete-all request, pass `confirm: "DELETE ALL ENVIRONMENTS"`, and do not infer
  permission from a general cleanup request.
- Active tool calls and environments still starting must not be forced.

## Reporting

State which environment was created, selected, stopped, handed over, or deleted when that
information matters. Do not expose cookie values, tokens, private page content, raw profile
files, or internal OpenCode session IDs.
