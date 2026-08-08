/**
 * Contacts module for iCloud MCP
 * Provides contacts tools via CardDAV (cloud) or AppleScript (local)
 */

const { z } = require('zod');
const cloudClient = require('./carddav-client');
const localClient = require('./local-client');
const { formatSuccess, formatError, withErrorHandler } = require('../utils/error-handler');
const { listOutput, listResult } = require('../utils/schemas');
const { isLocalMode } = require('../mode');
const config = require('../config');

/**
 * Get the appropriate client based on current mode
 */
function getClient() {
  return isLocalMode() ? localClient : cloudClient;
}

/**
 * Normalize contact from local format to common format
 */
function normalizeLocalContact(contact) {
  return {
    displayName: contact.name || `${contact.firstName || ''} ${contact.lastName || ''}`.trim(),
    firstName: contact.firstName,
    lastName: contact.lastName,
    emails: contact.email ? [{ value: contact.email, type: 'work' }] : (contact.emails || []),
    phones: contact.phone ? [{ value: contact.phone, type: 'mobile' }] : (contact.phones || []),
    organization: contact.organization,
    title: contact.jobTitle,
    notes: contact.note,
    url: contact.id, // Use ID as URL for local contacts
    uid: contact.id
  };
}

/**
 * Normalize contact list based on mode
 */
function normalizeContacts(contacts, isLocal) {
  if (!isLocal) return contacts;
  return contacts.map(normalizeLocalContact);
}

/**
 * Handler: List contacts
 */
async function handleListContacts(args) {
  const count = Math.min(args.count || 25, config.DEFAULTS.MAX_RESULTS);
  const local = isLocalMode();
  const client = getClient();

  const rawContacts = await client.listContacts(count);
  const contacts = normalizeContacts(rawContacts, local);

  if (contacts.length === 0) {
    return formatSuccess('No contacts found.', listResult([]));
  }

  const lines = contacts.map((contact, i) => {
    let line = `${i + 1}. ${contact.displayName}`;

    if (contact.emails && contact.emails.length > 0) {
      line += `\n   Email: ${contact.emails[0].value}`;
    }
    if (contact.phones && contact.phones.length > 0) {
      line += `\n   Phone: ${contact.phones[0].value}`;
    }
    if (contact.organization) {
      line += `\n   Company: ${contact.organization}`;
    }
    line += `\n   ${local ? 'ID' : 'URL'}: ${contact.url}`;

    return line;
  });

  return formatSuccess(`Contacts (${contacts.length}):\n\n${lines.join('\n\n')}`, listResult(contacts));
}

/**
 * Handler: Search contacts
 */
async function handleSearchContacts(args) {
  if (!args.query) {
    return formatError(new Error('Search query is required'));
  }

  const count = Math.min(args.count || 25, config.DEFAULTS.MAX_RESULTS);
  const local = isLocalMode();
  const client = getClient();

  const rawContacts = await client.searchContacts(args.query, count);
  const contacts = normalizeContacts(rawContacts, local);

  if (contacts.length === 0) {
    return formatSuccess(`No contacts found matching "${args.query}".`, listResult([]));
  }

  const lines = contacts.map((contact, i) => {
    let line = `${i + 1}. ${contact.displayName}`;

    if (contact.emails && contact.emails.length > 0) {
      line += `\n   Email: ${contact.emails[0].value}`;
    }
    if (contact.phones && contact.phones.length > 0) {
      line += `\n   Phone: ${contact.phones[0].value}`;
    }
    if (contact.organization) {
      line += `\n   Company: ${contact.organization}`;
    }
    line += `\n   ${local ? 'ID' : 'URL'}: ${contact.url}`;

    return line;
  });

  return formatSuccess(`Search results for "${args.query}" (${contacts.length}):\n\n${lines.join('\n\n')}`, listResult(contacts));
}

/**
 * Handler: Read contact
 */
async function handleReadContact(args) {
  if (!args.contactUrl) {
    return formatError(new Error('Contact URL/ID is required'));
  }

  const local = isLocalMode();
  const client = getClient();

  // Local uses readContact, cloud uses getContact
  const rawContact = local
    ? await client.readContact(args.contactUrl)
    : await client.getContact(args.contactUrl);

  const contact = local ? normalizeLocalContact(rawContact) : rawContact;

  const emailList = contact.emails && contact.emails.length > 0
    ? contact.emails.map(e => `  - ${e.value} (${e.type || e.label || 'other'})`).join('\n')
    : '  (none)';

  const phoneList = contact.phones && contact.phones.length > 0
    ? contact.phones.map(p => `  - ${p.value} (${p.type || p.label || 'other'})`).join('\n')
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

${local ? 'ID' : 'URL'}: ${contact.url}
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

  const local = isLocalMode();
  const client = getClient();

  const result = await client.createContact({
    displayName: args.displayName,
    firstName: args.firstName,
    lastName: args.lastName,
    email: args.email,
    phone: args.phone,
    organization: args.organization,
    jobTitle: args.title, // Local uses jobTitle
    title: args.title,    // Cloud uses title
    note: args.notes,     // Local uses note
    notes: args.notes     // Cloud uses notes
  });

  const name = args.displayName || `${args.firstName || ''} ${args.lastName || ''}`.trim();

  return formatSuccess(
    `Contact created successfully!\n\nName: ${name}${args.email ? `\nEmail: ${args.email}` : ''}${args.phone ? `\nPhone: ${args.phone}` : ''}${args.organization ? `\nOrganization: ${args.organization}` : ''}\n${local ? 'ID' : 'UID'}: ${result.uid || result.id}`
  );
}

