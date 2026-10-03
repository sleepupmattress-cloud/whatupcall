const input = document.getElementById('url');
chrome.storage.sync.get('dialerUrl').then(({ dialerUrl }) => { input.value = dialerUrl || ''; });
document.getElementById('save').addEventListener('click', async () => {
  await chrome.storage.sync.set({ dialerUrl: input.value.trim() });
  const s = document.getElementById('saved');
  s.hidden = false; setTimeout(() => { s.hidden = true; }, 1500);
});
