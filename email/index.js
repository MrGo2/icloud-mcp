/**
 * Email module for iCloud MCP
 * Provides email tools via IMAP/SMTP
 */

const config = require('../config');
const useLocal = config.USE_LOCAL_MODE && config.IS_MACOS;
const { listEmails, readEmail, searchEmails, markAsRead, listFolders } = useLocal ? require('./local-client') : require('./imap-client');
const { sendEmail } = useLocal ? require('./local-client') : require('./smtp-client');
const { formatSuccess, formatError, withErrorHandler } = require('../utils/error-handler');
const { formatDate, formatRelative } = require('../utils/date-utils');

/**
 * Handler: List emails
 */
async function handleListEmails(args) {
  const folder = args.folder || 'inbox';
  const count = Math.min(args.count || 25, config.DEFAULTS.MAX_RESULTS);

  const emails = await listEmails(folder, count);

  if (emails.length === 0) {
    return formatSuccess(`No emails found in ${folder}.`);
  }

  const lines = emails.map((email, i) => {
    const unread = email.flags ? !email.flags.includes('\\Seen') : !email.read;
    const date = formatRelative(new Date(email.date));
    const id = email.uid || email.id;
    return `${i + 1}. ${unread ? '[UNREAD] ' : ''}${email.subject}\n   From: ${email.from}\n   Date: ${date}\n   UID: ${id}`;
  });

  return formatSuccess(`Emails in ${folder} (${emails.length}):\n\n${lines.join('\n\n')}`);
}

/**
 * Handler: Read email
 */
async function handleReadEmail(args) {
  if (!args.uid) {
    return formatError(new Error('Email UID is required'));
  }

  const folder = args.folder || 'inbox';
  const email = await readEmail(args.uid, folder);

  let body = email.text || email.body || '';
  if (body.length > config.DEFAULTS.EMAIL_BODY_MAX_LENGTH) {
    body = body.substring(0, config.DEFAULTS.EMAIL_BODY_MAX_LENGTH) + '\n... (truncated)';
  }

  const attachments = email.attachments || [];
  const attachmentInfo = attachments.length > 0
    ? `\n\nAttachments (${attachments.length}):\n${attachments.map(a => `- ${a.filename} (${a.contentType}, ${Math.round(a.size / 1024)}KB)`).join('\n')}`
    : '';

  return formatSuccess(
    `Subject: ${email.subject}
From: ${email.from}
To: ${email.to}${email.cc ? `\nCC: ${email.cc}` : ''}
Date: ${formatDate(email.date)}
UID: ${email.uid || email.id}

---

${body}${attachmentInfo}`
  );
}

/**
 * Handler: Send email
 */
async function handleSendEmail(args) {
  if (!args.to) {
    return formatError(new Error('Recipient (to) is required'));
  }
  if (!args.subject) {
    return formatError(new Error('Subject is required'));
  }
  if (!args.body) {
    return formatError(new Error('Body is required'));
  }

  const result = await sendEmail({
    to: args.to,
    cc: args.cc,
    bcc: args.bcc,
    subject: args.subject,
    body: args.body,
    isHtml: args.isHtml || false
  });

  if (result.success) {
    return formatSuccess(
      `Email sent successfully!\n\nTo: ${args.to}${args.cc ? `\nCC: ${args.cc}` : ''}\nSubject: ${args.subject}\nMessage ID: ${result.messageId}`
    );
  } else {
    return formatError(new Error('Failed to send email'));
  }
}

/**
 * Handler: Search emails
 */
async function handleSearchEmails(args) {
  const folder = args.folder || 'inbox';
  const count = Math.min(args.count || 25, config.DEFAULTS.MAX_RESULTS);

  const criteria = {};
  if (args.from) criteria.from = args.from;
  if (args.subject) criteria.subject = args.subject;
  if (args.query) criteria.text = args.query;
  if (args.unreadOnly) criteria.unseen = true;

  const emails = await searchEmails(criteria, folder, count);

  if (emails.length === 0) {
    return formatSuccess(`No emails found matching your search criteria in ${folder}.`);
  }

  const lines = emails.map((email, i) => {
    const unread = email.flags ? !email.flags.includes('\\Seen') : !email.read;
    const date = formatRelative(new Date(email.date));
    const id = email.uid || email.id;
    return `${i + 1}. ${unread ? '[UNREAD] ' : ''}${email.subject}\n   From: ${email.from}\n   Date: ${date}\n   UID: ${id}`;
  });

  return formatSuccess(`Search results in ${folder} (${emails.length}):\n\n${lines.join('\n\n')}`);
}

