/**
 * Local Contacts Client
 * Accesses Contacts.app via AppleScript
 */

const { runAppleScript, runJXA, escapeAppleScript, escapeJXA } = require('../utils/applescript');
const config = require('../config');

/**
 * List contacts
 * @param {number} count - Number of contacts to retrieve
 * @returns {Promise<Array>} - List of contacts
 */
async function listContacts(count = 25) {
  const script = `
    const contacts = Application('Contacts');
    const people = contacts.people();
    let result = [];

    const limit = Math.min(${count}, people.length);
    for (let i = 0; i < limit; i++) {
      const person = people[i];
      try {
        const emails = person.emails();
        const phones = person.phones();

        let emailList = [];
        for (let e of emails) { emailList.push(e.value()); }
        let phoneList = [];
        for (let p of phones) { phoneList.push(p.value()); }

        result.push({
          id: person.id(),
          name: person.name() || '',
          firstName: person.firstName() || '',
          lastName: person.lastName() || '',
          organization: person.organization() || '',
          jobTitle: person.jobTitle() || '',
          emails: emailList,
          phones: phoneList,
          email: emailList.length > 0 ? emailList[0] : '',
          phone: phoneList.length > 0 ? phoneList[0] : ''
        });
      } catch (e) {}
    }

    JSON.stringify(result);
  `;

  const result = await runJXA(script);
  return result ? JSON.parse(result) : [];
}

/**
 * Search contacts
 * @param {string} query - Search query
 * @param {number} count - Max results
 * @returns {Promise<Array>} - Matching contacts
 */
async function searchContacts(query, count = 25) {
  const searchTerm = escapeJXA(query.toLowerCase());

  const script = `
    const contacts = Application('Contacts');
    const people = contacts.people();
    let result = [];

    for (let person of people) {
      if (result.length >= ${count}) break;

      try {
        const name = (person.name() || '').toLowerCase();
        const org = (person.organization() || '').toLowerCase();
        const emails = person.emails();
        const phones = person.phones();

        let emailMatch = false;
        for (let e of emails) {
          if (e.value().toLowerCase().includes("${searchTerm}")) {
            emailMatch = true;
            break;
          }
        }

        // Normalize: strip non-digits for phone comparison
        const searchDigits = "${searchTerm}".replace(/[^0-9]/g, '');
        let phoneMatch = false;
        for (let p of phones) {
          const phoneDigits = p.value().replace(/[^0-9]/g, '');
          if (p.value().includes("${searchTerm}") || (searchDigits.length >= 6 && phoneDigits.includes(searchDigits))) {
            phoneMatch = true;
            break;
          }
        }

        if (name.includes("${searchTerm}") || org.includes("${searchTerm}") || emailMatch || phoneMatch) {
          let emailList = [];
          for (let e of emails) { emailList.push(e.value()); }
          let phoneList = [];
          for (let p of phones) { phoneList.push(p.value()); }

          result.push({
            id: person.id(),
            name: person.name() || '',
            firstName: person.firstName() || '',
            lastName: person.lastName() || '',
            organization: person.organization() || '',
            jobTitle: person.jobTitle() || '',
            emails: emailList,
            phones: phoneList,
            email: emailList.length > 0 ? emailList[0] : '',
            phone: phoneList.length > 0 ? phoneList[0] : ''
          });
        }
      } catch (e) {}
    }

    JSON.stringify(result);
  `;

  const result = await runJXA(script);
  return result ? JSON.parse(result) : [];
}

/**
 * Read a specific contact
 * @param {string} contactId - Contact ID
 * @returns {Promise<Object>} - Contact details
 */
async function readContact(contactId) {
  const script = `
    const contacts = Application('Contacts');
    const person = contacts.people.byId("${escapeJXA(contactId)}");

    const emails = person.emails();
    const phones = person.phones();
    const addresses = person.addresses();

    let emailList = [];
    for (let e of emails) {
      emailList.push({ label: e.label() || 'email', value: e.value() });
    }

    let phoneList = [];
    for (let p of phones) {
      phoneList.push({ label: p.label() || 'phone', value: p.value() });
    }

    let addressList = [];
    for (let a of addresses) {
      addressList.push({
        label: a.label() || 'address',
        street: a.street() || '',
        city: a.city() || '',
        state: a.state() || '',
        zip: a.zip() || '',
        country: a.country() || ''
      });
    }

    JSON.stringify({
      id: person.id(),
      name: person.name() || '',
      firstName: person.firstName() || '',
      lastName: person.lastName() || '',
      organization: person.organization() || '',
      jobTitle: person.jobTitle() || '',
      department: person.department() || '',
      note: person.note() || '',
      birthday: person.birthDate() ? person.birthDate().toISOString() : null,
      emails: emailList,
      phones: phoneList,
      addresses: addressList
    });
  `;

  const result = await runJXA(script);
  return result ? JSON.parse(result) : null;
}

