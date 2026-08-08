/**
 * Local Safari Client
 * Accesses Safari.app via AppleScript
 */

const { runAppleScript, runJXA, escapeAppleScript, escapeJXA, asInt } = require('../utils/applescript');

/**
 * List all open tabs across all windows
 * @returns {Promise<Array>} - List of tabs
 */
async function listTabs() {
  const script = `
    const safari = Application('Safari');
    const windows = safari.windows();
    let tabs = [];

    for (let i = 0; i < windows.length; i++) {
      const win = windows[i];
      try {
        const winTabs = win.tabs();
        for (let j = 0; j < winTabs.length; j++) {
          const tab = winTabs[j];
          tabs.push({
            windowIndex: i,
            tabIndex: j,
            name: tab.name(),
            url: tab.url(),
            isCurrent: win.currentTab().index() === tab.index()
          });
        }
      } catch (e) {}
    }

    JSON.stringify(tabs);
  `;

  const result = await runJXA(script);
  return result ? JSON.parse(result) : [];
}

/**
 * Get the current/active tab URL
 * @returns {Promise<Object>} - Current tab info
 */
async function getCurrentUrl() {
  const script = `
    const safari = Application('Safari');
    const frontWindow = safari.windows[0];
    const currentTab = frontWindow.currentTab();

    JSON.stringify({
      name: currentTab.name(),
      url: currentTab.url(),
      source: currentTab.source ? currentTab.source().substring(0, 1000) : null
    });
  `;

  const result = await runJXA(script);
  return result ? JSON.parse(result) : null;
}

/**
 * Open a URL in a new tab
 * @param {string} url - URL to open
 * @param {boolean} inNewWindow - Open in new window instead of new tab
 * @returns {Promise<Object>} - Result
 */
async function openUrl(url, inNewWindow = false) {
  // Ensure URL has protocol
  let fullUrl = url;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    fullUrl = 'https://' + url;
  }

  if (inNewWindow) {
    const script = `
      tell application "Safari"
        make new document with properties {URL:"${escapeAppleScript(fullUrl)}"}
        activate
      end tell
      return "opened"
    `;
    await runAppleScript(script);
  } else {
    const script = `
      tell application "Safari"
        tell front window
          set newTab to make new tab with properties {URL:"${escapeAppleScript(fullUrl)}"}
          set current tab to newTab
        end tell
        activate
      end tell
      return "opened"
    `;
    await runAppleScript(script);
  }

  return { success: true, message: `Opened ${fullUrl}` };
}

/**
 * Close a tab
 * @param {number} windowIndex - Window index
 * @param {number} tabIndex - Tab index
 * @returns {Promise<Object>} - Result
 */
async function closeTab(windowIndex = 0, tabIndex = null) {
  if (tabIndex !== null && tabIndex !== undefined) {
    const script = `
      tell application "Safari"
        tell window ${asInt(windowIndex, 0) + 1}
          close tab ${asInt(tabIndex, 0) + 1}
        end tell
      end tell
      return "closed"
    `;
    await runAppleScript(script);
  } else {
    // Close current tab
    const script = `
      tell application "Safari"
        tell front window
          close current tab
        end tell
      end tell
      return "closed"
    `;
    await runAppleScript(script);
  }

  return { success: true, message: 'Tab closed' };
}

/**
 * Get the reading list items
 * Note: This requires parsing Safari's bookmarks plist
 * @returns {Promise<Array>} - Reading list items
 */
async function getReadingList() {
  // Reading list is stored in ~/Library/Safari/Bookmarks.plist
  // This requires parsing a binary plist which is complex
  // For now, return a note about this limitation
  return {
    message: 'Reading list access requires parsing Safari bookmarks plist. Use Safari directly for reading list management.',
    items: []
  };
}

module.exports = {
  listTabs,
  getCurrentUrl,
  openUrl,
  closeTab,
  getReadingList
};
