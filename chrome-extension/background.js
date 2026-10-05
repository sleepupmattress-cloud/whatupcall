// Change this once, or set it per-browser from the extension's Options page.
const DEFAULT_DIALER_URL = 'https://dialer.sleepupmattress.com';

async function dialerUrl() {
  const { dialerUrl } = await chrome.storage.sync.get('dialerUrl');
  return (dialerUrl || DEFAULT_DIALER_URL).replace(/\/+$/, '');
}

// An already-open dialer (popup or normal tab, e.g. http://localhost:3100/)
async function findDialerTab(base) {
  const { dialerWin } = await chrome.storage.session.get('dialerWin');
  if (dialerWin) {
    try {
      const [tab] = await chrome.tabs.query({ windowId: dialerWin });
      if (tab) return tab;
    } catch (e) { /* window was closed */ }
  }
  try {
    const [tab] = await chrome.tabs.query({ url: `${base}/*` });
    if (tab) return tab;
  } catch (e) { /* no host permission for this dialer URL */ }
  return null;
}

// Reuses one dialer. Only the #hash changes, so an ongoing call is never reloaded.
// call=true makes the dialer start the WhatsApp call by itself.
async function openDialer(to = '', name = '', call = false) {
  const base = await dialerUrl();
  const params = new URLSearchParams({ to: String(to).replace(/[^\d+]/g, ''), name, t: Date.now() });
  if (call && to) params.set('call', '1');
  const url = `${base}/#${params}`;
  const tab = await findDialerTab(base);
  if (tab) {
    await chrome.tabs.update(tab.id, { url, active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return;
  }
  const win = await chrome.windows.create({ url, type: 'popup', width: 420, height: 780 });
  await chrome.storage.session.set({ dialerWin: win.id });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'wa-call', title: 'Call "%s" on WhatsApp', contexts: ['selection'] });
});
chrome.contextMenus.onClicked.addListener(info => {
  if (info.menuItemId === 'wa-call') openDialer(info.selectionText, '', true);
});
chrome.action.onClicked.addListener(() => openDialer());
chrome.runtime.onMessage.addListener(msg => {
  if (msg && msg.type === 'open-dialer') openDialer(msg.to, msg.name || '', !!msg.call);
});
chrome.windows.onRemoved.addListener(async id => {
  const { dialerWin } = await chrome.storage.session.get('dialerWin');
  if (id === dialerWin) chrome.storage.session.remove('dialerWin');
});
