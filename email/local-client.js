/**
 * Local Email Client
 * Accesses Mail.app via JXA (send uses AppleScript)
 *
 * Mail has no application-level `messages` collection, so
 * `mail.messages.byId(n)` fails with -1728. `mailbox.messages.byId(n)` works,
 * and Mail resolves it by id alone: a few milliseconds per property, even on
 * a mailbox of thousands of messages. Index access (`messages[i]`) and
 * `whose` filters cost about a second each on such a mailbox, and
 * `mailbox.messages()` followed by per-message reads costs thousands.
 *
 * So every operation reads message ids in one bulk event (plus the one or two
 * properties a search filters on), picks ids in this process, and reads
 * details through `byId`. Bodies are read one message at a time, and Mail
 * may fetch one from the server first (one took 35 s on a Gmail inbox), so a
 * text query searches the newest BODY_SCAN bodies and stops reading bodies
 * after BODY_BUDGET_MS; search reports what it covered.
 */

const { runAppleScript, runJXA, escapeAppleScript, asInt, asBool } = require('../utils/applescript');

const BODY_SCAN = 20;
const BODY_BUDGET_MS = 10000;
const MAX_COUNT = 50;
// Mail runs Apple events one at a time and keeps working on an event after
// the client gives up, so calls are queued here and bounded in time.
const MAIL_TIMEOUT_MS = 90000;

let mailQueue = Promise.resolve();

/**
 * Run a Mail JXA script after any earlier Mail script has finished.
 * @param {string} script
 * @returns {Promise<string>}
 */
function runMail(script) {
  const run = mailQueue.then(() => runJXA(script, { timeoutMs: MAIL_TIMEOUT_MS }));
  mailQueue = run.catch(() => {});
  return run;
}

/**
 * @param {number} count
 * @returns {number}
 */
function clampCount(count) {
  const n = asInt(count, 25);
  return Math.min(Math.max(n, 1), MAX_COUNT);
}

/**
 * Map folder names to Mail.app mailbox names
 */
function getMailboxName(folder) {
  const mapping = {
    'inbox': 'INBOX',
    'sent': 'Sent Messages',
    'drafts': 'Drafts',
    'trash': 'Deleted Messages',
    'archive': 'Archive',
    'junk': 'Junk'
  };
  return mapping[String(folder || 'inbox').toLowerCase()] || folder;
}

// Shared JXA helpers. User input reaches the script only as the JSON literal
// assigned to ARGS, never spliced into code.
const JXA_PRELUDE = `
  const mail = Application('Mail');
  function accountsFor(name) {
    if (!name) return mail.accounts();
    const a = mail.accounts.byName(name);
    if (!a.exists()) throw new Error('No Mail account named ' + JSON.stringify(name));
    return [a];
  }
  function mailboxIn(acct, name) {
    const mb = acct.mailboxes.byName(name);
    return mb.exists() ? mb : null;
  }
  function iso(d) { return d ? d.toISOString() : ''; }
  function newestFirst(items, n) {
    return items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, n);
  }
  function summary(m, acctName) {
    return { id: m.id(), subject: m.subject() || '', from: m.sender() || '',
      date: iso(m.dateReceived()), read: m.readStatus(), account: acctName };
  }
`;

/**
 * @param {Object} args - Values passed to the script as JSON
 * @param {string} body - JXA statements using ARGS; must return a value
 * @returns {string}
 */
function jxa(args, body) {
  return `${JXA_PRELUDE}
  const ARGS = ${JSON.stringify(args)};
  function main() {
${body}
  }
  JSON.stringify(main());
`;
}

/**
 * @param {string} folder
 * @param {number} count
 * @param {string|null} account
 * @returns {string}
 */
