/**
 * CardDAV client for iCloud Contacts
 */

const { DAVClient } = require('tsdav');
const config = require('../config');
const { getCredentials } = require('../auth');

let cachedClient = null;

/**
 * Get or create CardDAV client
 */
async function getClient() {
  if (cachedClient) {
    return cachedClient;
  }

  const creds = getCredentials();

  const client = new DAVClient({
    serverUrl: config.CARDDAV.SERVER_URL,
    credentials: {
      username: creds.email,
      password: creds.password
    },
    authMethod: 'Basic',
    defaultAccountType: 'carddav'
  });

  try {
    await client.login();
    cachedClient = client;
    return client;
  } catch (error) {
    if (error.message?.includes('401') || error.message?.includes('auth')) {
      throw new Error('UNAUTHORIZED');
    }
    throw error;
  }
}

/**
 * Clear cached client
 */
function clearClient() {
  cachedClient = null;
}

/**
 * Parse vCard to simple object
 */
function parseVCard(vcardData, url) {
  try {
    const contact = {
      url,
      uid: '',
      displayName: '',
      firstName: '',
      lastName: '',
      emails: [],
      phones: [],
      organization: '',
      title: '',
      notes: ''
    };

    const lines = vcardData.split(/\r?\n/);

    for (const line of lines) {
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) continue;

      const key = line.substring(0, colonIndex).toUpperCase();
      const value = line.substring(colonIndex + 1);

      // Handle property parameters (like TYPE=WORK)
      const keyParts = key.split(';');
      const mainKey = keyParts[0];

      switch (mainKey) {
        case 'UID':
          contact.uid = value;
          break;
        case 'FN':
          contact.displayName = decodeVCardValue(value);
          break;
        case 'N':
          const nameParts = value.split(';');
          contact.lastName = decodeVCardValue(nameParts[0] || '');
          contact.firstName = decodeVCardValue(nameParts[1] || '');
          break;
        case 'EMAIL':
          const emailType = extractType(keyParts) || 'other';
          contact.emails.push({ type: emailType, value: decodeVCardValue(value) });
          break;
        case 'TEL':
          const phoneType = extractType(keyParts) || 'other';
          contact.phones.push({ type: phoneType, value: decodeVCardValue(value) });
          break;
        case 'ORG':
          contact.organization = decodeVCardValue(value.split(';')[0]);
          break;
        case 'TITLE':
          contact.title = decodeVCardValue(value);
          break;
        case 'NOTE':
          contact.notes = decodeVCardValue(value);
          break;
      }
    }

    // Use first/last name if no display name
    if (!contact.displayName && (contact.firstName || contact.lastName)) {
      contact.displayName = `${contact.firstName} ${contact.lastName}`.trim();
    }

    return contact;
  } catch (error) {
    console.error('Error parsing vCard:', error.message);
    return null;
  }
}

/**
 * Extract TYPE parameter from vCard property
 */
function extractType(keyParts) {
  for (const part of keyParts) {
    if (part.startsWith('TYPE=')) {
      return part.substring(5).toLowerCase();
    }
  }
  return null;
}

/**
 * Decode vCard escaped value
 */
function decodeVCardValue(value) {
  if (!value) return '';
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

/**
 * Encode value for vCard
 */
function encodeVCardValue(value) {
  if (!value) return '';
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

/**
 * Get all address books
 */
async function getAddressBooks() {
  const client = await getClient();
  const addressBooks = await client.fetchAddressBooks();
  return addressBooks.map(ab => ({
    url: ab.url,
    displayName: ab.displayName || 'Contacts'
  }));
}

/**
 * List contacts
 */
async function listContacts(count = 25) {
  const client = await getClient();
  const addressBooks = await client.fetchAddressBooks();

  const allContacts = [];

  for (const addressBook of addressBooks) {
    try {
      const vcards = await client.fetchVCards({ addressBook });

      for (const vcard of vcards) {
        const contact = parseVCard(vcard.data, vcard.url);
        if (contact && contact.displayName) {
          allContacts.push(contact);
        }
      }
    } catch (error) {
      console.error(`Error fetching from address book:`, error.message);
    }
  }

  // Sort by display name
  allContacts.sort((a, b) => a.displayName.localeCompare(b.displayName));

  return allContacts.slice(0, count);
}

/**
 * Search contacts
 */
async function searchContacts(query, count = 25) {
  // Bug fix: load ALL contacts before filtering (was only first count*2 = 50 by default,
  // which missed contacts later in alphabetical order)
  const allContacts = await listContacts(100000);
  const lowerQuery = query.toLowerCase();

  const matches = allContacts.filter(contact => {
    const searchText = [
      contact.displayName,
      contact.firstName,
      contact.lastName,
      contact.organization,
      ...contact.emails.map(e => e.value),
      ...contact.phones.map(p => p.value)
    ].join(' ').toLowerCase();

    return searchText.includes(lowerQuery);
  });

  return matches.slice(0, count);
}

/**
 * Get contact by URL
 */
async function getContact(contactUrl) {
  const client = await getClient();

  const vcard = await client.fetchVCards({
    addressBook: { url: contactUrl.substring(0, contactUrl.lastIndexOf('/') + 1) },
    objectUrls: [contactUrl]
  });

  if (vcard && vcard[0]) {
    return parseVCard(vcard[0].data, vcard[0].url);
  }

  throw new Error('Contact not found');
}

/**
 * Create a new contact
 */
async function createContact({ displayName, firstName, lastName, email, phone, organization, title, notes }) {
  const client = await getClient();
  const addressBooks = await client.fetchAddressBooks();

  if (addressBooks.length === 0) {
    throw new Error('No address book found');
  }

  const addressBook = addressBooks[0];
  const uid = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  let vcard = `BEGIN:VCARD
VERSION:3.0
UID:${uid}
FN:${encodeVCardValue(displayName || `${firstName || ''} ${lastName || ''}`.trim())}
N:${encodeVCardValue(lastName || '')};${encodeVCardValue(firstName || '')};;;`;

  if (email) {
    vcard += `\nEMAIL;TYPE=INTERNET:${encodeVCardValue(email)}`;
  }
  if (phone) {
    vcard += `\nTEL;TYPE=CELL:${encodeVCardValue(phone)}`;
  }
  if (organization) {
    vcard += `\nORG:${encodeVCardValue(organization)}`;
  }
  if (title) {
    vcard += `\nTITLE:${encodeVCardValue(title)}`;
  }
  if (notes) {
    vcard += `\nNOTE:${encodeVCardValue(notes)}`;
  }

  vcard += `\nEND:VCARD`;

  const result = await client.createVCard({
    addressBook,
    filename: `${uid}.vcf`,
    vCardString: vcard
  });

  return {
    success: true,
    uid,
    url: result?.url
  };
}

/**
 * Delete a contact
 */
async function deleteContact(contactUrl) {
  const client = await getClient();

  await client.deleteVCard({
    vCard: {
      url: contactUrl,
      etag: ''
    }
  });

  return { success: true };
}

module.exports = {
  getClient,
  clearClient,
  getAddressBooks,
  listContacts,
  searchContacts,
  getContact,
  createContact,
  deleteContact,
  parseVCard
};
