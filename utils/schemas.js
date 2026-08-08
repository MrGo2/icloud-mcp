/**
 * Shared output schemas for tools that return a list.
 *
 * Deliberately permissive: the items come from AppleScript, IMAP, CalDAV and
 * CardDAV, whose exact fields vary by macOS version, account type and server.
 * The SDK fails a call whose structuredContent does not match its outputSchema,
 * so pinning field names here would turn a harmless extra property into a
 * broken tool. The contract is "an array of objects, plus a count".
 */

const { z } = require('zod');

/**
 * @param {string} description - What the items are, e.g. 'Contacts'
 * @returns {Object} - A zod raw shape for use as a tool outputSchema
 */
function listOutput(description) {
  return {
    items: z.array(z.looseObject({})).describe(description),
    total: z.number().int().describe('Number of items returned')
  };
}

/**
 * Build the structuredContent payload matching listOutput().
 * @param {Array} items
 */
function listResult(items) {
  const array = Array.isArray(items) ? items : [];
  return { items: array, total: array.length };
}

module.exports = { listOutput, listResult };