function buildListScript(folder = 'inbox', count = 25, account = null) {
  return jxa({ mailbox: getMailboxName(folder), count: clampCount(count), account: account || null }, `
    const groups = [];
    for (const acct of accountsFor(ARGS.account)) {
      const mb = mailboxIn(acct, ARGS.mailbox);
      if (mb) groups.push({ mb: mb, acctName: acct.name(), ids: mb.messages.id().slice(0, ARGS.count) });
    }
    let picks = [];
    for (const g of groups) for (const id of g.ids) picks.push({ g: g, id: id, date: '' });
    // Several accounts: read only the dates to pick the newest, then summaries.
    if (groups.length > 1) {
      for (const p of picks) p.date = iso(p.g.mb.messages.byId(p.id).dateReceived());
      picks = newestFirst(picks, ARGS.count);
    }
    return picks.map(p => summary(p.g.mb.messages.byId(p.id), p.g.acctName));
  `);
}

/**
 * Statements that set `m` to the message ARGS.id, or throw. The named mailbox
 * is tried first; Mail resolves `byId` by id alone, so the fallback over every
 * mailbox only runs for an id that does not exist.
 */
const FIND_MESSAGE = `
    let m = null;
    const accts = accountsFor(ARGS.account);
    const candidates = [];
    for (const acct of accts) {
      const mb = mailboxIn(acct, ARGS.mailbox);
      if (mb) candidates.push(mb);
    }
    for (const acct of accts) candidates.push(...acct.mailboxes());
    for (const mb of candidates) {
      const c = mb.messages.byId(ARGS.id);
      if (c.exists()) { m = c; break; }
    }
    if (!m) throw new Error('Email not found: ' + ARGS.id);
`;

// Writes go through a specifier rooted in the message's own mailbox rather
// than the one the lookup happened to use.
const ANCHOR_MESSAGE = `
    m = m.mailbox().messages.byId(ARGS.id);
    if (m.id() !== ARGS.id) throw new Error('Email not found: ' + ARGS.id);
`;

function lookupArgs(emailId, folder, account) {
  return { id: asInt(emailId), mailbox: getMailboxName(folder || 'inbox'), account: account || null };
}

function buildReadScript(emailId, folder = 'inbox', account = null) {
  return jxa(lookupArgs(emailId, folder, account), `${FIND_MESSAGE}
    const where = m.mailbox();
    const email = summary(m, where.account().name());
    email.mailbox = where.name();
    email.to = m.toRecipients.address();
    email.cc = m.ccRecipients.address();
    email.body = m.content() || '';
    return email;
  `);
}

function buildMarkAsReadScript(emailId, isRead = true, folder = 'inbox', account = null) {
  const args = { ...lookupArgs(emailId, folder, account), isRead: asBool(isRead, true) };
  return jxa(args, `${FIND_MESSAGE}${ANCHOR_MESSAGE}
    m.readStatus = ARGS.isRead;
    return 'done';
  `);
}

function buildDeleteScript(emailId, folder = 'inbox', account = null) {
  return jxa(lookupArgs(emailId, folder, account), `${FIND_MESSAGE}${ANCHOR_MESSAGE}
    mail.delete(m);
    return 'deleted';
  `);
}

/**
 * One script per search. For each account's mailbox: bulk-read ids plus the
 * properties the filters need, match in JS, then read summaries of up to
 * `count` hits by id. Hits from all accounts are merged newest first. A hit
 * whose subject or sender no longer matches its bulk row means mail arrived
 * between the bulk reads; that mailbox is read again once.
 */
