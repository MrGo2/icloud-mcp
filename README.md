<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.svg">
  <img src="assets/banner-light.svg" alt="icloud-mcp — Mail, Calendar, Contacts, Reminders, Notes, Messages and Safari for your AI assistant">
</picture>

<div align="center">

[![CI](https://github.com/MrGo2/icloud-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/MrGo2/icloud-mcp/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/MrGo2/icloud-mcp?style=flat-square&color=8250df)](https://github.com/MrGo2/icloud-mcp/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen?style=flat-square&logo=node.js&logoColor=white)](package.json)
[![MCP](https://img.shields.io/badge/MCP-SDK%20v2-a371f7?style=flat-square)](https://modelcontextprotocol.io)

</div>

**The only MCP server that covers seven Apple services with two interchangeable backends.** Run it in **local mode** and it drives the native macOS apps through AppleScript — no credentials, no network, and it reaches Reminders, Notes, Messages and Safari that the iCloud protocols do not expose. Run it in **cloud mode** and it speaks IMAP/SMTP, CalDAV and CardDAV, so it works from any machine, not just a Mac. Switch between them at runtime with `set-mode`; no restart.

[![Install with NPX in VS Code](https://img.shields.io/badge/VS_Code-NPM-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=icloud&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22mcp-icloud%22%5D%7D)

## Features

- **Seven services, one server** — Email, Calendar, Contacts, Reminders, Notes, Messages, Safari.
- **Dual mode** — AppleScript locally, iCloud protocols remotely, switchable at runtime.
- **41 tools**, each with a typed schema, a human title and behavioural annotations.
- **Structured output** — every `list-*` tool returns machine-readable `structuredContent` alongside the text.
- **No credentials in local mode** — macOS Automation permissions replace passwords entirely.

## Access and security model

- **stdio only.** The server speaks JSON-RPC over stdin/stdout. It opens no ports and listens on no socket.
- **Credentials are never logged.** `ICLOUD_APP_PASSWORD` is read once at startup and passed only to the IMAP/SMTP/CalDAV/CardDAV clients. Diagnostics print a fixed mask, never the value.
- **Credential storage is yours to choose.** A `.env` file next to the module for a manual install, or the `.mcpb` bundle's sensitive field, which the host stores in the macOS Keychain.
- **Every tool argument is validated** against a zod schema before the handler runs. Arguments are also coerced at each AppleScript interpolation site, so a value that is not a number cannot reach a script template.
- **Local mode needs no password at all.** macOS gates access per app through its own Automation permission prompts, which you can revoke at any time.

## Tools

Tools marked **local only** return an error in cloud mode, because the iCloud protocols do not expose those services.

### Authentication

- **about**
  - Returns information about this server, the active mode and whether credentials are configured
  - No input
- **check-auth-status**
  - Verifies credentials are usable for the active mode
  - No input
- **set-mode**
  - Switches between local and cloud without restarting
  - Input: `mode` (string, `local` or `cloud`)

### Email

- **list-emails** — Input: `folder` (string, optional), `count` (number, optional, max 50)
- **read-email** — Input: `uid` (string), `folder` (string, optional)
- **send-email** — Input: `to`, `subject`, `body` (strings); `cc`, `bcc` (strings, optional); `isHtml` (boolean, optional, cloud mode only)
- **search-emails** — Input: `query`, `from`, `subject`, `folder` (strings, optional), `unreadOnly` (boolean, optional), `count` (number, optional)
- **mark-as-read** — Input: `uid` (string), `folder` (string, optional), `isRead` (boolean, optional)
- **list-folders** — No input

### Calendar

- **list-events** — Input: `count` (number, optional, max 50), `daysAhead` (number, optional)
- **create-event** — Input: `summary`, `start`, `end` (strings, ISO 8601); `description`, `location` (optional); `calendarUrl` (cloud) or `calendarName` (local)
- **update-event** — Input: `eventUrl` (string); any of `summary`, `start`, `end`, `description`, `location`. Only the fields you pass change
- **delete-event** — Input: `eventUrl` (string)
- **list-calendars** — No input

### Contacts

- **list-contacts** — Input: `count` (number, optional, max 50)
- **search-contacts** — Input: `query` (string), `count` (number, optional). Matches name, organisation, email and phone; phone matching ignores formatting
- **read-contact** — Input: `contactUrl` (string)
- **create-contact** — Input: `displayName`, `firstName`, `lastName`, `email`, `phone`, `organization`, `title`, `notes` (all optional)
- **delete-contact** — Input: `contactUrl` (string)
- **list-contact-accounts** — No input — **local only**
- **list-contact-groups** — Input: `accountId` (string, optional) — **local only**

### Reminders — local only

- **list-reminder-lists** — No input
- **list-reminders** — Input: `listName` (string, optional), `includeCompleted` (boolean, optional), `count` (number, optional)
- **create-reminder** — Input: `name` (string); `body`, `dueDate`, `listName` (optional); `priority` (number 0-9, optional)
- **update-reminder** — Input: `reminderId` (string); any of `name`, `body`, `dueDate`, `priority`
- **complete-reminder** — Input: `reminderId` (string), `completed` (boolean, optional)
- **delete-reminder** — Input: `reminderId` (string)
- **search-reminders** — Input: `query` (string), `count` (number, optional)

### Notes — local only

- **list-note-folders** — No input
- **list-notes** — Input: `folderName` (string, optional), `count` (number, optional)
- **read-note** — Input: `noteId` (string)
- **create-note** — Input: `title` (string), `body` (string, optional), `folderName` (string, optional)
- **search-notes** — Input: `query` (string), `count` (number, optional)

### Messages — local only

Reading requires the [`imsg`](https://github.com/steipete/imsg) CLI and Full Disk Access.

- **list-chats** — Input: `limit` (number, optional)
- **read-messages** — Input: `chatId` (number); `limit` (number, optional); `start`, `end` (ISO 8601, optional); `attachments` (boolean, optional)
- **send-message** — Input: `to` (string), `body` (string), `file` (string, optional)
- **react-message** — Input: `chatId` (number), `type` (`love`, `like`, `dislike`, `laugh`, `emphasis`, `question`)

### Safari — local only

- **list-safari-tabs** — No input
- **get-current-safari-url** — No input
- **open-safari-url** — Input: `url` (string), `inNewWindow` (boolean, optional)
- **close-safari-tab** — Input: `windowIndex` (number, optional), `tabIndex` (number, optional)

### Tool annotations (MCP hints)

Every tool declares its behaviour explicitly rather than relying on defaults, which are deliberately pessimistic in the spec:

- `readOnlyHint: true` — all `list-*`, `read-*`, `search-*` and `get-*` tools, plus `about` and `check-auth-status`.
- `destructiveHint: true` — `delete-event`, `delete-contact`, `delete-reminder`, `close-safari-tab`.
- `openWorldHint: true` — tools that reach the network or another person: all Email and Calendar tools, `send-message`, `react-message`, `open-safari-url`.
- `idempotentHint: true` — the read-only tools plus `mark-as-read`, `complete-reminder`, `update-reminder`, `update-event`, `set-mode`.

## Installation

Requires Node.js 20 or newer.

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "icloud": {
      "command": "npx",
      "args": ["-y", "mcp-icloud"]
    }
  }
}
```

For cloud mode, add credentials:

```json
{
  "mcpServers": {
    "icloud": {
      "command": "npx",
      "args": ["-y", "mcp-icloud"],
      "env": {
        "USE_LOCAL_MODE": "false",
        "ICLOUD_EMAIL": "you@icloud.com",
        "ICLOUD_APP_PASSWORD": "xxxx-xxxx-xxxx-xxxx"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add --transport stdio icloud -- npx -y mcp-icloud
```

### VS Code

Use the badge at the top of this README, or add the same `command`/`args` pair to your MCP settings.

### Desktop extension (.mcpb)

Download the `.mcpb` from [Releases](https://github.com/MrGo2/icloud-mcp/releases) and open it to sideload. The bundle prompts for the mode and, for cloud mode, stores the app-specific password in the macOS Keychain rather than a file.

## Permissions and troubleshooting

### macOS Automation prompts (local mode)

The first time a tool touches an app, macOS asks whether the calling program may control it — once per app, not once per tool. Approve the prompt, or grant it later under **System Settings → Privacy & Security → Automation**.

If you dismissed a prompt, calls to that app fail with an authorisation error (`osascript` error `-1743`, "not authorized to send Apple events"). macOS will not ask again on its own. Re-enable the checkbox under Automation, or reset the decisions:

```bash
tccutil reset AppleEvents
```

That clears Automation permissions for every app, so expect the prompts to return on next use.

### Full Disk Access (reading messages)

`list-chats` and `read-messages` read the Messages database through the `imsg` CLI, which is gated by **Full Disk Access**, not Automation. Grant it to the program that launches the server (Claude Desktop, your terminal, or your editor) under **System Settings → Privacy & Security → Full Disk Access**. Without it, those tools report that Full Disk Access is required.

If `imsg` is installed somewhere unusual, point at it explicitly:

```bash
export ICLOUD_MCP_IMSG_PATH=/opt/homebrew/bin/imsg
```

The server otherwise looks in `ICLOUD_MCP_IMSG_PATH`, `IMSG_PATH`, both Homebrew prefixes, and finally `PATH`.

### Known limitation: large mailboxes

Mail.app tools iterate messages through AppleScript, which is slow on very large mailboxes and can exceed the Apple Event timeout before returning. Narrow the request with `folder` and a smaller `count`, or use cloud mode, where IMAP does the filtering server-side. This is a property of the AppleScript bridge, not something the server can work around.

### App-specific password (cloud mode)

Cloud mode needs an app-specific password — your normal Apple ID password will not work, and neither will it work if two-factor authentication is off.

1. Sign in at [appleid.apple.com](https://appleid.apple.com).
2. Go to **Sign-In and Security → App-Specific Passwords**.
3. Generate one and name it, for example, "iCloud MCP".
4. Put it in `ICLOUD_APP_PASSWORD`, together with `ICLOUD_EMAIL`.

Revoke it from the same page if it is ever exposed.

### Checking what the server thinks

Call `about` for the active mode and service list, and `check-auth-status` to confirm credentials are usable in the current mode.

## Requirements

- **Node.js 20+**
- **Local mode**: macOS, with the relevant apps installed. `imsg` and Full Disk Access for reading messages.
- **Cloud mode**: any OS. An iCloud account with two-factor authentication and an app-specific password. Covers Email, Calendar and Contacts only.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `USE_LOCAL_MODE` | `true` | `false` selects cloud mode |
| `ICLOUD_EMAIL` | — | iCloud address, cloud mode only |
| `ICLOUD_APP_PASSWORD` | — | App-specific password, cloud mode only |
| `ICLOUD_MCP_IMSG_PATH` | — | Explicit path to the `imsg` binary |

Read from the environment, or from a `.env` file beside the module. See `.env.example`.

## Development

`pnpm` is the supported package manager; `pnpm-lock.yaml` is the committed lockfile.

```bash
pnpm install
pnpm test          # unit + contract suites, and a live stdio session
pnpm run inspect   # drive the server with the MCP Inspector
```

The test suites stub `osascript` and the `imsg` CLI, so they touch no real mail, calendar or message data and run on any OS.

## License

MIT — see [LICENSE](LICENSE).
