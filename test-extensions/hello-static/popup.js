chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  document.getElementById('url').textContent = tab ? tab.url : 'unknown';
});
chrome.storage.local.get({ clicks: 0 }, ({ clicks }) => {
  document.getElementById('clicks').textContent = clicks;
});
document.getElementById('newtab').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://example.com' });
});
document.getElementById('options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});
