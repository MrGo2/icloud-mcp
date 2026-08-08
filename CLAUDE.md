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
| **Email** | IMAP/SMTP (not yet local) | 6 |
| **Calendar** | CalDAV (not yet local) | 5 |
| **Contacts** | Contacts.app (AppleScript) | 7 |
| **Reminders** | Reminders.app (AppleScript) | 7 |
| **Notes** | Notes.app (AppleScript) | 5 |
| **Messages** | Messages.app + `imsg` CLI | 4 |
| **Safari** | Safari.app (AppleScript) | 4 |

> **Known gap:** `email/index.js` and `calendar/index.js` import their cloud
> clients directly and do no mode routing, so `email/local-client.js` and
> `calendar/local-client.js` are currently unreachable. Both services need
> credentials even in LOCAL mode.

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
├── index.js              # Main MCP server
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
    ├── validate.js       # Validates tool args against inputSchema
    ├── date-utils.js
    └── error-handler.js
```

## Tools (41 total)

### Auth (3)
- `about` - Server information
- `check-auth-status` - Verify credentials
- `set-mode` - Switch between LOCAL and CLOUD modes at runtime

### Email (6)
- `list-emails` - List emails from folder
- `read-email` - Read email content
- `send-email` - Send email
- `search-emails` - Search by criteria
- `mark-as-read` - Mark read/unread
- `list-folders` - List mail folders

### Calendar (5)
- `list-events` - List upcoming events
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
- `list-contact-accounts` - List accounts (local only)
- `list-contact-groups` - List groups (local only)

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

## Limitations

| Feature | Status | Reason |
|---------|--------|--------|
| iCloud Drive | ❌ | Requires CloudKit |
| Find My | ❌ | Internal API only |
| Read Messages | ✅ | Via `imsg` CLI (needs Full Disk Access) |
| Edit Notes | ⚠️ Limited | AppleScript limitation |
