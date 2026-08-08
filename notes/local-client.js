/**
 * Local Notes Client
 * Accesses Notes.app via AppleScript
 */

const { runAppleScript, runJXA, escapeAppleScript, escapeJXA, asInt } = require('../utils/applescript');

/**
 * List note folders
 * @returns {Promise<Array>} - List of folders
 */
async function listNoteFolders() {
  const script = `
    const notes = Application('Notes');
    const folders = notes.folders();
    let result = [];

    for (let folder of folders) {
      try {
        result.push({
          id: folder.id(),
          name: folder.name(),
          noteCount: folder.notes().length
        });
      } catch (e) {}
    }

    JSON.stringify(result);
  `;

  const result = await runJXA(script);
  return result ? JSON.parse(result) : [];
}

/**
 * List notes
 * @param {string} folderName - Folder name (optional)
 * @param {number} count - Max notes to return
 * @returns {Promise<Array>} - List of notes
 */
async function listNotes(folderName = null, count = 25) {
  const script = `
    const notes = Application('Notes');
    let allNotes = [];

    ${folderName ? `
    const folder = notes.folders.byName("${escapeJXA(folderName)}");
    const notesList = folder.notes();
    for (let note of notesList) {
      allNotes.push({
        id: note.id(),
        name: note.name(),
        creationDate: note.creationDate().toISOString(),
        modificationDate: note.modificationDate().toISOString(),
        folder: "${escapeJXA(folderName)}"
      });
    }
    ` : `
    const folders = notes.folders();
    for (let folder of folders) {
      try {
        const notesList = folder.notes();
        for (let note of notesList) {
          allNotes.push({
            id: note.id(),
            name: note.name(),
            creationDate: note.creationDate().toISOString(),
            modificationDate: note.modificationDate().toISOString(),
            folder: folder.name()
          });
        }
      } catch (e) {}
    }
    `}

    // Sort by modification date (newest first)
    allNotes.sort((a, b) => new Date(b.modificationDate) - new Date(a.modificationDate));
    JSON.stringify(allNotes.slice(0, ${asInt(count, 25)}));
  `;

  const result = await runJXA(script);
  return result ? JSON.parse(result) : [];
}

/**
 * Read a note's content
 * @param {string} noteId - Note ID
 * @returns {Promise<Object>} - Note content
 */
async function readNote(noteId) {
  const script = `
    const notes = Application('Notes');
    const folders = notes.folders();

    for (let folder of folders) {
      try {
        const notesList = folder.notes();
        for (let note of notesList) {
          if (note.id() === "${escapeJXA(noteId)}") {
            // Get plain text by stripping HTML
            const body = note.body();
            const plaintext = note.plaintext();

            return JSON.stringify({
              id: note.id(),
              name: note.name(),
              body: body,
              plaintext: plaintext,
              creationDate: note.creationDate().toISOString(),
              modificationDate: note.modificationDate().toISOString(),
              folder: folder.name()
            });
          }
        }
      } catch (e) {}
    }

    return JSON.stringify(null);
  `;

  const result = await runJXA(script);
  return result ? JSON.parse(result) : null;
}

/**
 * Create a new note
 * @param {Object} options - Note options
 * @returns {Promise<Object>} - Created note info
 */
async function createNote({ title, body, folderName = 'Notes' }) {
  // Notes uses an HTML body. Split on real newlines BEFORE escaping: escaping
  // turns a newline into the two characters \ and n, so a replace afterwards
  // would find nothing and the note would render with literal \n in it.
  const htmlLines = String(body || '').split('\n').map(escapeAppleScript).join('<br>');
  const htmlBody = `<h1>${escapeAppleScript(title)}</h1><br>${htmlLines}`;

  const script = `
    tell application "Notes"
      tell folder "${escapeAppleScript(folderName)}"
        set newNote to make new note with properties {body:"${htmlBody}"}
        return id of newNote
      end tell
    end tell
  `;

  const id = await runAppleScript(script);
  return { success: true, id, message: 'Note created successfully' };
}

/**
 * Search notes
 * @param {string} query - Search query
 * @param {number} count - Max results
 * @returns {Promise<Array>} - Matching notes
 */
async function searchNotes(query, count = 25) {
  const searchTerm = escapeJXA(query.toLowerCase());
  const limit = asInt(count, 25);

  const script = `
    const notes = Application('Notes');
    const folders = notes.folders();
    let results = [];

    for (let folder of folders) {
      if (results.length >= ${limit}) break;

      try {
        const notesList = folder.notes();
        for (let note of notesList) {
          if (results.length >= ${limit}) break;

          const name = (note.name() || '').toLowerCase();
          const plaintext = (note.plaintext() || '').toLowerCase();

          if (name.includes("${searchTerm}") || plaintext.includes("${searchTerm}")) {
            results.push({
              id: note.id(),
              name: note.name(),
              creationDate: note.creationDate().toISOString(),
              modificationDate: note.modificationDate().toISOString(),
              folder: folder.name(),
              snippet: note.plaintext().substring(0, 200)
            });
          }
        }
      } catch (e) {}
    }

    JSON.stringify(results);
  `;

  const result = await runJXA(script);
  return result ? JSON.parse(result) : [];
}

module.exports = {
  listNoteFolders,
  listNotes,
  readNote,
  createNote,
  searchNotes
};