/**
 * Create a new contact
 * @param {Object} options - Contact options
 * @returns {Promise<Object>} - Created contact info
 */
async function createContact({ displayName, firstName, lastName, organization, jobTitle, email, phone, note }) {
  let properties = [];

  if (firstName) properties.push(`first name:"${escapeAppleScript(firstName)}"`);
  if (lastName) properties.push(`last name:"${escapeAppleScript(lastName)}"`);
  if (organization) properties.push(`organization:"${escapeAppleScript(organization)}"`);
  if (jobTitle) properties.push(`job title:"${escapeAppleScript(jobTitle)}"`);
  if (note) properties.push(`note:"${escapeAppleScript(note)}"`);

  let script = `
    tell application "Contacts"
      set newPerson to make new person with properties {${properties.join(', ')}}
  `;

  if (email) {
    script += `
      tell newPerson
        make new email at end of emails with properties {label:"work", value:"${escapeAppleScript(email)}"}
      end tell
    `;
  }

  if (phone) {
    script += `
      tell newPerson
        make new phone at end of phones with properties {label:"mobile", value:"${escapeAppleScript(phone)}"}
      end tell
    `;
  }

  script += `
      save
      return id of newPerson
    end tell
  `;

  const id = await runAppleScript(script);
  return { success: true, id, message: 'Contact created successfully' };
}

/**
 * Update a contact
 * @param {string} contactId - Contact ID
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>} - Result
 */
async function updateContact(contactId, { firstName, lastName, organization, jobTitle, email, phone, note }) {
  let updateCommands = [];

  if (firstName !== undefined) updateCommands.push(`set first name of thePerson to "${escapeAppleScript(firstName || '')}"`);
  if (lastName !== undefined) updateCommands.push(`set last name of thePerson to "${escapeAppleScript(lastName || '')}"`);
  if (organization !== undefined) updateCommands.push(`set organization of thePerson to "${escapeAppleScript(organization || '')}"`);
  if (jobTitle !== undefined) updateCommands.push(`set job title of thePerson to "${escapeAppleScript(jobTitle || '')}"`);
  if (note !== undefined) updateCommands.push(`set note of thePerson to "${escapeAppleScript(note || '')}"`);

  const script = `
    tell application "Contacts"
      set thePerson to person id "${escapeAppleScript(contactId)}"
      ${updateCommands.join('\n      ')}
      save
    end tell
    return "updated"
  `;

  await runAppleScript(script);
  return { success: true, message: 'Contact updated successfully' };
}

/**
 * Delete a contact
 * @param {string} contactId - Contact ID
 * @returns {Promise<Object>} - Result
 */
async function deleteContact(contactId) {
  const script = `
    tell application "Contacts"
      set thePerson to person id "${escapeAppleScript(contactId)}"
      delete thePerson
      save
    end tell
    return "deleted"
  `;

  await runAppleScript(script);
  return { success: true, message: 'Contact deleted successfully' };
}

/**
 * List all contact accounts (iCloud, Google, etc.)
 * @returns {Promise<Array>} - List of accounts
 */
async function listAccounts() {
  const script = `
    const contacts = Application('Contacts');
    const accounts = contacts.accounts();
    let result = [];

    for (let account of accounts) {
      try {
        const groups = account.groups();
        result.push({
          id: account.id(),
          name: account.name(),
          groupCount: groups.length
        });
      } catch (e) {
        result.push({
          id: account.id(),
          name: account.name(),
          groupCount: 0
        });
      }
    }

    JSON.stringify(result);
  `;

  const result = await runJXA(script);
  return result ? JSON.parse(result) : [];
}

/**
 * List contact groups
 * @param {string} accountId - Optional account ID to filter by
 * @returns {Promise<Array>} - List of groups
 */
async function listGroups(accountId = null) {
  const script = accountId ? `
    const contacts = Application('Contacts');
    const account = contacts.accounts.byId("${escapeJXA(accountId)}");
    const groups = account.groups();
    let result = [];

    for (let group of groups) {
      try {
        const people = group.people();
        result.push({
          id: group.id(),
          name: group.name(),
          accountId: "${escapeJXA(accountId)}",
          accountName: account.name(),
          contactCount: people.length
        });
      } catch (e) {}
    }

    JSON.stringify(result);
  ` : `
    const contacts = Application('Contacts');
    const accounts = contacts.accounts();
    let result = [];

    for (let account of accounts) {
      try {
        const groups = account.groups();
        for (let group of groups) {
          try {
            const people = group.people();
            result.push({
              id: group.id(),
              name: group.name(),
              accountId: account.id(),
              accountName: account.name(),
              contactCount: people.length
            });
          } catch (e) {}
        }
      } catch (e) {}
    }

    JSON.stringify(result);
  `;

  const result = await runJXA(script);
  return result ? JSON.parse(result) : [];
}

module.exports = {
  listContacts,
  searchContacts,
  readContact,
  createContact,
  updateContact,
  deleteContact,
  listAccounts,
  listGroups
};