function buildSearchScript({ query, from, subject, unreadOnly = false, folder = 'inbox', count = 25, account = null } = {}) {
  const args = {
    mailbox: getMailboxName(folder || 'inbox'),
    account: account || null,
    count: clampCount(count),
    query: query ? String(query).toLowerCase() : '',
    from: from ? String(from).toLowerCase() : '',
    subject: subject ? String(subject).toLowerCase() : '',
    unreadOnly: !!unreadOnly,
    bodyScan: BODY_SCAN,
    bodyBudgetMs: BODY_BUDGET_MS
  };
  return jxa(args, `
    const items = [];
    const scope = [];
    const lc = (v) => String(v || '').toLowerCase();
    const bodyDeadline = Date.now() + ARGS.bodyBudgetMs;
    function scan(mb, acctName, want, s) {
      const msgs = mb.messages;
      const unread = ARGS.unreadOnly ? msgs.whose({ readStatus: false }).id() : null;
      if (!ARGS.query && !ARGS.from && !ARGS.subject) {
        s.scanned = unread.length;
        s.bodyWindow = 0;
        return unread.slice(0, want).map(id => summary(msgs.byId(id), acctName));
      }
      const ids = msgs.id();
      const subjects = (ARGS.query || ARGS.subject) ? msgs.subject() : null;
      const senders = ARGS.from ? msgs.sender() : null;
      if ((subjects && subjects.length !== ids.length) || (senders && senders.length !== ids.length)) return null;
      const unreadSet = unread ? new Set(unread) : null;
      const hits = [];
      let bodyEnd = Math.min(ARGS.bodyScan, ids.length);
      let i = 0;
      for (; i < ids.length && hits.length < want; i++) {
        if (unreadSet && !unreadSet.has(ids[i])) continue;
        const subj = subjects ? lc(subjects[i]) : '';
        if (ARGS.from && lc(senders[i]).indexOf(ARGS.from) === -1) continue;
        if (ARGS.subject && subj.indexOf(ARGS.subject) === -1) continue;
        if (ARGS.query && subj.indexOf(ARGS.query) === -1) {
          if (i >= bodyEnd) continue;
          if (Date.now() > bodyDeadline) { bodyEnd = i; continue; }
          if (lc(msgs.byId(ids[i]).content()).indexOf(ARGS.query) === -1) continue;
        }
        hits.push(i);
      }
      s.messages = ids.length;
      s.scanned = i;
      s.bodyWindow = ARGS.query ? bodyEnd : 0;
      const out = [];
      for (const i of hits) {
        const e = summary(msgs.byId(ids[i]), acctName);
        if (subjects && lc(e.subject) !== lc(subjects[i])) return null;
        if (senders && lc(e.from) !== lc(senders[i])) return null;
        out.push(e);
      }
      return out;
    }
    for (const acct of accountsFor(ARGS.account)) {
      const mb = mailboxIn(acct, ARGS.mailbox);
      if (!mb) continue;
      const acctName = acct.name();
      const s = { account: acctName, mailbox: ARGS.mailbox, scanned: 0 };
      let found = scan(mb, acctName, ARGS.count, s);
      if (found === null) found = scan(mb, acctName, ARGS.count, s);
      if (found === null) throw new Error('Mailbox ' + acctName + '/' + ARGS.mailbox + ' kept changing during the search; try again');
      items.push(...found);
      scope.push(s);
    }
    return { items: newestFirst(items, ARGS.count), scope: scope };
  `);
}

/**
 * Send an email
 * @param {Object} options - Email options
 * @returns {Promise<Object>} - Send result
 */
async function sendEmail({ to, cc, bcc, subject, body }) {
  const toRecipients = Array.isArray(to) ? to : [to];
  const ccRecipients = cc ? (Array.isArray(cc) ? cc : [cc]) : [];
  const bccRecipients = bcc ? (Array.isArray(bcc) ? bcc : [bcc]) : [];

  let script = `
    tell application "Mail"
      set newMessage to make new outgoing message with properties {subject:"${escapeAppleScript(subject)}", content:"${escapeAppleScript(body)}", visible:false}
      tell newMessage
  `;

  // Add To recipients
  for (const recipient of toRecipients) {
    script += `\n        make new to recipient with properties {address:"${escapeAppleScript(recipient)}"}`;
  }

  // Add CC recipients
  for (const recipient of ccRecipients) {
    script += `\n        make new cc recipient with properties {address:"${escapeAppleScript(recipient)}"}`;
  }

  // Add BCC recipients
  for (const recipient of bccRecipients) {
    script += `\n        make new bcc recipient with properties {address:"${escapeAppleScript(recipient)}"}`;
  }

  script += `
        send
      end tell
    end tell
    return "sent"
  `;

  await runAppleScript(script);
  return { success: true, message: 'Email sent successfully' };
}

