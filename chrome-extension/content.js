// Floating "WhatsApp call" button on TeleCRM pages.
(() => {
  if (window.__sudWaCall) return;
  window.__sudWaCall = true;

  const PHONE_RE = /(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g;
  const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25c1.1.37 2.33.57 3.6.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg>';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sud-wa-btn';
  btn.title = 'Call this lead on WhatsApp';
  btn.innerHTML = `${ICON}<span>WhatsApp call</span>`;

  const menu = document.createElement('div');
  menu.className = 'sud-wa-menu';
  menu.hidden = true;
  document.documentElement.append(btn, menu);

  let lastSelection = '';
  btn.addEventListener('mousedown', () => { lastSelection = String(window.getSelection() || ''); });

  const ten = s => {
    let d = String(s || '').replace(/\D/g, '');
    if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
    if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
    return /^[6-9]\d{9}$/.test(d) ? d : null;
  };

  function findNumbers() {
    const found = new Set();
    const sel = ten(lastSelection);
    if (sel) found.add(sel);
    document.querySelectorAll('a[href^="tel:"]').forEach(a => { const d = ten(a.getAttribute('href')); if (d) found.add(d); });
    const text = (document.querySelector('main') || document.body).innerText || '';
    for (const m of text.matchAll(PHONE_RE)) {
      const d = ten(m[0]);
      if (d) found.add(d);
      if (found.size >= 6) break;
    }
    return [...found].slice(0, 6);
  }

  function open(to, name = '') {
    menu.hidden = true;
    chrome.runtime.sendMessage({ type: 'open-dialer', to: to ? '91' + to : '', name, call: !!to });
  }

  function showMenu(nums) {
    menu.textContent = '';
    const p = document.createElement('p');
    p.textContent = nums.length ? 'Which number?' : 'No mobile number found on this page.';
    menu.append(p);
    nums.forEach(n => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = `+91 ${n.slice(0, 5)} ${n.slice(5)}`;
      b.addEventListener('click', () => open(n));
      menu.append(b);
    });
    const typeBtn = document.createElement('button');
    typeBtn.type = 'button';
    typeBtn.className = 'sud-wa-type';
    typeBtn.textContent = 'Open dialer and type a number';
    typeBtn.addEventListener('click', () => open(''));
    menu.append(typeBtn);
    menu.hidden = false;
  }

  btn.addEventListener('click', () => {
    const nums = findNumbers();
    if (nums.length === 1) open(nums[0]); else showMenu(nums);
  });
  document.addEventListener('click', e => {
    if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) menu.hidden = true;
  }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') menu.hidden = true; });

  // "WA CALL" next to TeleCRM's own CALL action: dials this lead on WhatsApp directly.
  const isCallAction = el => (el.textContent || '').trim().toUpperCase() === 'CALL';

  function leadFrom(bar) {
    // Walk up from the action bar until we reach the lead card that holds the phone number
    for (let el = bar; el && el !== document.body; el = el.parentElement) {
      const text = el.innerText || '';
      for (const m of text.matchAll(PHONE_RE)) {
        const d = ten(m[0]);
        if (d) return { to: d, name: (text.split('\n').map(s => s.trim()).find(Boolean) || '').slice(0, 80) };
      }
    }
    return null;
  }

  function injectBarButtons() {
    for (const el of document.querySelectorAll('button, [role="button"], div, span')) {
      if (el.childElementCount > 3 || !isCallAction(el)) continue;
      // Use the outermost element whose text is just "CALL" (icon + label wrapper)
      let action = el;
      while (action.parentElement && isCallAction(action.parentElement)) action = action.parentElement;
      if (action.dataset.sudWa || action.parentElement?.querySelector(':scope > .sud-wa-inline')) continue;
      action.dataset.sudWa = '1';
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sud-wa-inline';
      b.title = 'Call this lead on WhatsApp now';
      b.innerHTML = `${ICON}<span>WA CALL</span>`;
      b.addEventListener('click', e => {
        e.preventDefault(); e.stopPropagation();
        const lead = leadFrom(action.parentElement);
        if (lead) open(lead.to, lead.name); else showMenu(findNumbers());
      });
      action.after(b);
    }
  }
  let scanT;
  new MutationObserver(() => { clearTimeout(scanT); scanT = setTimeout(injectBarButtons, 300); })
    .observe(document.body, { childList: true, subtree: true });
  injectBarButtons();
})();