/**
 * Handler: Delete contact
 */
async function handleDeleteContact(args) {
  if (!args.contactUrl) {
    return formatError(new Error('Contact URL/ID is required'));
  }

  const client = getClient();
  await client.deleteContact(args.contactUrl);

  return formatSuccess('Contact deleted successfully.');
}

/**
 * Handler: List contact accounts (LOCAL mode only)
 */
async function handleListContactAccounts(args) {
  if (!isLocalMode()) {
    return formatError(new Error('list-contact-accounts is only available in LOCAL mode'));
  }

  const accounts = await localClient.listAccounts();

  if (accounts.length === 0) {
    return formatSuccess('No contact accounts found.', listResult([]));
  }

  const lines = accounts.map((account, i) => {
    return `${i + 1}. ${account.name}\n   Groups: ${account.groupCount}\n   ID: ${account.id}`;
  });

  return formatSuccess(`Contact Accounts (${accounts.length}):\n\n${lines.join('\n\n')}`, listResult(accounts));
}

/**
 * Handler: List contact groups (LOCAL mode only)
 */
async function handleListContactGroups(args) {
  if (!isLocalMode()) {
    return formatError(new Error('list-contact-groups is only available in LOCAL mode'));
  }

  const groups = await localClient.listGroups(args.accountId || null);

  if (groups.length === 0) {
    return formatSuccess('No contact groups found.', listResult([]));
  }

  const lines = groups.map((group, i) => {
    return `${i + 1}. ${group.name}\n   Account: ${group.accountName}\n   Contacts: ${group.contactCount}\n   ID: ${group.id}`;
  });

  return formatSuccess(`Contact Groups (${groups.length}):\n\n${lines.join('\n\n')}`, listResult(groups));
}

// Tool definitions
const contactsTools = [
  {
    name: 'list-contacts',
    outputSchema: listOutput('Contacts'),
    title: 'List Contacts',
    description: 'Lists contacts from your iCloud address book',
    inputSchema: {
      count: z.number().int().min(1).max(50).optional().describe('Number of contacts to retrieve (default: 25, max: 50)')
    },
    annotations: {"readOnlyHint":true,"idempotentHint":true,"openWorldHint":false},
    handler: withErrorHandler(handleListContacts, 'list-contacts')
  },
  {
    name: 'search-contacts',
    outputSchema: listOutput('Matching contacts'),
    title: 'Search Contacts',
    description: 'Search contacts by name, email, or phone',
    inputSchema: {
      query: z.string().describe('Search query (name, email, or phone)'),
      count: z.number().int().min(1).max(50).optional().describe('Max results (default: 25, max: 50)')
    },
    annotations: {"readOnlyHint":true,"idempotentHint":true,"openWorldHint":false},
    handler: withErrorHandler(handleSearchContacts, 'search-contacts')
  },
  {
    name: 'read-contact',
    title: 'Read Contact',
    description: 'Get detailed information about a specific contact',
    inputSchema: {
      contactUrl: z.string().describe('URL or ID of the contact (from list-contacts output)')
    },
    annotations: {"readOnlyHint":true,"idempotentHint":true,"openWorldHint":false},
    handler: withErrorHandler(handleReadContact, 'read-contact')
  },
  {
    name: 'create-contact',
    title: 'Create Contact',
    description: 'Creates a new contact',
    inputSchema: {
      displayName: z.string().optional().describe('Full display name'),
      firstName: z.string().optional().describe('First name'),
      lastName: z.string().optional().describe('Last name'),
      email: z.string().optional().describe('Email address'),
      phone: z.string().optional().describe('Phone number'),
      organization: z.string().optional().describe('Company/Organization'),
      title: z.string().optional().describe('Job title'),
      notes: z.string().optional().describe('Notes about the contact')
    },
    annotations: {"readOnlyHint":false,"destructiveHint":false,"idempotentHint":false,"openWorldHint":false},
    handler: withErrorHandler(handleCreateContact, 'create-contact')
  },
  {
    name: 'delete-contact',
    title: 'Delete Contact',
    description: 'Deletes a contact',
    inputSchema: {
      contactUrl: z.string().describe('URL or ID of the contact to delete (from list-contacts output)')
    },
    annotations: {"readOnlyHint":false,"destructiveHint":true,"idempotentHint":true,"openWorldHint":false},
    handler: withErrorHandler(handleDeleteContact, 'delete-contact')
  },
  {
    name: 'list-contact-accounts',
    outputSchema: listOutput('Contact accounts'),
    title: 'List Contact Accounts',
    description: 'Lists all contact accounts (iCloud, Google, Exchange, etc.) - LOCAL mode only',
    inputSchema: {},
    annotations: {"readOnlyHint":true,"idempotentHint":true,"openWorldHint":false},
    handler: withErrorHandler(handleListContactAccounts, 'list-contact-accounts')
  },
  {
    name: 'list-contact-groups',
    outputSchema: listOutput('Contact groups'),
    title: 'List Contact Groups',
    description: 'Lists contact groups from all accounts or a specific account - LOCAL mode only',
    inputSchema: {
      accountId: z.string().optional().describe('Optional account ID to filter groups by (from list-contact-accounts)')
    },
    annotations: {"readOnlyHint":true,"idempotentHint":true,"openWorldHint":false},
    handler: withErrorHandler(handleListContactGroups, 'list-contact-groups')
  }
];

module.exports = {
  contactsTools,
  handleListContacts,
  handleSearchContacts,
  handleReadContact,
  handleCreateContact,
  handleDeleteContact,
  handleListContactAccounts,
  handleListContactGroups
};
