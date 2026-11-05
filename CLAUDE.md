# iCloud MCP Server

This MCP server provides Claude with access to Apple services via two modes:

## Modes

| Mode | Description | Services | Requirements |
|------|-------------|----------|--------------|
| **LOCAL** (default) | AppleScript access to macOS apps | 7 services, 41 tools | macOS |
| **CLOUD** | iCloud protocols (IMAP, CalDAV, CardDAV) | 3 services, 41 tools* | App-specific password |

\* In CLOUD mode, local-only tools (Reminders, Notes, Messages, Safari) return an error when called.

### Runtime Mode Switching

Use `set-mode` to switch between modes **without restarting**:
- `set-mode local` → AppleScript access to all macOS apps
- `set-mode cloud` → iCloud protocols (requires credentials)

## Services Available

### Local Mode (macOS only)

| Service | Protocol | Tools |
|---------|----------|-------|
| **Email** | Mail.app (AppleScript) | 6 |
| **Calendar** | EventKit (`list-events`) + Calendar.app (AppleScript) | 5 |
| **Contacts** | Contacts.app (AppleScript) | 7 |
| **Reminders** | Reminders.app (AppleScript) | 7 |
| **Notes** | Notes.app (AppleScript) | 5 |
| **Messages** | Messages.app + `imsg` CLI | 4 |
| **Safari** | Safari.app (AppleScript) | 4 |

All seven services now honour the mode. Email and Calendar route through
`local-client.js` in LOCAL mode and IMAP/SMTP/CalDAV in CLOUD mode.

**Field differences between modes** (normalized where possible):

| Field | LOCAL | CLOUD |
|---|---|---|
| Email handle (`uid` arg) | Mail.app message ID | IMAP UID |
| Event/calendar handle | Calendar.app UID / calendar name | CalDAV URL |
| Email unread flag | `read` boolean | `\Seen` in `flags` |
| Event end time | available | available |
| `send-email` message ID | not returned by Mail.app | returned by SMTP |
| `create-event` target | `calendarName` | `calendarUrl` |

Handlers normalize these to a common shape (`ref`, `unread`, `start`/`end`),
so a tool returns the same field names in both modes. The two genuinely
unavailable values are the SMTP message ID and `isHtml` (Mail.app sends plain
text), which are simply omitted in LOCAL mode.

> **`update-event` in CLOUD mode is experimental.** The CalDAV update path is
> new. Its property-merge preserves RRULE, ATTENDEE and VALARM (unit-tested),
> but the live round-trip against iCloud has not been verified — test on a
> disposable calendar first. LOCAL mode uses Calendar.app and is unaffected.

### Cloud Mode

| Service | Protocol | Endpoint |
|---------|----------|----------|
| **Email** | IMAP/SMTP | imap.mail.me.com / smtp.mail.me.com |
| **Calendar** | CalDAV | caldav.icloud.com |
| **Contacts** | CardDAV | contacts.icloud.com |

## Development Commands

```bash
npm install          # Install dependencies
npm start            # Start server (local mode by default)
npm run inspect      # Test with MCP Inspector

# Cloud mode
USE_LOCAL_MODE=false npm start
```

## Configuration

```env
# .env file
USE_LOCAL_MODE=true    # true=AppleScript (fast), false=iCloud protocols

# Only needed for cloud mode:
ICLOUD_EMAIL=your-email@icloud.com
ICLOUD_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
```

## Architecture

```
icloud-mcp/
├── index.js              # MCP server (@modelcontextprotocol/server v2)
├── mode.js               # Runtime mode state management
├── config.js             # Configuration
├── auth/                 # Credential management + set-mode
├── email/                # Email module
│   ├── imap-client.js    # Cloud: IMAP
│   ├── smtp-client.js    # Cloud: SMTP
│   ├── local-client.js   # Local: Mail.app
│   └── index.js          # Tool definitions
├── calendar/             # Calendar module
│   ├── caldav-client.js  # Cloud: CalDAV
│   ├── local-client.js   # Local: Calendar.app
│   └── index.js
├── contacts/             # Contacts module
│   ├── carddav-client.js # Cloud: CardDAV
│   ├── local-client.js   # Local: Contacts.app
│   └── index.js
├── reminders/            # Reminders (local only)
│   ├── local-client.js
│   └── index.js
├── notes/                # Notes (local only)
│   ├── local-client.js
│   └── index.js
├── messages/             # Messages (local only)
│   ├── local-client.js
│   └── index.js
├── safari/               # Safari (local only)
│   ├── local-client.js
│   └── index.js
└── utils/
    ├── applescript.js    # AppleScript executor + arg coercion
    ├── schemas.js        # Shared outputSchema helpers for list-* tools
    ├── date-utils.js
    └── error-handler.js
```

## Tools (41 total)

### Auth (3)
- `about` - Server information
- `check-auth-status` - Verify credentials
- `set-mode` - Switch between LOCAL and CLOUD modes at runtime

### Email (6)
- `list-emails` - List emails from folder. LOCAL reads the ids of every
  message in one Apple event, then the newest `count` through
  `mailbox.messages.byId` (~15 ms per property). Index (`messages[i]`), range
  and `whose` specifiers cost a scan of the whole mailbox per event in Mail.
  Without `account`, the folder of every account is merged newest first.
