#!/usr/bin/env node

/**
 * iCloud MCP Server v2.0.0
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

const readline = require('readline');
const config = require('./config');
const { getMode } = require('./mode');
const { validateArgs } = require('./utils/validate');

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

// Server info - mode is dynamic
function getServerInfo() {
  return {
    name: 'icloud-mcp',
    version: '2.0.0',
    description: `MCP server for Apple services (Mode: ${getMode().toUpperCase()})`
  };
}

/**
 * Handle MCP JSON-RPC request
 */
async function handleRequest(request) {
  const { method, params, id } = request;

  // Notifications carry no id and MUST NOT be answered at all.
  if (typeof method === 'string' && method.startsWith('notifications/')) {
    return null;
  }

  try {
    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            serverInfo: getServerInfo(),
            capabilities: {
              tools: {}
            }
          }
        };

      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: TOOLS.map(tool => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema
            }))
          }
        };

      case 'tools/call': {
        const toolName = params?.name;
        const toolArgs = params?.arguments || {};

        const tool = TOOLS.find(t => t.name === toolName);
        if (!tool) {
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32602,
              message: `Unknown tool: ${toolName}`
            }
          };
        }

        console.error(`[icloud-mcp] Calling tool: ${toolName}`);

        // Tool failures are reported in the result with isError, not as a
        // protocol error: the model needs to see them and can retry.
        try {
          const args = validateArgs(toolName, tool.inputSchema, toolArgs);
          const result = await tool.handler(args);
          return { jsonrpc: '2.0', id, result };
        } catch (error) {
          console.error(`[icloud-mcp] Tool ${toolName} failed:`, error.message);
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: `Error: ${error.message}` }],
              isError: true
            }
          };
        }
      }

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: `Unknown method: ${method}`
          }
        };
    }
  } catch (error) {
    console.error(`[icloud-mcp] Error handling ${method}:`, error.message);
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32603,
        message: error.message
      }
    };
  }
}

/**
 * Start the MCP server
 */
function startServer() {
  const initialMode = getMode();

  console.error('[icloud-mcp] Starting iCloud MCP server v2.0.0...');
  console.error(`[icloud-mcp] Initial mode: ${initialMode.toUpperCase()}`);
  console.error(`[icloud-mcp] Tools available: ${TOOLS.length}`);
  console.error('[icloud-mcp] Mode switching: Use set-mode tool to change modes at runtime');

  if (initialMode === 'local') {
    console.error('[icloud-mcp] Services: Email, Calendar, Contacts, Reminders, Notes, Messages, Safari');
  } else {
    console.error('[icloud-mcp] Services: Email, Calendar, Contacts');
    console.error(`[icloud-mcp] Credentials configured: ${!!(config.ICLOUD_EMAIL && config.ICLOUD_APP_PASSWORD)}`);
  }

  if (config.USE_TEST_MODE) {
    console.error('[icloud-mcp] TEST MODE ENABLED');
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  // MCP stdio framing is one complete JSON message per line, so each line is
  // parsed on its own. A malformed line is dropped rather than accumulated -
  // buffering it would poison every request that followed.
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let request;
    try {
      request = JSON.parse(trimmed);
    } catch (e) {
      console.error('[icloud-mcp] Ignoring malformed JSON line:', e.message);
      return;
    }

    try {
      const response = await handleRequest(request);
      if (response) {
        process.stdout.write(JSON.stringify(response) + '\n');
      }
    } catch (e) {
      console.error('[icloud-mcp] Unhandled error:', e.message);
      if (request.id !== undefined) {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32603, message: e.message }
        }) + '\n');
      }
    }
  });

  rl.on('close', () => {
    console.error('[icloud-mcp] Server shutting down');
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.error('[icloud-mcp] Received SIGINT, shutting down');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.error('[icloud-mcp] Received SIGTERM, shutting down');
    process.exit(0);
  });
}

// Start the server
startServer();
