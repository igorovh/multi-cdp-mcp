# Renders docs/demo.gif: three OpenCode sessions drive three isolated browsers at once.
# Run from the repository root on Windows with OpenCode 2.2.5+ as `opencode2`: vhs docs/demo.tape
# Everything runs in a throwaway sandbox (docs/demo/sandbox.ts) against a local test site
# (docs/demo/site.ts) with a free model; no real accounts, paths or data appear. If the sandbox
# cannot be created the shell exits, so OpenCode never starts with your real configuration.

Output docs/demo.gif

Set Shell "powershell"
Set FontSize 16
Set Width 1400
Set Height 820
Set Padding 16
Set Theme "Catppuccin Mocha"
Set TypingSpeed 25ms
Set Framerate 12
Set PlaybackSpeed 2.0

Hide
Type "chcp 65001 > $null; $repo = (Get-Location).Path; $root = Join-Path $env:TEMP ('mcdp-demo-' + (Get-Date -Format 'HHmmss'))" Enter
Type "$project = bun docs/demo/sandbox.ts $root; if (-not $project -or -not (Test-Path $project)) { exit 1 }" Enter
Type "$env:MULTI_CDP_MCP_CONFIG = Join-Path $root 'multi-cdp.json'; Start-Process -WindowStyle Hidden bun -ArgumentList (Join-Path $repo 'docs/demo/site.ts')" Enter
Type "$env:USERPROFILE = Join-Path $root 'home'; $env:HOME = $env:USERPROFILE; $env:XDG_CONFIG_HOME = Join-Path $root 'config'" Enter
Type "$env:XDG_DATA_HOME = Join-Path $root 'data'; $env:XDG_STATE_HOME = Join-Path $root 'state'; $env:XDG_CACHE_HOME = Join-Path $root 'cache'" Enter
Type "Set-Location $project -ErrorAction Stop; function prompt { '~/demo/acme-shop $ ' }; function opencode { opencode2 --standalone @args }; Clear-Host" Enter
Sleep 3s
Show

Type "opencode"
Enter
Sleep 8s

Type "Sign in at http://127.0.0.1:4173/crm/login as dana@acme.test / demo123 and tell me the greeting."
Enter
Sleep 2s

Ctrl+X
Type "n"
Sleep 2s
Type "Open http://127.0.0.1:4173/crm/dashboard. Am I signed in to the CRM?"
Enter
Sleep 2s

Ctrl+X
Type "n"
Sleep 2s
Type "Open http://127.0.0.1:4173/shop, add the skates to the cart twice and tell me the total."
Enter
Sleep 50s

Ctrl+X
Type "1"
Sleep 6s
Ctrl+X
Type "2"
Sleep 6s
Ctrl+X
Type "3"
Sleep 4s
