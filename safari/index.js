/**
 * Safari Module
 * MCP tool definitions for Safari.app
 */

const localClient = require('./local-client');
const { handleError, formatError } = require('../utils/error-handler');
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
    description: 'Lists all open tabs in Safari across all windows',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    },
    handler: async () => {
      const modeError = requireLocalMode('list-safari-tabs');
      if (modeError) return modeError;

      try {
        const tabs = await localClient.listTabs();
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(tabs, null, 2)
          }]
        };
      } catch (error) {
        return handleError(error, 'list-safari-tabs');
      }
    }
  },
  {
    name: 'get-current-safari-url',
    description: 'Gets the URL and title of the current/active Safari tab',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    },
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
        return handleError(error, 'get-current-safari-url');
      }
    }
  },
  {
    name: 'open-safari-url',
    description: 'Opens a URL in Safari (new tab or new window)',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL to open (required)'
        },
        inNewWindow: {
          type: 'boolean',
          description: 'Open in new window instead of new tab (default: false)'
        }
      },
      required: ['url']
    },
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
        return handleError(error, 'open-safari-url');
      }
    }
  },
  {
    name: 'close-safari-tab',
    description: 'Closes a Safari tab',
    inputSchema: {
      type: 'object',
      properties: {
        windowIndex: {
          type: 'number',
          description: 'Window index (0-based, default: 0 for front window)'
        },
        tabIndex: {
          type: 'number',
          description: 'Tab index to close (0-based). If not provided, closes current tab.'
        }
      },
      required: []
    },
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
        return handleError(error, 'close-safari-tab');
      }
    }
  }
];

module.exports = { safariTools };
