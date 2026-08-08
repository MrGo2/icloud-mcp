<p align="center">
  <img src="https://img.icons8.com/color/96/icloud.png" alt="iCloud Logo" width="80"/>
</p>

<h1 align="center">Apple MCP Server</h1>

<p align="center">
  <strong>Connect Claude to your Apple services via the Model Context Protocol</strong>
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#installation">Installation</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#tools">Tools</a> •
  <a href="#architecture">Architecture</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen" alt="Node Version"/>
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License"/>
  <img src="https://img.shields.io/badge/MCP-compatible-purple" alt="MCP Compatible"/>
  <img src="https://img.shields.io/badge/macOS-AppleScript-orange" alt="macOS"/>
  <img src="https://img.shields.io/badge/iCloud-IMAP%20%7C%20CalDAV%20%7C%20CardDAV-lightgrey" alt="Protocols"/>
</p>

---

## Overview

This MCP server enables Claude to interact with your Apple services in two modes:

### Local Mode (Default) - macOS Only
Uses AppleScript to access native macOS apps. **Faster, works offline, more services.**

| Service | Backend | Tools |
|---------|---------|-------|
| **Email** | IMAP / SMTP \* | 6 |
| **Calendar** | CalDAV \* | 5 |
| **Contacts** | Contacts.app | 7 |
| **Reminders** | Reminders.app | 7 |
| **Notes** | Notes.app | 5 |
| **Messages** | Messages.app + `imsg` | 4 |
| **Safari** | Safari.app | 4 |

\* Email and Calendar still use the iCloud protocols in both modes and need
credentials. Their AppleScript clients exist but are not wired up yet.

### Cloud Mode - Works Anywhere
Uses iCloud protocols (IMAP, CalDAV, CardDAV). Requires app-specific password.

| Service | Protocol | Endpoint |
|---------|----------|----------|
| **Email** | IMAP / SMTP | `imap.mail.me.com` / `smtp.mail.me.com` |
| **Calendar** | CalDAV | `caldav.icloud.com` |
| **Contacts** | CardDAV | `contacts.icloud.com` |

---

## Features

- **41 Tools** across 7 services (local-only tools return an error in cloud mode)
- **Dual Mode** - switch between local (fast) and cloud (remote access)
- **7 Services** - Email, Calendar, Contacts, Reminders, Notes, Messages, Safari
- **Secure Authentication** - AppleScript permissions or app-specific passwords
- **Full CRUD** - create, read, update, delete across services

---

## Installation

```bash
# Clone the repository
git clone https://github.com/MrGo2/icloud-mcp.git
cd icloud-mcp

# Install dependencies
npm install

# Configure (optional for local mode)
cp .env.example .env
```

---

## Configuration

### Local Mode (Default)

No configuration needed! Just run:

```bash
npm start
```

On first use, macOS will prompt for access to each app. Grant permission in **System Settings > Privacy & Security > Automation**.

### Cloud Mode