- `read-email` - Read email content. LOCAL resolves the id with
  `mailbox.messages.byId` (Mail has no application-level `messages`, #15) and
  reports the message's `account` and `mailbox`
- `send-email` - Send email
- `search-emails` - Search by criteria. LOCAL bulk-reads ids plus only the
  filtered properties (subject, sender) and the unread ids, filters in Node,
  then reads hits by id: `from`, `subject` and `unreadOnly` cover the whole
  mailbox. A free-text `query` also reads the bodies of the newest 20 messages
  per mailbox, at most 10 s in total (Mail may download a body first). The
  result carries `scope` (per mailbox: `scanned`, `messages`, `bodyWindow`)
- `mark-as-read` - Mark read/unread
- `list-folders` - List mail folders

### Calendar (5)
- `list-events` - List upcoming events. LOCAL reads EventKit when the host has
  full Calendars access (one store query, ~0.1 s on 26 calendars), requesting it
  once per process if undecided (polled, 25 s cap). Denied, restricted or no
  answer falls back to the Calendar.app `whose` query with a stderr line
  `[icloud-mcp] list-events: EventKit unavailable (status N)…`. `id` is
  `calendarItemIdentifier`, which equals Calendar.app's `uid`. Recurring events
  come back once per occurrence, all sharing the series id, so local
  `update-event`/`delete-event` on such an id act on the whole series.
- `list-calendars` - List calendars
- `create-event` - Create event
- `update-event` - Update event (cloud/CalDAV; preserves RRULE, attendees, alarms)
- `delete-event` - Delete event

### Contacts (7)
- `list-contacts` - List contacts
- `search-contacts` - Search contacts
- `read-contact` - Get contact details
- `create-contact` - Create contact
- `delete-contact` - Delete contact
- `list-contact-accounts` - List accounts (local only). Via the Contacts
  framework (CNContainer), not Contacts.app: its dictionary has no `account`
  class, so `accounts()` always failed with -1708 (#21).
- `list-contact-groups` - List groups (local only), same framework

### Reminders (7) - Local only
- `list-reminder-lists` - List reminder lists
- `list-reminders` - List reminders
- `create-reminder` - Create reminder
- `update-reminder` - Update reminder
- `complete-reminder` - Mark complete
- `delete-reminder` - Delete reminder
- `search-reminders` - Search reminders

### Notes (5) - Local only
- `list-note-folders` - List folders
- `list-notes` - List notes
- `read-note` - Read note content
- `create-note` - Create note
- `search-notes` - Search notes

### Messages (4) - Local only
- `list-chats` - List recent conversations
- `read-messages` - Read a conversation's history
- `send-message` - Send iMessage/SMS
- `react-message` - Send a tapback reaction

Reading needs the `imsg` CLI. It is looked up via `ICLOUD_MCP_IMSG_PATH`, then
the Homebrew prefixes, then `PATH`.

### Safari (4) - Local only
- `list-safari-tabs` - List open tabs
- `get-current-safari-url` - Get current URL
- `open-safari-url` - Open URL
- `close-safari-tab` - Close tab

## Permissions (macOS)

When first used, macOS will prompt for access to:
- Mail
- Calendar
- Contacts
- Reminders
- Notes
- Messages
- Safari

Grant access in **System Settings > Privacy & Security > Automation**.
`list-events` also asks once for **Privacy & Security > Calendars** (EventKit),
and `list-contact-accounts`/`list-contact-groups` for **Privacy & Security >
Contacts** (Contacts framework): separate grants attached to the host app
(Claude Desktop, terminal…).

## Limitations

| Feature | Status | Reason |
|---------|--------|--------|
| iCloud Drive | ❌ | Requires CloudKit |
| Find My | ❌ | Internal API only |
| Read Messages | ✅ | Via `imsg` CLI (needs Full Disk Access) |
| Edit Notes | ⚠️ Limited | AppleScript limitation |

## MCP implementation

Built on `@modelcontextprotocol/server` v2 (`serveStdio` + `McpServer.registerTool`).
The hand-rolled JSON-RPC loop is gone, and with it the whole class of bugs it
carried: framing, notification handling, and unvalidated arguments.

- **Protocol**: negotiated by the SDK, currently up to `2025-11-25`. `serveStdio`
  takes a *factory*, not an instance, because the opening exchange picks the
  protocol era and pins one instance per connection.
- **Validation**: every tool declares a zod v4 `inputSchema`. The SDK validates
  before the handler runs, so a string in a numeric field is rejected at the
  boundary — this is what closes the AppleScript injection class. The `asInt`
  and `asBool` coercions in `utils/applescript.js` remain as defence in depth.
- **Annotations**: every tool carries `title` plus `readOnlyHint`,
  `destructiveHint`, `idempotentHint` and `openWorldHint`.
- **Structured output**: all 15 `list-*` tools declare an `outputSchema` and
  return `structuredContent`. Schemas are deliberately permissive
  (`z.array(z.looseObject({}))`) because the underlying fields vary by macOS
  version and account type, and the SDK *fails* a call whose structuredContent
  does not match its schema. Note this makes `structuredContent` mandatory on
  every success path; error results (`isError: true`) are exempt.
- **Mode switching**: `set-mode` fires `notifications/tools/list_changed` via
  the listener registered in `mode.js`.

Requires **Node >= 20**. Dependencies are managed with **pnpm** (`pnpm-lock.yaml` is the
committed lockfile).

## Distribution

| Fact | Value |
|---|---|
| npm package | `mcp-icloud` |
| MCP registry name | `io.github.mrgo2/icloud-mcp` (`mcpName` in package.json, `server.json` at the repo root) |
| MCP server name (wire) | `icloud-mcp` — reported in `initialize`, unchanged by the npm rename |
| Desktop bundle | `mcpb pack` produces `icloud-mcp.mcpb`; `.mcpbignore` keeps `test/`, `docs/`, `.claude/` and `.remember/` out of it |
| CI | `.github/workflows/ci.yml` — pnpm, Node 20 + 22 on macOS (local mode is macOS-only), plus an inspector smoke on 22. Releases: `release.yml` stages on npm; a maintainer approves with 2FA |

Release artifacts (`*.mcpb`, `*.tgz`) are gitignored: they are built, not source.
