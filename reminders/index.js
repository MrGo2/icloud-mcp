/**
 * Reminders Module
 * MCP tool definitions for Reminders.app
 * NOTE: Only available in LOCAL mode (AppleScript)
 */

const localClient = require('./local-client');
const { formatError } = require('../utils/error-handler');
const { isLocalMode } = require('../mode');

/**
 * Check if we're in local mode, return error if not
 */
function requireLocalMode(toolName) {
  if (!isLocalMode()) {
    return formatError(new Error(`${toolName} is only available in LOCAL mode. Use set-mode to switch.`));
  }
  return null;
}

const remindersTools = [
  {
    name: 'list-reminder-lists',
    description: 'Lists all reminder lists from Reminders.app (LOCAL mode only)',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    },
    handler: async () => {
      const modeError = requireLocalMode('list-reminder-lists');
      if (modeError) return modeError;

      try {
        const lists = await localClient.listReminderLists();
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(lists, null, 2)
          }]
        };
      } catch (error) {
        return formatError(error, 'list-reminder-lists');
      }
    }
  },
  {
    name: 'list-reminders',
    description: 'Lists reminders from a specific list or all lists (LOCAL mode only)',
    inputSchema: {
      type: 'object',
      properties: {
        listName: {
          type: 'string',
          description: 'Name of the reminder list (optional, lists all if not provided)'
        },
        includeCompleted: {
          type: 'boolean',
          description: 'Include completed reminders (default: false)'
        },
        count: {
          type: 'number',
          description: 'Maximum number of reminders to return (default: 50)'
        }
      },
      required: []
    },
    handler: async ({ listName, includeCompleted = false, count = 50 }) => {
      const modeError = requireLocalMode('list-reminders');
      if (modeError) return modeError;

      try {
        const reminders = await localClient.listReminders(listName, includeCompleted, count);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(reminders, null, 2)
          }]
        };
      } catch (error) {
        return formatError(error, 'list-reminders');
      }
    }
  },
  {
    name: 'create-reminder',
    description: 'Creates a new reminder (LOCAL mode only)',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Reminder title (required)'
        },
        body: {
          type: 'string',
          description: 'Reminder notes/description'
        },
        dueDate: {
          type: 'string',
          description: 'Due date in ISO format (e.g., 2026-01-15T10:00:00)'
        },
        listName: {
          type: 'string',
          description: 'Name of the list to add to (default: Reminders)'
        },
        priority: {
          type: 'number',
          description: 'Priority level (0=none, 1=high, 5=medium, 9=low)'
        }
      },
      required: ['name']
    },
    handler: async (args) => {
      const modeError = requireLocalMode('create-reminder');
      if (modeError) return modeError;

      try {
        const result = await localClient.createReminder(args);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }]
        };
      } catch (error) {
        return formatError(error, 'create-reminder');
      }
    }
  },
  {
    name: 'update-reminder',
    description: 'Updates an existing reminder (LOCAL mode only)',
    inputSchema: {
      type: 'object',
      properties: {
        reminderId: {
          type: 'string',
          description: 'ID of the reminder to update (required)'
        },
        name: {
          type: 'string',
          description: 'New title'
        },
        body: {
          type: 'string',
          description: 'New notes/description'
        },
        dueDate: {
          type: 'string',
          description: 'New due date in ISO format (set to null to remove)'
        },
        priority: {
          type: 'number',
          description: 'New priority level'
        }
      },
      required: ['reminderId']
    },
    handler: async ({ reminderId, ...updates }) => {
      const modeError = requireLocalMode('update-reminder');
      if (modeError) return modeError;

      try {
        const result = await localClient.updateReminder(reminderId, updates);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }]
        };
      } catch (error) {
        return formatError(error, 'update-reminder');
      }
    }
  },
  {
    name: 'complete-reminder',
    description: 'Marks a reminder as complete or incomplete (LOCAL mode only)',
    inputSchema: {
      type: 'object',
      properties: {
        reminderId: {
          type: 'string',
          description: 'ID of the reminder (required)'
        },
        completed: {
          type: 'boolean',
          description: 'Set to true to complete, false to uncomplete (default: true)'
        }
      },
      required: ['reminderId']
    },
    handler: async ({ reminderId, completed = true }) => {
      const modeError = requireLocalMode('complete-reminder');
      if (modeError) return modeError;

      try {
        const result = await localClient.completeReminder(reminderId, completed);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }]
        };
      } catch (error) {
        return formatError(error, 'complete-reminder');
      }
    }
  },
  {
    name: 'delete-reminder',
    description: 'Deletes a reminder (LOCAL mode only)',
    inputSchema: {
      type: 'object',
      properties: {
        reminderId: {
          type: 'string',
          description: 'ID of the reminder to delete (required)'
        }
      },
      required: ['reminderId']
    },
    handler: async ({ reminderId }) => {
      const modeError = requireLocalMode('delete-reminder');
      if (modeError) return modeError;

      try {
        const result = await localClient.deleteReminder(reminderId);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }]
        };
      } catch (error) {
        return formatError(error, 'delete-reminder');
      }
    }
  },
  {
    name: 'search-reminders',
    description: 'Search reminders by text in name or body (LOCAL mode only)',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search text (required)'
        },
        count: {
          type: 'number',
          description: 'Maximum results to return (default: 25)'
        }
      },
      required: ['query']
    },
    handler: async ({ query, count = 25 }) => {
      const modeError = requireLocalMode('search-reminders');
      if (modeError) return modeError;

      try {
        const results = await localClient.searchReminders(query, count);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(results, null, 2)
          }]
        };
      } catch (error) {
        return formatError(error, 'search-reminders');
      }
    }
  }
];

module.exports = { remindersTools };
