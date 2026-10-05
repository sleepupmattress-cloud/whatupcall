// Change this once, or set it per-browser from the extension's Options page.
const DEFAULT_DIALER_URL = 'https://call.sleepupmattress.com';

async function dialerUrl() {
  const { dialerUrl } = await chrome.storage.sync.get('dialerUrl');
  return (dialerUrl || DEFAULT_DIALER_URL).replace(/\/+$/, '');
}

// Reuses one dialer popup. Only the #hash changes, so an ongoing call is never reloaded.
async function openDialer(to = '', name = '') {
  const params = new URLSearchParams({ to: String(to).replace(/[^\d+]/g, ''), name, t: Date.now() });
  const url = `${await dialerUrl()}/#${params}`;
  const { dialerWin } = await chrome.storage.session.get('dialerWin');
  if (dialerWin) {
    try {
      const [tab] = await chrome.tabs.query({ windowId: dialerWin });
      if (tab) {
        await chrome.tabs.update(tab.id, { url });
        await chrome.windows.update(dialerWin, { focused: true });
        return;
      }
    } catch (e) { /* window was closed */ }
  }
  const win = await chrome.windows.create({ url, type: 'popup', width: 420, height: 780 });
  await chrome.storage.session.set({ dialerWin: win.id });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'wa-call', title: 'Call "%s" on WhatsApp', contexts: ['selection'] });
});
chrome.contextMenus.onClicked.addListener(info => {
  if (info.menuItemId === 'wa-call') openDialer(info.selectionText);
});
chrome.action.onClicked.addListener(() => openDialer());
chrome.runtime.onMessage.addListener(msg => {
  if (msg && msg.type === 'open-dialer') openDialer(msg.to, msg.name || '');
});
chrome.windows.onRemoved.addListener(async id => {
  const { dialerWin } = await chrome.storage.session.get('dialerWin');
  if (id === dialerWin) chrome.storage.session.remove('dialerWin');
});
