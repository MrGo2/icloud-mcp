# Contributing

Thanks for helping improve icloud-mcp!

## Setup

```bash
git clone https://github.com/MrGo2/icloud-mcp.git
cd icloud-mcp
pnpm install        # pnpm is the supported lockfile (pnpm-lock.yaml)
pnpm test           # 51 tests, no real Apple apps or accounts touched
```

Node 20 or newer is required. The tests stub `osascript` and the network
clients, so they never read your mail, calendar or messages, and they run
on any OS.

## Ground rules

Every tool argument is validated. A new tool declares a zod `inputSchema`,
a `title` and explicit `annotations` (never rely on the spec defaults), and
`list-*` tools also declare `outputSchema` and return `structuredContent`.

Nothing goes into AppleScript raw. Any value interpolated into a script
template passes through `asInt`, `asBool` or `escapeAppleScript`, even
though zod already validated it. Defence in depth is the policy here.

If a tool can only work in one mode, guard it and say so in the README and
CLAUDE.md. And a bug fix ships together with the test that would have
caught it.

## Pull requests

- Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`)
- CI must be green (Node 20 + 22, plus the MCP inspector smoke)
- Keep diffs surgical; unrelated refactors go in their own PR
