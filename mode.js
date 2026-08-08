/**
 * Mode management module
 *
 * Manages the current operating mode (local vs cloud)
 * Separate module to avoid circular dependencies
 */

const config = require('./config');

// Initial mode based on config
let currentMode = (config.USE_LOCAL_MODE && config.IS_MACOS) ? 'local' : 'cloud';

// Listeners notified after a successful mode change. The server uses this to
// emit notifications/tools/list_changed, since the mode decides which tools work.
const listeners = new Set();

/**
 * Subscribe to mode changes.
 * @param {() => void} fn
 * @returns {() => void} - Unsubscribe
 */
function onModeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Get current mode
 * @returns {'local' | 'cloud'}
 */
function getMode() {
  return currentMode;
}

/**
 * Set current mode
 * @param {'local' | 'cloud'} mode
 */
function setMode(mode) {
  if (mode !== 'local' && mode !== 'cloud') {
    throw new Error('Mode must be "local" or "cloud"');
  }

  if (mode === 'local' && !config.IS_MACOS) {
    throw new Error('Local mode only available on macOS');
  }

  currentMode = mode;
  console.error(`[icloud-mcp] Mode changed to: ${mode}`);

  for (const fn of listeners) {
    try {
      fn(mode);
    } catch (error) {
      console.error('[icloud-mcp] Mode listener failed:', error.message);
    }
  }
}

/**
 * Check if currently in local mode
 * @returns {boolean}
 */
function isLocalMode() {
  return currentMode === 'local';
}

/**
 * Check if currently in cloud mode
 * @returns {boolean}
 */
function isCloudMode() {
  return currentMode === 'cloud';
}

module.exports = {
  getMode,
  setMode,
  isLocalMode,
  isCloudMode,
  onModeChange
};
