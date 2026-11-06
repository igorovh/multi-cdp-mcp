# Renders docs/demo.gif. Run from the repository root: vhs docs/demo.tape
# Uses only local test pages and a temporary data directory (see docs/demo/agents.ts).

Output docs/demo.gif

Set Shell "powershell"
Set FontSize 18
Set Width 1100
Set Height 600
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms
Set Framerate 20

Hide
Type "chcp 65001 > $null; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $env:DEMO_ROOT = (Get-Location).Path" Enter
Type "function prompt { '~/demo/acme-agents $ ' }; function multi-cdp-demo { bun (Join-Path $env:DEMO_ROOT 'docs/demo/agents.ts') }; Clear-Host" Enter
Sleep 1s
Show

Type "multi-cdp-demo"
Sleep 400ms
Enter
Wait+Screen@60s /demo complete/
Sleep 4s
