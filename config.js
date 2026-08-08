/**
 * iCloud MCP Configuration
 * Centralized configuration for all iCloud services
 */

// Load .env from the module dir, not the cwd — MCP clients like Claude
// Desktop launch the server from an arbitrary working directory (issue #3)
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

module.exports = {
  // Mode flags
  USE_TEST_MODE: process.env.USE_TEST_MODE === 'true',
  USE_LOCAL_MODE: process.env.USE_LOCAL_MODE !== 'false', // Default to true (local mode)

  // Check if running on macOS (required for local mode)
  IS_MACOS: process.platform === 'darwin',

  // iCloud credentials
  ICLOUD_EMAIL: process.env.ICLOUD_EMAIL,
  ICLOUD_APP_PASSWORD: process.env.ICLOUD_APP_PASSWORD,

  // IMAP settings for iCloud Mail
  IMAP: {
    HOST: 'imap.mail.me.com',
    PORT: 993,
    TLS: true,
    AUTH_TIMEOUT: 10000,
    CONN_TIMEOUT: 30000
  },

  // SMTP settings for sending mail
  SMTP: {
    HOST: 'smtp.mail.me.com',
    PORT: 587,
    SECURE: false  // Uses STARTTLS
  },

  // CalDAV settings for Calendar
  CALDAV: {
    SERVER_URL: 'https://caldav.icloud.com',
    // Principal URL will be discovered during auth
    AUTH_METHOD: 'Basic'
  },

  // CardDAV settings for Contacts
  CARDDAV: {
    SERVER_URL: 'https://contacts.icloud.com',
    AUTH_METHOD: 'Basic'
  },

  // Default settings
  DEFAULTS: {
    TIMEZONE: 'Europe/Madrid',
    PAGE_SIZE: 25,
    MAX_RESULTS: 50,
    EMAIL_BODY_MAX_LENGTH: 50000,
    DATE_FORMAT: 'es-ES'
  },

  // Email folder mappings
  EMAIL_FOLDERS: {
    inbox: 'INBOX',
    sent: 'Sent Messages',
    drafts: 'Drafts',
    trash: 'Deleted Messages',
    archive: 'Archive',
    junk: 'Junk'
  }
};
