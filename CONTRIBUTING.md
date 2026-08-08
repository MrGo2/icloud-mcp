# Contributing

Thanks for helping improve icloud-mcp!

## Setup

```bash
git clone https://github.com/MrGo2/icloud-mcp.git
cd icloud-mcp
pnpm install        # pnpm is the supported lockfile (pnpm-lock.yaml)
pnpm test           # 51 tests, no real Apple apps or accounts touched
```

Node >= 20 required. Tests stub `osascript` and the network clients — they never
read your mail, calendar or messages, and they run on any OS.

## Ground rules

- **Every tool argument must be validated.** New tools declare a zod
  `inputSchema`, a `title`, and explicit `annotations` (never rely on the
  spec defaults). `list-*` tools also declare `outputSchema` and return
  `structuredContent`.
- **Nothing raw into AppleScript.** Any value interpolated into a script
  template goes through `asInt`/`asBool`/`escapeAppleScript` — even though
  zod already validated it. Defence in depth is the policy.
- **Both modes or say so.** If a tool can only work in one mode, guard it and
  document it in README + CLAUDE.md.
- **Tests accompany behavior.** A fix for a bug ships with the test that
  would have caught it.

## Pull requests

- Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
- CI must be green (Node 20 + 22 + MCP inspector smoke).
- Keep diffs surgical; unrelated refactors go in their own PR.