1. **Generate an App-Specific Password**
   - Go to [appleid.apple.com](https://appleid.apple.com)
   - Sign in → **Security** → **App-Specific Passwords** → **Generate**
   - Name it `iCloud MCP` and copy the 16-character password

2. **Configure `.env`**
   ```env
   USE_LOCAL_MODE=false
   ICLOUD_EMAIL=your-email@icloud.com
   ICLOUD_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
   ```

### Add to Claude Desktop

Add to your Claude Desktop MCP settings (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "apple": {
      "command": "node",
      "args": ["/path/to/icloud-mcp/index.js"]
    }
  }
}
```

---

## Tools

### Authentication (3)

| Tool | Description |
|------|-------------|
| `about` | Server information |
| `check-auth-status` | Verify credentials |
| `set-mode` | Switch between LOCAL and CLOUD at runtime |

### Email (6)

| Tool | Description |
|------|-------------|
| `list-emails` | List emails from a folder |
| `read-email` | Read full email content |
| `send-email` | Compose and send email |
| `search-emails` | Search by criteria |
| `mark-as-read` | Mark read/unread |
| `list-folders` | List mail folders |

### Calendar (5)

| Tool | Description |
|------|-------------|
| `list-events` | List upcoming events |
| `list-calendars` | List all calendars |
| `create-event` | Create new event |
| `update-event` | Update an event, preserving recurrence and invitees |
| `delete-event` | Delete an event |

### Contacts (7)

| Tool | Description |
|------|-------------|
| `list-contacts` | List contacts |
| `search-contacts` | Search by name/email/phone |
| `read-contact` | Get contact details |
| `create-contact` | Create new contact |
| `delete-contact` | Delete a contact |
| `list-contact-accounts` | List accounts (iCloud, Google, ...) - local only |
| `list-contact-groups` | List contact groups - local only |

### Reminders (7) - Local Only

| Tool | Description |
|------|-------------|
| `list-reminder-lists` | List all reminder lists |
| `list-reminders` | List reminders from a list |
| `create-reminder` | Create new reminder |
| `update-reminder` | Update reminder |
| `complete-reminder` | Mark as complete |
| `delete-reminder` | Delete reminder |
| `search-reminders` | Search reminders |

### Notes (5) - Local Only

| Tool | Description |
|------|-------------|
| `list-note-folders` | List note folders |
| `list-notes` | List notes |
| `read-note` | Read note content |
| `create-note` | Create new note |
| `search-notes` | Search notes |

### Messages (4) - Local Only

Reading requires the [`imsg`](https://github.com/steipete/imsg) CLI and Full Disk Access.

| Tool | Description |
|------|-------------|
| `list-chats` | List recent conversations |
| `read-messages` | Read a conversation's history |
| `send-message` | Send iMessage/SMS |
| `react-message` | Send a tapback reaction |

### Safari (4) - Local Only

| Tool | Description |
|------|-------------|
| `list-safari-tabs` | List open tabs |
| `get-current-safari-url` | Get current tab URL |
| `open-safari-url` | Open URL in new tab |
| `close-safari-tab` | Close a tab |

---

## Architecture

```
icloud-mcp/
├── index.js              # MCP server (JSON-RPC over stdio)
├── mode.js               # Runtime mode state
├── config.js             # Configuration
├── auth/                 # Credential management + set-mode
├── email/
│   ├── imap-client.js    # Cloud: IMAP
│   ├── smtp-client.js    # Cloud: SMTP
│   ├── local-client.js   # Local: Mail.app
│   └── index.js
├── calendar/
│   ├── caldav-client.js  # Cloud: CalDAV
│   ├── local-client.js   # Local: Calendar.app
│   └── index.js
├── contacts/
│   ├── carddav-client.js # Cloud: CardDAV
│   ├── local-client.js   # Local: Contacts.app
│   └── index.js
├── reminders/            # Local only
├── notes/                # Local only
├── messages/             # Local only
├── safari/               # Local only
└── utils/
    ├── applescript.js    # AppleScript executor
    ├── date-utils.js
    └── error-handler.js
```

---

## Usage Examples

### List Reminders
```
"Show me my reminders for today"
```

### Create a Reminder
```
"Create a reminder to buy milk tomorrow at 5pm"
```

### Send a Message
```
"Send an iMessage to +34612345678 saying I'll be there in 10 minutes"
```

### Check Safari Tabs
```
"What tabs do I have open in Safari?"
```

### Send Email
```
"Send an email to john@example.com with subject 'Meeting Tomorrow'"
```

---

## Mode Comparison

| Feature | Local Mode | Cloud Mode |
|---------|------------|------------|
| Speed | Fast (~100ms) | Slower (~500ms+) |
| Works offline | ✅ | ❌ |
| Remote access | ❌ | ✅ |
| Services | 7 | 3 |
| Tools | 41 advertised | 41 advertised, 23 usable |
| Requirements | macOS | App-specific password |

---

## Limitations

| Feature | Status | Reason |
|---------|--------|--------|
| Read Messages | ✅ | Via the `imsg` CLI (needs Full Disk Access) |
| Edit Notes | ⚠️ Limited | AppleScript limitation |
| iCloud Drive | ❌ | Requires CloudKit |
| Find My | ❌ | Internal API only |

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| **Permission denied** | Grant access in System Settings > Privacy & Security > Automation |
| **App not responding** | Make sure the app (Mail, Calendar, etc.) is running |
| **Authentication failed** (cloud) | Use app-specific password, not Apple ID password |
| **IMAP timeout** (cloud) | iCloud servers can be slow - retry |

---

## Development

```bash
# Run in local mode (default)
npm start

# Run in cloud mode
USE_LOCAL_MODE=false npm start

# Test with MCP Inspector
npm run inspect
```

---

## License

MIT © [Carlos Lorenzo](https://github.com/MrGo2)

---

<p align="center">
  <sub>Built for use with <a href="https://claude.ai">Claude</a> and the <a href="https://modelcontextprotocol.io">Model Context Protocol</a></sub>
</p>