/**
 * Run a Mail script and parse its JSON output. osascript reports a thrown
 * error as "execution error: Error: Error: <message> (-2700)"; keep the message.
 * @param {string} script
 * @returns {Promise<*>}
 */
async function runMailJSON(script) {
  let result;
  try {
    result = await runMail(script);
  } catch (e) {
    const m = /execution error: (?:Error: )*(.*?)(?: \(-?\d+\))?\s*$/s.exec(e.message || '');
    if (m) e.message = m[1];
    throw e;
  }
  return parseResult(result);
}

/**
 * Parse a Mail script's JSON output.
 * @param {string} result
 * @returns {*}
 */
function parseResult(result) {
  if (!result) throw new Error('Mail returned no output');
  return JSON.parse(result);
}

/**
 * List emails from a mailbox, newest first
 * @param {string} folder - Folder name (inbox, sent, drafts, etc.)
 * @param {number} count - Number of emails to retrieve
 * @param {string} [account] - Mail account name; omit to fill count from accounts in Mail's order
 * @returns {Promise<Array>} - List of emails
 */
async function listEmails(folder = 'inbox', count = 25, account = null) {
  return runMailJSON(buildListScript(folder, count, account));
}

/**
 * Read a specific email
 * @param {string} emailId - Email ID
 * @param {string} [folder] - Mailbox to look in first
 * @param {string} [account] - Mail account name
 * @returns {Promise<Object>} - Email content
 */
async function readEmail(emailId, folder = 'inbox', account = null) {
  return runMailJSON(buildReadScript(emailId, folder, account));
}

/**
 * Search emails
 * @param {Object} options - Search options
 * @returns {Promise<{items: Array, scope: Array}>} - Matching emails and what was searched
 */
async function searchEmails({ query, from, subject, unreadOnly, folder = 'inbox', count = 25, account = null } = {}) {
  return runMailJSON(buildSearchScript({ query, from, subject, unreadOnly, folder, count, account }));
}

/**
 * Mark email as read/unread
 * @param {string} emailId - Email ID
 * @param {boolean} isRead - Read status
 * @param {string} [folder] - Mailbox to look in first
 * @param {string} [account] - Mail account name
 * @returns {Promise<Object>} - Result
 */
async function markAsRead(emailId, isRead = true, folder = 'inbox', account = null) {
  await runMailJSON(buildMarkAsReadScript(emailId, isRead, folder, account));
  return { success: true, message: `Email marked as ${isRead ? 'read' : 'unread'}` };
}

/**
 * List mail folders/mailboxes
 * @returns {Promise<Array>} - List of folders
 */
async function listFolders() {
  const script = `
    const mail = Application('Mail');
    const accounts = mail.accounts();
    let folders = [];

    for (let account of accounts) {
      const mailboxes = account.mailboxes();
      for (let mb of mailboxes) {
        folders.push({
          name: mb.name(),
          account: account.name(),
          unreadCount: mb.unreadCount()
        });
      }
    }

    JSON.stringify(folders);
  `;

  const result = await runMail(script);
  return result ? JSON.parse(result) : [];
}

/**
 * Delete an email
 * @param {string} emailId - Email ID
 * @param {string} [folder] - Mailbox to look in first
 * @param {string} [account] - Mail account name
 * @returns {Promise<Object>} - Result
 */
async function deleteEmail(emailId, folder = 'inbox', account = null) {
  await runMailJSON(buildDeleteScript(emailId, folder, account));
  return { success: true, message: 'Email deleted' };
}

module.exports = {
  listEmails,
  readEmail,
  sendEmail,
  searchEmails,
  markAsRead,
  listFolders,
  deleteEmail,
  buildListScript,
  buildReadScript,
  buildSearchScript,
  buildMarkAsReadScript,
  buildDeleteScript,
  BODY_SCAN,
  BODY_BUDGET_MS
};
