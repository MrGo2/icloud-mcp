/**
 * Messages Module
 * MCP tool definitions for Messages.app
 * Send via AppleScript, read via imsg CLI
 */

const localClient = require('./local-client');
const { handleError, formatError } = require('../utils/error-handler');
const { isLocalMode } = require('../mode');
const { execFileSync } = require('child_process');

const IMSG_PATH = '/opt/homebrew/bin/imsg';

function requireLocalMode(toolName) {
  if (!isLocalMode()) {
    return formatError(new Error(`${toolName} is only available in LOCAL mode. Use set-mode to switch.`));
  }
  return null;
}

function runImsg(args) {
  try {
    const output = execFileSync(IMSG_PATH, args, { timeout: 15000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      return JSON.parse(output);
    } catch {
      // imsg outputs JSONL (one JSON object per line)
      const lines = output.trim().split('\n').filter(Boolean);
      const parsed = lines.map(l => { try { return JSON.parse(l); } catch { return { raw: l }; } });
      return parsed.length === 1 ? parsed[0] : parsed;
    }
  } catch (error) {
    if (error.message && error.message.includes('permissionDenied')) {
      return { error: 'Full Disk Access required. Grant it to the terminal in System Settings > Privacy > Full Disk Access.' };
    }
    return { error: error.stderr || error.message };
  }
}

const messagesTools = [
  {
    name: 'list-chats',
    description: 'List recent iMessage/SMS conversations with contact names and last message preview',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of conversations to show (default 20)' }
      }
    },
    handler: async ({ limit = 20 }) => {
      const modeError = requireLocalMode('list-chats');
      if (modeError) return modeError;
      const result = runImsg(['chats', '--limit', String(limit), '--json']);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  },
  {
    name: 'read-messages',
    description: 'Read message history for a specific iMessage/SMS conversation',
    inputSchema: {
      type: 'object',
      properties: {
        chatId: { type: 'number', description: 'Chat ID (rowid from list-chats)' },
        limit: { type: 'number', description: 'Number of messages (default 20)' },
        start: { type: 'string', description: 'Start date (ISO 8601, optional)' },
        end: { type: 'string', description: 'End date (ISO 8601, optional)' },
        attachments: { type: 'boolean', description: 'Include attachment info (default false)' }
      },
      required: ['chatId']
    },
    handler: async ({ chatId, limit = 20, start, end, attachments }) => {
      const modeError = requireLocalMode('read-messages');
      if (modeError) return modeError;
      const args = ['history', '--chat-id', String(chatId), '--limit', String(limit), '--json'];
      if (start) args.push('--start', start);
      if (end) args.push('--end', end);
      if (attachments) args.push('--attachments');
      const result = runImsg(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  },
  {
    name: 'send-message',
    description: 'Send an iMessage or SMS. IMPORTANT: Always confirm with user before sending.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient phone number (with country code) or email' },
        body: { type: 'string', description: 'Message content' },
        file: { type: 'string', description: 'Path to file attachment (optional)' }
      },
      required: ['to', 'body']
    },
    handler: async ({ to, body, file }) => {
      const modeError = requireLocalMode('send-message');
      if (modeError) return modeError;
      try {
        const result = await localClient.sendMessage({ to, body });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        // Fallback to imsg CLI
        try {
          const args = ['send', '--to', to, '--text', body];
          if (file) args.push('--file', file);
          const result = runImsg(args);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (e) {
          return handleError(error, 'send-message');
        }
      }
    }
  },
  {
    name: 'react-message',
    description: 'Send a tapback reaction (love, like, dislike, laugh, emphasis, question)',
    inputSchema: {
      type: 'object',
      properties: {
        chatId: { type: 'number', description: 'Chat ID' },
        type: { type: 'string', description: 'Reaction type: love, like, dislike, laugh, emphasis, question' }
      },
      required: ['chatId', 'type']
    },
    handler: async ({ chatId, type }) => {
      const modeError = requireLocalMode('react-message');
      if (modeError) return modeError;
      const result = runImsg(['react', '--chat-id', String(chatId), '--type', type]);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  }
];

module.exports = { messagesTools };
