/**
 * Notes Module
 * MCP tool definitions for Notes.app
 * NOTE: Only available in LOCAL mode (AppleScript)
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

const notesTools = [
  {
    name: 'list-note-folders',
    outputSchema: listOutput('list-note-folders'),
    title: 'List Note Folders',
    description: 'Lists all folders in Notes.app (LOCAL mode only)',
    inputSchema: {},
    annotations: {"readOnlyHint":true,"idempotentHint":true,"openWorldHint":false},
    handler: async () => {
      const modeError = requireLocalMode('list-note-folders');
      if (modeError) return modeError;

      try {
        const folders = await localClient.listNoteFolders();
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(folders, null, 2)
          }],
          structuredContent: listResult(folders)
        };
      } catch (error) {
        return formatError(error, 'list-note-folders');
      }
    }
  },
  {
    name: 'list-notes',
    outputSchema: listOutput('list-notes'),
    title: 'List Notes',
    description: 'Lists notes from a specific folder or all folders',
    inputSchema: {
      folderName: z.string().optional().describe('Name of the folder (optional, lists all if not provided)'),
      count: z.number().int().min(1).max(200).optional().describe('Maximum number of notes to return (default: 25)')
    },
    annotations: {"readOnlyHint":true,"idempotentHint":true,"openWorldHint":false},
    handler: async ({ folderName, count = 25 }) => {
      const modeError = requireLocalMode('list-notes');
      if (modeError) return modeError;

      try {
        const notes = await localClient.listNotes(folderName, count);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(notes, null, 2)
          }],
          structuredContent: listResult(notes)
        };
      } catch (error) {
        return formatError(error, 'list-notes');
      }
    }
  },
  {
    name: 'read-note',
    title: 'Read Note',
    description: 'Reads the content of a specific note',
    inputSchema: {
      noteId: z.string().describe('ID of the note to read (required)')
    },
    annotations: {"readOnlyHint":true,"idempotentHint":true,"openWorldHint":false},
    handler: async ({ noteId }) => {
      const modeError = requireLocalMode('read-note');
      if (modeError) return modeError;

      try {
        const note = await localClient.readNote(noteId);
        if (!note) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ error: 'Note not found' })
            }]
          };
        }
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(note, null, 2)
          }]
        };
      } catch (error) {
        return formatError(error, 'read-note');
      }
    }
  },
  {
    name: 'create-note',
    title: 'Create Note',
    description: 'Creates a new note',
    inputSchema: {
      title: z.string().describe('Note title (required)'),
      body: z.string().optional().describe('Note content/body'),
      folderName: z.string().optional().describe('Folder to create the note in (default: Notes)')
    },
    annotations: {"readOnlyHint":false,"destructiveHint":false,"idempotentHint":false,"openWorldHint":false},
    handler: async (args) => {
      const modeError = requireLocalMode('create-note');
      if (modeError) return modeError;

      try {
        const result = await localClient.createNote(args);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }]
        };
      } catch (error) {
        return formatError(error, 'create-note');
      }
    }
  },
  {
    name: 'search-notes',
    title: 'Search Notes',
    description: 'Search notes by text in title or content',
    inputSchema: {
      query: z.string().describe('Search text (required)'),
      count: z.number().int().min(1).max(200).optional().describe('Maximum results to return (default: 25)')
    },
    annotations: {"readOnlyHint":true,"idempotentHint":true,"openWorldHint":false},
    handler: async ({ query, count = 25 }) => {
      const modeError = requireLocalMode('search-notes');
      if (modeError) return modeError;

      try {
        const results = await localClient.searchNotes(query, count);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(results, null, 2)
          }]
        };
      } catch (error) {
        return formatError(error, 'search-notes');
      }
    }
  }
];

module.exports = { notesTools };
