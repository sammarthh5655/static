function refresh() {
  chrome.storage.local.get({ clicks: 0, lastUrl: '—' }, ({ clicks, lastUrl }) => {
    document.getElementById('clicks').textContent = clicks;
    document.getElementById('last').textContent = lastUrl;
  });
}
document.getElementById('reset').addEventListener('click', () => {
  chrome.storage.local.set({ clicks: 0 }, () => {
    chrome.action.setBadgeText({ text: 'hi' });
    refresh();
  });
});
refresh();
