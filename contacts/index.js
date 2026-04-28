/**
 * Contacts module for iCloud MCP
 * Provides contacts tools via CardDAV
 */

const config = require('../config');
const useLocal = config.USE_LOCAL_MODE && config.IS_MACOS;
const { listContacts, searchContacts, getContact, createContact, deleteContact } = useLocal ? require('./local-client') : require('./carddav-client');
const { formatSuccess, formatError, withErrorHandler } = require('../utils/error-handler');

/**
 * Handler: List contacts
 */
async function handleListContacts(args) {
  const count = Math.min(args.count || 25, config.DEFAULTS.MAX_RESULTS);

  const contacts = await listContacts(count);

  if (contacts.length === 0) {
    return formatSuccess('No contacts found.');
  }

  const lines = contacts.map((contact, i) => {
    let line = `${i + 1}. ${contact.displayName}`;

    if (contact.emails.length > 0) {
      line += `\n   Email: ${contact.emails[0].value}`;
    }
    if (contact.phones.length > 0) {
      line += `\n   Phone: ${contact.phones[0].value}`;
    }
    if (contact.organization) {
      line += `\n   Company: ${contact.organization}`;
    }
    line += `\n   URL: ${contact.url}`;

    return line;
  });

  return formatSuccess(`Contacts (${contacts.length}):\n\n${lines.join('\n\n')}`);
}

/**
 * Handler: Search contacts
 */
async function handleSearchContacts(args) {
  if (!args.query) {
    return formatError(new Error('Search query is required'));
  }

  const count = Math.min(args.count || 25, config.DEFAULTS.MAX_RESULTS);
  const contacts = await searchContacts(args.query, count);

  if (contacts.length === 0) {
    return formatSuccess(`No contacts found matching "${args.query}".`);
  }

  const lines = contacts.map((contact, i) => {
    let line = `${i + 1}. ${contact.displayName}`;

    if (contact.emails.length > 0) {
      line += `\n   Email: ${contact.emails[0].value}`;
    }
    if (contact.phones.length > 0) {
      line += `\n   Phone: ${contact.phones[0].value}`;
    }
    if (contact.organization) {
      line += `\n   Company: ${contact.organization}`;
    }
    line += `\n   URL: ${contact.url}`;

    return line;
  });

  return formatSuccess(`Search results for "${args.query}" (${contacts.length}):\n\n${lines.join('\n\n')}`);
}

/**
 * Handler: Read contact
 */
async function handleReadContact(args) {
  if (!args.contactUrl) {
    return formatError(new Error('Contact URL is required'));
  }

  const contact = await getContact(args.contactUrl);

  const emailList = contact.emails.length > 0
    ? contact.emails.map(e => `  - ${e.value} (${e.type})`).join('\n')
    : '  (none)';

  const phoneList = contact.phones.length > 0
    ? contact.phones.map(p => `  - ${p.value} (${p.type})`).join('\n')
    : '  (none)';

  return formatSuccess(
    `Contact Details:

Name: ${contact.displayName}
First Name: ${contact.firstName || '(not set)'}
Last Name: ${contact.lastName || '(not set)'}

Emails:
${emailList}

Phones:
${phoneList}

Organization: ${contact.organization || '(not set)'}
Title: ${contact.title || '(not set)'}

Notes: ${contact.notes || '(none)'}

URL: ${contact.url}
UID: ${contact.uid}`
  );
}

/**
 * Handler: Create contact
 */
async function handleCreateContact(args) {
  if (!args.displayName && !args.firstName && !args.lastName) {
    return formatError(new Error('At least displayName or firstName/lastName is required'));
  }

  const result = await createContact({
    displayName: args.displayName,
    firstName: args.firstName,
    lastName: args.lastName,
    email: args.email,
    phone: args.phone,
    organization: args.organization,
    title: args.title,
    notes: args.notes
  });

  const name = args.displayName || `${args.firstName || ''} ${args.lastName || ''}`.trim();

  return formatSuccess(
    `Contact created successfully!\n\nName: ${name}${args.email ? `\nEmail: ${args.email}` : ''}${args.phone ? `\nPhone: ${args.phone}` : ''}${args.organization ? `\nOrganization: ${args.organization}` : ''}\nUID: ${result.uid}`
  );
}

/**
 * Handler: Delete contact
 */
async function handleDeleteContact(args) {
  if (!args.contactUrl) {
    return formatError(new Error('Contact URL is required'));
  }

  await deleteContact(args.contactUrl);

  return formatSuccess('Contact deleted successfully.');
}

// Tool definitions
const contactsTools = [
  {
    name: 'list-contacts',
    description: 'Lists contacts from your iCloud address book',
    inputSchema: {
      type: 'object',
      properties: {
        count: {
          type: 'number',
          description: 'Number of contacts to retrieve (default: 25, max: 50)'
        }
      },
      required: []
    },
    handler: withErrorHandler(handleListContacts, 'list-contacts')
  },
  {
    name: 'search-contacts',
    description: 'Search contacts by name, email, or phone',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (name, email, or phone)'
        },
        count: {
          type: 'number',
          description: 'Max results (default: 25, max: 50)'
        }
      },
      required: ['query']
    },
    handler: withErrorHandler(handleSearchContacts, 'search-contacts')
  },
  {
    name: 'read-contact',
    description: 'Get detailed information about a specific contact',
    inputSchema: {
      type: 'object',
      properties: {
        contactUrl: {
          type: 'string',
          description: 'URL of the contact (from list-contacts output)'
        }
      },
      required: ['contactUrl']
    },
    handler: withErrorHandler(handleReadContact, 'read-contact')
  },
  {
    name: 'create-contact',
    description: 'Creates a new contact',
    inputSchema: {
      type: 'object',
      properties: {
        displayName: {
          type: 'string',
          description: 'Full display name'
        },
        firstName: {
          type: 'string',
          description: 'First name'
        },
        lastName: {
          type: 'string',
          description: 'Last name'
        },
        email: {
          type: 'string',
          description: 'Email address'
        },
        phone: {
          type: 'string',
          description: 'Phone number'
        },
        organization: {
          type: 'string',
          description: 'Company/Organization'
        },
        title: {
          type: 'string',
          description: 'Job title'
        },
        notes: {
          type: 'string',
          description: 'Notes about the contact'
        }
      },
      required: []
    },
    handler: withErrorHandler(handleCreateContact, 'create-contact')
  },
  {
    name: 'delete-contact',
    description: 'Deletes a contact',
    inputSchema: {
      type: 'object',
      properties: {
        contactUrl: {
          type: 'string',
          description: 'URL of the contact to delete (from list-contacts output)'
        }
      },
      required: ['contactUrl']
    },
    handler: withErrorHandler(handleDeleteContact, 'delete-contact')
  }
];

module.exports = {
  contactsTools,
  handleListContacts,
  handleSearchContacts,
  handleReadContact,
  handleCreateContact,
  handleDeleteContact
};
