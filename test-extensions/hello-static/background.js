// Runs as an MV3 service worker. Exercises the parts of the extension
// platform that electron-chrome-extensions bridges for us.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'hello-static',
    title: 'Hello Static: say hi to this page',
    contexts: ['page', 'selection', 'link'],
  });
  chrome.action.setBadgeText({ text: 'hi' });
  chrome.action.setBadgeBackgroundColor({ color: '#1a73e8' });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  chrome.storage.local.get({ clicks: 0 }, ({ clicks }) => {
    chrome.storage.local.set({ clicks: clicks + 1, lastUrl: info.pageUrl });
    chrome.action.setBadgeText({ text: String(clicks + 1) });
  });
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError) return;
    console.log('[hello-static] active tab:', tab && tab.url);
  });
});
