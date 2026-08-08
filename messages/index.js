/**
 * Messages Module
 * MCP tool definitions for Messages.app
 * Send via AppleScript, read via imsg CLI
 */

const { z } = require('zod');
const localClient = require('./local-client');
const { formatError, formatSuccess, withErrorHandler } = require('../utils/error-handler');
const { listOutput, listResult } = require('../utils/schemas');
const { isLocalMode } = require('../mode');
const { execFileSync } = require('child_process');
const fs = require('fs');

// Homebrew's prefix differs between Apple Silicon and Intel, and an MCP server
// launched by a GUI client often has a minimal PATH, so probe both.
const IMSG_CANDIDATES = [
  process.env.ICLOUD_MCP_IMSG_PATH,
  process.env.IMSG_PATH,
  '/opt/homebrew/bin/imsg',
  '/usr/local/bin/imsg'
].filter(Boolean);

function resolveImsg() {
  for (const candidate of IMSG_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  // Last resort: let the OS search PATH.
  return 'imsg';
}

function requireLocalMode(toolName) {
  if (!isLocalMode()) {
    return formatError(new Error(`${toolName} is only available in LOCAL mode. Use set-mode to switch.`));
  }
  return null;
}

function runImsg(args) {
  let output;
  try {
    output = execFileSync(resolveImsg(), args, {
      timeout: 15000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (error) {
    const detail = (error.stderr || error.message || '').toString();
    if (detail.includes('permissionDenied')) {
      throw new Error('Full Disk Access required. Grant it to the terminal in System Settings > Privacy & Security > Full Disk Access.');
    }
    if (error.code === 'ENOENT') {
      throw new Error('The imsg CLI was not found. Install it (brew install imsg) or set ICLOUD_MCP_IMSG_PATH.');
    }
    throw new Error(detail.trim() || 'imsg failed');
  }

  try {
    return JSON.parse(output);
  } catch {
    // imsg outputs JSONL (one JSON object per line)
    const lines = output.trim().split('\n').filter(Boolean);
    const parsed = lines.map(l => { try { return JSON.parse(l); } catch { return { raw: l }; } });
    return parsed.length === 1 ? parsed[0] : parsed;
  }
}

const messagesTools = [
  {
    name: 'list-chats',
    outputSchema: listOutput('Recent conversations'),
    title: 'List Chats',
    description: 'List recent iMessage/SMS conversations with contact names and last message preview',
    inputSchema: {
      limit: z.number().int().min(1).max(200).optional().describe('Number of conversations to show (default 20)')
    },
    annotations: {"readOnlyHint":true,"idempotentHint":true,"openWorldHint":false},
    handler: withErrorHandler(async ({ limit = 20 }) => {
      const modeError = requireLocalMode('list-chats');
      if (modeError) return modeError;
      const result = runImsg(['chats', '--limit', String(limit), '--json']);
      // imsg emits JSONL, and runImsg unwraps a single line to a bare object.
      const chats = Array.isArray(result) ? result : (result ? [result] : []);
      return formatSuccess(JSON.stringify(chats, null, 2), listResult(chats));
    }, 'list-chats')
  },
  {
    name: 'read-messages',
    title: 'Read Messages',
    description: 'Read message history for a specific iMessage/SMS conversation',
    inputSchema: {
      chatId: z.number().int().describe('Chat ID (rowid from list-chats)'),
      limit: z.number().int().min(1).max(500).optional().describe('Number of messages (default 20)'),
      start: z.string().optional().describe('Start date (ISO 8601, optional)'),
      end: z.string().optional().describe('End date (ISO 8601, optional)'),
      attachments: z.boolean().optional().describe('Include attachment info (default false)')
    },
    annotations: {"readOnlyHint":true,"idempotentHint":true,"openWorldHint":false},
    handler: withErrorHandler(async ({ chatId, limit = 20, start, end, attachments }) => {
      const modeError = requireLocalMode('read-messages');
      if (modeError) return modeError;
      const args = ['history', '--chat-id', String(chatId), '--limit', String(limit), '--json'];
      if (start) args.push('--start', start);
      if (end) args.push('--end', end);
      if (attachments) args.push('--attachments');
      const result = runImsg(args);
      return formatSuccess(JSON.stringify(result, null, 2));
    }, 'read-messages')
  },
  {
    name: 'send-message',
    title: 'Send Message',
    description: 'Send an iMessage or SMS. IMPORTANT: Always confirm with user before sending.',
    inputSchema: {
      to: z.string().describe('Recipient phone number (with country code) or email'),
      body: z.string().describe('Message content'),
      file: z.string().optional().describe('Path to file attachment (optional)')
    },
    annotations: {"readOnlyHint":false,"destructiveHint":false,"idempotentHint":false,"openWorldHint":true},
    handler: withErrorHandler(async ({ to, body, file }) => {
      const modeError = requireLocalMode('send-message');
      if (modeError) return modeError;
      try {
        const result = await localClient.sendMessage({ to, body });
        return formatSuccess(JSON.stringify(result, null, 2));
      } catch (error) {
        // Fallback to imsg CLI
        try {
          const args = ['send', '--to', to, '--text', body];
          if (file) args.push('--file', file);
          const result = runImsg(args);
          return formatSuccess(JSON.stringify(result, null, 2));
        } catch (e) {
          throw new Error(`${error.message} (imsg fallback also failed: ${e.message})`);
        }
      }
    }, 'send-message')
  },
  {
    name: 'react-message',
    title: 'React To Message',
    description: 'Send a tapback reaction (love, like, dislike, laugh, emphasis, question)',
    inputSchema: {
      chatId: z.number().int().describe('Chat ID'),
      type: z.enum(['love', 'like', 'dislike', 'laugh', 'emphasis', 'question']).describe('Reaction type')
    },
    annotations: {"readOnlyHint":false,"destructiveHint":false,"idempotentHint":false,"openWorldHint":true},
    handler: withErrorHandler(async ({ chatId, type }) => {
      const modeError = requireLocalMode('react-message');
      if (modeError) return modeError;
      const result = runImsg(['react', '--chat-id', String(chatId), '--type', type]);
      return formatSuccess(JSON.stringify(result, null, 2));
    }, 'react-message')
  }
];

module.exports = { messagesTools };
