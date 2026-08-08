/**
 * Safari Module
 * MCP tool definitions for Safari.app
 */

const { z } = require('zod');
const localClient = require('./local-client');
const { formatError } = require('../utils/error-handler');
const { listOutput, listResult } = require('../utils/schemas');
const { isLocalMode } = require('../mode');

function requireLocalMode(toolName) {
  if (!isLocalMode()) {
    return formatError(new Error(`${toolName} is only available in LOCAL mode. Use set-mode to switch.`));
  }
  return null;
}

const safariTools = [
  {
    name: 'list-safari-tabs',
    outputSchema: listOutput('list-safari-tabs'),
    title: 'List Safari Tabs',
    description: 'Lists all open tabs in Safari across all windows',
    inputSchema: {},
    annotations: {"readOnlyHint":true,"idempotentHint":true,"openWorldHint":false},
    handler: async () => {
      const modeError = requireLocalMode('list-safari-tabs');
      if (modeError) return modeError;

      try {
        const tabs = await localClient.listTabs();
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(tabs, null, 2)
          }],
          structuredContent: listResult(tabs)
        };
      } catch (error) {
        return formatError(error, 'list-safari-tabs');
      }
    }
  },
  {
    name: 'get-current-safari-url',
    title: 'Get Current Safari URL',
    description: 'Gets the URL and title of the current/active Safari tab',
    inputSchema: {},
    annotations: {"readOnlyHint":true,"idempotentHint":true,"openWorldHint":false},
    handler: async () => {
      const modeError = requireLocalMode('get-current-safari-url');
      if (modeError) return modeError;

      try {
        const result = await localClient.getCurrentUrl();
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }]
        };
      } catch (error) {
        return formatError(error, 'get-current-safari-url');
      }
    }
  },
  {
    name: 'open-safari-url',
    title: 'Open URL In Safari',
    description: 'Opens a URL in Safari (new tab or new window)',
    inputSchema: {
      url: z.string().describe('URL to open (required)'),
      inNewWindow: z.boolean().optional().describe('Open in new window instead of new tab (default: false)')
    },
    annotations: {"readOnlyHint":false,"destructiveHint":false,"idempotentHint":false,"openWorldHint":true},
    handler: async ({ url, inNewWindow = false }) => {
      const modeError = requireLocalMode('open-safari-url');
      if (modeError) return modeError;

      try {
        const result = await localClient.openUrl(url, inNewWindow);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }]
        };
      } catch (error) {
        return formatError(error, 'open-safari-url');
      }
    }
  },
  {
    name: 'close-safari-tab',
    title: 'Close Safari Tab',
    description: 'Closes a Safari tab',
    inputSchema: {
      windowIndex: z.number().int().min(0).optional().describe('Window index (0-based, default: 0 for front window)'),
      tabIndex: z.number().int().min(0).optional().describe('Tab index to close (0-based). If omitted, closes the current tab.')
    },
    annotations: {"readOnlyHint":false,"destructiveHint":true,"idempotentHint":true,"openWorldHint":false},
    handler: async ({ windowIndex = 0, tabIndex }) => {
      const modeError = requireLocalMode('close-safari-tab');
      if (modeError) return modeError;

      try {
        const result = await localClient.closeTab(windowIndex, tabIndex);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }]
        };
      } catch (error) {
        return formatError(error, 'close-safari-tab');
      }
    }
  }
];

module.exports = { safariTools };