/**
 * Handler: Mark as read
 */
async function handleMarkAsRead(args) {
  if (!args.uid) {
    return formatError(new Error('Email UID is required'));
  }

  const folder = args.folder || 'inbox';
  const isRead = args.isRead !== false;

  await markAsRead(args.uid, folder, isRead);

  return formatSuccess(`Email ${args.uid} marked as ${isRead ? 'read' : 'unread'}.`);
}

/**
 * Handler: List folders
 */
async function handleListFolders() {
  const folders = await listFolders();

  const lines = folders.map(f => `- ${f.name}`);

  return formatSuccess(`Email folders:\n\n${lines.join('\n')}`);
}

// Tool definitions
const emailTools = [
  {
    name: 'list-emails',
    description: 'Lists emails from a folder (default: inbox)',
    inputSchema: {
      type: 'object',
      properties: {
        folder: {
          type: 'string',
          description: 'Email folder (inbox, sent, drafts, trash, archive, junk)'
        },
        count: {
          type: 'number',
          description: 'Number of emails to retrieve (default: 25, max: 50)'
        }
      },
      required: []
    },
    handler: withErrorHandler(handleListEmails, 'list-emails')
  },
  {
    name: 'read-email',
    description: 'Reads the full content of an email by UID',
    inputSchema: {
      type: 'object',
      properties: {
        uid: {
          type: 'string',
          description: 'The UID of the email to read'
        },
        folder: {
          type: 'string',
          description: 'Email folder (default: inbox)'
        }
      },
      required: ['uid']
    },
    handler: withErrorHandler(handleReadEmail, 'read-email')
  },
  {
    name: 'send-email',
    description: 'Composes and sends an email',
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Recipient email address(es), comma-separated'
        },
        cc: {
          type: 'string',
          description: 'CC recipient(s), comma-separated'
        },
        bcc: {
          type: 'string',
          description: 'BCC recipient(s), comma-separated'
        },
        subject: {
          type: 'string',
          description: 'Email subject'
        },
        body: {
          type: 'string',
          description: 'Email body content'
        },
        isHtml: {
          type: 'boolean',
          description: 'Whether the body is HTML (default: false)'
        }
      },
      required: ['to', 'subject', 'body']
    },
    handler: withErrorHandler(handleSendEmail, 'send-email')
  },
  {
    name: 'search-emails',
    description: 'Search for emails by criteria',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Text to search in email content'
        },
        from: {
          type: 'string',
          description: 'Filter by sender'
        },
        subject: {
          type: 'string',
          description: 'Filter by subject'
        },
        folder: {
          type: 'string',
          description: 'Email folder to search (default: inbox)'
        },
        unreadOnly: {
          type: 'boolean',
          description: 'Only show unread emails'
        },
        count: {
          type: 'number',
          description: 'Max results (default: 25, max: 50)'
        }
      },
      required: []
    },
    handler: withErrorHandler(handleSearchEmails, 'search-emails')
  },
  {
    name: 'mark-as-read',
    description: 'Marks an email as read or unread',
    inputSchema: {
      type: 'object',
      properties: {
        uid: {
          type: 'string',
          description: 'The UID of the email'
        },
        folder: {
          type: 'string',
          description: 'Email folder (default: inbox)'
        },
        isRead: {
          type: 'boolean',
          description: 'Mark as read (true) or unread (false). Default: true'
        }
      },
      required: ['uid']
    },
    handler: withErrorHandler(handleMarkAsRead, 'mark-as-read')
  },
  {
    name: 'list-folders',
    description: 'Lists all email folders',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    },
    handler: withErrorHandler(handleListFolders, 'list-folders')
  }
];

module.exports = {
  emailTools,
  handleListEmails,
  handleReadEmail,
  handleSendEmail,
  handleSearchEmails,
  handleMarkAsRead,
  handleListFolders
};
