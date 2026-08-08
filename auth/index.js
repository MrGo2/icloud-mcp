/**
 * Auth module for iCloud MCP
 * Handles credential management and authentication status
 */

const { z } = require('zod');
const config = require('../config');
const { formatSuccess, formatError } = require('../utils/error-handler');
const { getMode, setMode, isLocalMode } = require('../mode');

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
  const mode = getMode();
  const localServices = 'Email, Calendar, Contacts, Reminders, Notes, Messages, Safari';
  const cloudServices = 'Email, Calendar, Contacts';

  return formatSuccess(
    `iCloud MCP Server v2.1.0

Mode: ${mode.toUpperCase()}
Services: ${mode === 'local' ? localServices : cloudServices}

${mode === 'local' ? 'Using AppleScript to access macOS apps directly.' : 'Using iCloud protocols (IMAP, CalDAV, CardDAV).'}

Credentials: ${hasCredentials() ? 'Configured' : 'Not configured (needed for cloud mode)'}

Use 'set-mode' tool to switch between LOCAL and CLOUD modes.`
  );
}

/**
 * Handler: Check authentication status
 */
async function handleCheckAuthStatus() {
  const mode = getMode();

  if (mode === 'cloud' && !hasCredentials()) {
    return formatError(new Error('UNAUTHORIZED - Cloud mode requires credentials'));
  }

  if (mode === 'local') {
    return formatSuccess(
      `Authentication status: OK (Local Mode)

Mode: LOCAL (AppleScript)
Credentials: ${hasCredentials() ? 'Configured (for cloud)' : 'Not needed for local mode'}

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

  return formatSuccess(
    `Authentication status: OK (Cloud Mode)

Mode: CLOUD (iCloud protocols)
Email: ${config.ICLOUD_EMAIL}
Password: ****-****-****-**** (configured)

Services available:
- Email (IMAP/SMTP)
- Calendar (CalDAV)
- Contacts (CardDAV)`
  );
}

/**
 * Handler: Set mode (local or cloud)
 */
async function handleSetMode(args) {
  const { mode } = args;

  if (!mode) {
    return formatError(new Error('Mode is required. Use "local" or "cloud".'));
  }

  if (mode !== 'local' && mode !== 'cloud') {
    return formatError(new Error('Invalid mode. Use "local" or "cloud".'));
  }

  if (mode === 'local' && !config.IS_MACOS) {
    return formatError(new Error('Local mode only available on macOS.'));
  }

  if (mode === 'cloud' && !hasCredentials()) {
    return formatError(new Error('Cloud mode requires iCloud credentials. Set ICLOUD_EMAIL and ICLOUD_APP_PASSWORD.'));
  }

  const previousMode = getMode();

  if (previousMode === mode) {
    return formatSuccess(`Already in ${mode.toUpperCase()} mode.`);
  }

  setMode(mode);

  const services = mode === 'local'
    ? 'Email, Calendar, Contacts, Reminders, Notes, Messages, Safari'
    : 'Email, Calendar, Contacts';

  return formatSuccess(
    `Mode changed: ${previousMode.toUpperCase()} → ${mode.toUpperCase()}

Services now available: ${services}`
  );
}

// Tool definitions
const authTools = [
  {
    name: 'about',
    title: 'About This Server',
    description: 'Returns information about this iCloud MCP server',
    inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    handler: handleAbout
  },
  {
    name: 'check-auth-status',
    title: 'Check Auth Status',
    description: 'Check if iCloud credentials are configured correctly',
    inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    handler: handleCheckAuthStatus
  },
  {
    name: 'set-mode',
    title: 'Switch Mode',
    description: 'Switch between LOCAL (AppleScript/macOS apps) and CLOUD (iCloud protocols) modes',
    inputSchema: {
      mode: z.enum(['local', 'cloud'])
        .describe('Mode to activate: "local" for AppleScript access to macOS apps, "cloud" for iCloud protocols')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: handleSetMode
  }
];

module.exports = {
  authTools,
  hasCredentials,
  getCredentials,
  handleAbout,
  handleCheckAuthStatus,
  handleSetMode
};
