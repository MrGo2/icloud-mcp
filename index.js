#!/usr/bin/env node

/**
 * iCloud MCP Server v2.1.1
 *
 * Provides Claude with access to Apple services:
 * - Email (via IMAP/SMTP or Mail.app)
 * - Calendar (via CalDAV or Calendar.app)
 * - Contacts (via CardDAV or Contacts.app)
 * - Reminders (via Reminders.app - local only)
 * - Notes (via Notes.app - local only)
 * - Messages (via Messages.app - local only)
 * - Safari (via Safari.app - local only)
 *
 * Modes (switchable at runtime via set-mode tool):
 * - LOCAL: Uses AppleScript to access native macOS apps (fast, requires Mac)
 * - CLOUD: Uses iCloud protocols (IMAP, CalDAV, CardDAV) - works from anywhere
 */

const { McpServer } = require('@modelcontextprotocol/server');
const { serveStdio } = require('@modelcontextprotocol/server/stdio');

const config = require('./config');
const { getMode, onModeChange } = require('./mode');

// Import all modules - tools are always available, handlers check mode
const { authTools } = require('./auth');
const { emailTools } = require('./email');
const { calendarTools } = require('./calendar');
const { contactsTools } = require('./contacts');
const { remindersTools } = require('./reminders');
const { notesTools } = require('./notes');
const { messagesTools } = require('./messages');
const { safariTools } = require('./safari');

// All tools always available - handlers check mode and error if unsupported
const TOOLS = [
  ...authTools,
  ...emailTools,
  ...calendarTools,
  ...contactsTools,
  ...remindersTools,
  ...notesTools,
  ...messagesTools,
  ...safariTools
];

/**
 * Build a server instance with every tool registered.
 *
 * serveStdio takes a factory rather than an instance: the opening exchange
 * decides the protocol era and pins one instance for the connection, so the
 * same registrations have to be reproducible on demand.
 */
function buildServer() {
  const server = new McpServer(
    {
      name: 'icloud-mcp',
      version: '2.1.1',
      title: 'iCloud MCP'
    },
    {
      capabilities: { tools: { listChanged: true } },
      instructions: `Access to Apple services in two modes.

LOCAL (default, macOS only) drives the native apps via AppleScript.
CLOUD uses the iCloud protocols and needs an app-specific password.

Reminders, Notes, Messages and Safari are LOCAL only: calling them in CLOUD
mode returns an error. Use set-mode to switch without restarting.`
    }
  );

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        ...(tool.annotations ? { annotations: tool.annotations } : {})
      },
      tool.handler
    );
  }

  // set-mode changes which tools actually work, so tell the client to re-read
  // the list. Failures here are cosmetic - never take the connection down.
  onModeChange(() => {
    Promise.resolve(server.sendToolListChanged()).catch(() => {});
  });

  return server;
}

console.error('[icloud-mcp] Starting iCloud MCP server v2.1.1...');
console.error(`[icloud-mcp] Initial mode: ${getMode().toUpperCase()}`);
console.error(`[icloud-mcp] Tools available: ${TOOLS.length}`);

if (getMode() === 'local') {
  console.error('[icloud-mcp] Services: Email, Calendar, Contacts, Reminders, Notes, Messages, Safari');
} else {
  console.error('[icloud-mcp] Services: Email, Calendar, Contacts');
  console.error(`[icloud-mcp] Credentials configured: ${!!(config.ICLOUD_EMAIL && config.ICLOUD_APP_PASSWORD)}`);
}

if (config.USE_TEST_MODE) {
  console.error('[icloud-mcp] TEST MODE ENABLED');
}

// serveStdio returns a handle (not a promise); it owns the transport lifetime.
const handle = serveStdio(buildServer);

function shutdown(signal) {
  console.error(`[icloud-mcp] Received ${signal}, shutting down`);
  Promise.resolve(handle?.close?.())
    .catch(() => {})
    .finally(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
