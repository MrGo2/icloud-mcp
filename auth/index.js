/**
 * Auth module for iCloud MCP
 * Handles credential management and authentication status
 */

const config = require('../config');
const { formatSuccess, formatError } = require('../utils/error-handler');

/**
 * Check if credentials are configured
 */
function hasCredentials() {
  return !!(config.ICLOUD_EMAIL && config.ICLOUD_APP_PASSWORD);
}

/**
 * Get credentials for use in clients
 */
function getCredentials() {
  if (!hasCredentials()) {
    throw new Error('UNAUTHORIZED');
  }

  return {
    email: config.ICLOUD_EMAIL,
    password: config.ICLOUD_APP_PASSWORD
  };
}

/**
 * Handler: About this server
 */
async function handleAbout() {
  return formatSuccess(
    `iCloud MCP Server v1.0.0

Provides Claude with access to iCloud services:
- Email (via IMAP/SMTP)
- Calendar (via CalDAV)
- Contacts (via CardDAV)

Authentication: App-specific password
Status: ${hasCredentials() ? 'Credentials configured' : 'Credentials NOT configured'}

Setup instructions:
1. Go to https://appleid.apple.com
2. Sign in → Security → App-Specific Passwords
3. Generate a new password named "iCloud MCP"
4. Copy to .env file as ICLOUD_APP_PASSWORD`
  );
}

/**
 * Handler: Check authentication status
 */
async function handleCheckAuthStatus() {
  if (config.USE_LOCAL_MODE && config.IS_MACOS) {
    return formatSuccess(
      `Authentication status: OK (Local Mode)

Mode: Local (AppleScript)
Platform: macOS

Services available:
- Email (Mail.app)
- Calendar (Calendar.app)
- Contacts (Contacts.app)
- Reminders (Reminders.app)
- Notes (Notes.app)
- Messages (Messages.app)
- Safari (Safari.app)`
    );
  }

  if (!hasCredentials()) {
    return formatError(new Error('UNAUTHORIZED'));
  }

  return formatSuccess(
    `Authentication status: OK

Email: ${config.ICLOUD_EMAIL}
Password: ****-****-****-**** (configured)

Services available:
- Email (IMAP/SMTP)
- Calendar (CalDAV)
- Contacts (CardDAV)`
  );
}

// Tool definitions
const authTools = [
  {
    name: 'about',
    description: 'Returns information about this iCloud MCP server',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    },
    handler: handleAbout
  },
  {
    name: 'check-auth-status',
    description: 'Check if iCloud credentials are configured correctly',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    },
    handler: handleCheckAuthStatus
  }
];

module.exports = {
  authTools,
  hasCredentials,
  getCredentials,
  handleAbout,
  handleCheckAuthStatus
};
