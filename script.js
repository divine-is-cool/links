// /divine/sites/script.js
// Link Portal client: fetch links, claim handling, and admin panel triggered via Konami-like sequence.
// Server API endpoints (suggested):
//  GET  /divine/api/sites/links             -> 200 JSON: [{ id, title, links: [{ id, name, url }] }, ...]
//  POST /divine/api/sites/claim             -> body { id }  -> 200 { ok:true, url } OR 429 { ok:false, retryAfter } OR 404
//  POST /divine/admin/sites/verify-pin      -> body { pin } -> 200 if correct, 401 if wrong
//  POST /divine/admin/sites/add-folder      -> body { title } -> 200 { ok:true, id }
//  POST /divine/admin/sites/remove-folder   -> body { id } -> 200 { ok:true }
//  POST /divine/admin/sites/add-link        -> body { folderId, name, url } -> 200 { ok:true }
//  POST /divine/admin/sites/remove-link     -> body { id } -> 200 { ok:true }
//  POST /divine/admin/sites/clear-my-timer  -> body {} -> 200 { ok:true }

(function () {
  const API_BASE = '/divine/api/sites';
  const ADMIN_BASE = '/divine/admin/sites';
  const LINKS_API = API_BASE + '/links';
  const CLAIM_API = API_BASE + '/claim';
  const PIN_API = ADMIN_BASE + '/verify-pin';
  const ADD_FOLDER_API = ADMIN_BASE + '/add-folder';
  const REMOVE_FOLDER_API = ADMIN_BASE + '/remove-folder';
  const ADD_LINK_API = ADMIN_BASE + '/add-link';
  const REMOVE_LINK_API = ADMIN_BASE + '/remove-link';
  const CLEAR_TIMER_API = ADMIN_BASE + '/clear-my-timer';

  // Konami-like sequence
  const SEQUENCE = ['ArrowUp','ArrowUp','ArrowDown','ArrowDown','ArrowLeft','ArrowRight','ArrowLeft','ArrowRight','b','a','Enter'];
  let seqProgress = 0;

  // Admin lock/attempt storage keys
  const ATTEMPTS_KEY = 'divine.sites.admin.attempts'; // session
  const LOCK_UNTIL_KEY = 'divine.sites.admin.lockUntil'; // local (ms epoch)

  // DOM
  const linksArea = document.getElementById('links-area');

  // helpers
  function elt(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) Object.keys(props).forEach(k => {
      if (k === 'class') el.className = props[k];
      else if (k === 'html') el.innerHTML = props[k];
      else el.setAttribute(k, props[k]);
    });
    children.forEach(c => { if (c != null) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }
  function nowMs() { return Date.now(); }

  // --- Konami detector ---
  window.addEventListener('keydown', (ev) => {
    const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
    const expected = SEQUENCE[seqProgress];
    const expectedNorm = expected.length === 1 ? expected.toLowerCase() : expected;
    if (key === expectedNorm) {
      seqProgress++;
      if (seqProgress >= SEQUENCE.length) {
        seqProgress = 0;
        triggerAdmin();
      }
    } else {
      seqProgress = (key === (SEQUENCE[0].length === 1 ? SEQUENCE[0].toLowerCase() : SEQUENCE[0])) ? 1 : 0;
    }
  }, true);

  // --- Fetch and render links ---
  async function fetchLinks() {
    linksArea.innerHTML = '';
    linksArea.appendChild(elt('div', { class: 'loading' }, 'Loading links…'));
    try {
      const res = await fetch(LINKS_API, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('fetch failed');
      const data = await res.json();
      renderLinks(data);
    } catch (e) {
      // leave existing content if server injected HTML; otherwise show error
      linksArea.innerHTML = '';
      linksArea.appendChild(elt('div', { class: 'notice' }, 'Failed to load links. Try refreshing.'));
    }
  }

  function renderLinks(folders) {
    linksArea.innerHTML = '';
    if (!Array.isArray(folders) || folders.length === 0) {
      linksArea.appendChild(elt('div', { class: 'notice' }, 'No links available.'));
      return;
    }
    folders.forEach(folder => {
      const f = elt('div', { class: 'folder', role: 'group', 'aria-label': folder.title || 'Folder' });
      f.appendChild(elt('h3', {}, folder.title || 'Untitled'));
      (folder.links || []).forEach(link => {
        const row = elt('div', { class: 'link-row' });
        const meta = elt('div', { class: 'link-meta' });
        meta.appendChild(elt('div', { class: 'link-name' }, link.name || 'Unnamed'));
        meta.appendChild(elt('div', { class: 'link-url' }, link.url));
        const btn = elt('button', { class: 'visit-btn', type: 'button', 'aria-label': `Visit ${link.name}` }, 'Visit');
        btn.addEventListener('click', () => onClaim(link, btn));
        row.appendChild(meta);
        row.appendChild(btn);
        f.appendChild(row);
      });
      linksArea.appendChild(f);
    });
  }

  // --- Claim handling ---
  async function onClaim(link, btn) {
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
      const res = await fetch(CLAIM_API, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: link.id })
      });
      if (res.status === 200) {
        const j = await res.json();
        if (j && j.ok && j.url) {
          // redirect to target
          location.href = j.url;
          return;
        }
        showTemporaryNotice('Unexpected server response.');
      } else if (res.status === 429) {
        const j = await res.json().catch(() => ({}));
        const retry = j && j.retryAfter ? j.retryAfter : 7 * 24 * 3600;
        showTemporaryNotice(`Claim locked. Try again in ${Math.ceil(retry / 60)} minutes.`);
        btn.textContent = 'Locked';
      } else if (res.status === 404) {
        showTemporaryNotice('Link not found (removed). Refreshing…', 3000);
        setTimeout(fetchLinks, 1000);
      } else {
        showTemporaryNotice('Server error. Try again later.');
      }
    } catch (err) {
      showTemporaryNotice('Network error. Check your connection.');
    } finally {
      setTimeout(() => {
        try { btn.disabled = false; btn.textContent = orig; } catch (e) {}
      }, 700);
    }
  }

  function showTemporaryNotice(msg, timeMs = 5000) {
    const n = elt('div', { class: 'notice' }, msg);
    linksArea.prepend(n);
    setTimeout(() => n.remove(), timeMs);
  }

  // --- Admin trigger / flow ---
  function getAttempts() { return parseInt(sessionStorage.getItem(ATTEMPTS_KEY) || '0', 10); }
  function setAttempts(n) { sessionStorage.setItem(ATTEMPTS_KEY, String(n)); }
  function getLockUntil() { return parseInt(localStorage.getItem(LOCK_UNTIL_KEY) || '0', 10); }
  function setLockUntil(ms) { localStorage.setItem(LOCK_UNTIL_KEY, String(ms)); }

  function triggerAdmin() {
    const lock = getLockUntil();
    if (lock && lock > nowMs()) {
      const secs = Math.ceil((lock - nowMs()) / 1000);
      showTemporaryNotice(`Admin locked. Try again in ${secs} seconds.`);
      return;
    }
    openAdminModal();
  }

  // --- Admin modal UI ---
  function openAdminModal() {
    // overlay
    const overlay = elt('div', { class: 'admin-overlay', role: 'dialog', 'aria-modal': 'true' });
    const modal = elt('div', { class: 'admin-modal' });
    overlay.appendChild(modal);

    modal.appendChild(elt('h2', {}, 'Link Portal — Admin'));
    modal.appendChild(elt('div', { class: 'muted' }, 'Enter ADMIN PIN to manage folders and links.'));

    // PIN row
    const pinRow = elt('div', { class: 'form-row' });
    const pinInput = elt('input', { type: 'password', placeholder: 'ADMIN PIN', 'aria-label': 'Admin PIN' });
    const verifyBtn = elt('button', { class: 'link-btn', type: 'button' }, 'Verify');
    pinRow.appendChild(pinInput);
    pinRow.appendChild(verifyBtn);
    modal.appendChild(pinRow);

    const status = elt('div', { class: 'notice', style: 'display:none;' }, '');
    modal.appendChild(status);

    // Admin area (hidden until verified)
    const adminArea = elt('div', { style: 'display:none;' });

    // close overlay when clicking backdrop
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
    pinInput.focus();

    verifyBtn.addEventListener('click', () => verifyPin(pinInput.value, status, pinRow, adminArea));
    pinInput.addEventListener('keyup', (e) => { if (e.key === 'Enter') verifyBtn.click(); });
  }

  async function verifyPin(pin, statusEl, pinRowEl, adminAreaEl) {
    const lockUntil = getLockUntil();
    if (lockUntil && lockUntil > nowMs()) {
      const left = Math.ceil((lockUntil - nowMs())/1000);
      statusEl.style.display = '';
      statusEl.textContent = `Locked for ${left}s`;
      return;
    }

    try {
      statusEl.style.display = '';
      statusEl.textContent = 'Verifying…';
      const res = await fetch(PIN_API, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin })
      });
      if (res.status === 200) {
        // success: show admin UI
        statusEl.style.display = 'none';
        pinRowEl.style.display = 'none';
        await showAdminUI(adminAreaEl || (pinRowEl.parentElement.appendChild(document.createElement('div'))));
        adminAreaEl.style.display = '';
        // insert adminArea if not already present
        if (!pinRowEl.parentElement.querySelector('.admin-ui')) {
          adminAreaEl.className = 'admin-ui';
          pinRowEl.parentElement.appendChild(adminAreaEl);
        }
      } else {
        // failure: increment attempts
        let attempts = getAttempts() + 1;
        setAttempts(attempts);
        statusEl.style.display = '';
        statusEl.textContent = `Incorrect PIN — attempt ${attempts} of 3.`;
        if (attempts >= 3) {
          lockAdminDueToFailures(statusEl);
        }
      }
    } catch (err) {
      statusEl.style.display = '';
      statusEl.textContent = 'Network error verifying PIN.';
    }
  }

  function lockAdminDueToFailures(statusEl) {
    const until = nowMs() + 60 * 1000;
    setLockUntil(until);
    sessionStorage.setItem(ATTEMPTS_KEY, '0');
    // show countdown
    statusEl.style.display = '';
    const iv = setInterval(() => {
      const left = Math.max(0, Math.ceil((getLockUntil() - nowMs())/1000));
      statusEl.textContent = `Too many failed attempts. Locked for ${left} seconds.`;
      if (left <= 0) {
        clearInterval(iv);
        statusEl.style.display = 'none';
        setLockUntil(0);
      }
    }, 500);
  }

  // --- Admin UI after verification ---
  async function showAdminUI(container) {
    container.innerHTML = '';
    const h = elt('h3', {}, 'Management');
    container.appendChild(h);

    // load current folders
    let folders = await loadFolders();

    const listWrap = elt('div', {});
    container.appendChild(listWrap);

    function renderList() {
      listWrap.innerHTML = '';
      if (!Array.isArray(folders) || folders.length === 0) {
        listWrap.appendChild(elt('div', { class: 'muted' }, 'No folders.'));
      } else {
        folders.forEach(folder => {
          const f = elt('div', { class: 'folder' });
          f.appendChild(elt('h4', {}, folder.title));
          const removeFolder = elt('button', { class: 'link-btn danger', type: 'button' }, 'Remove Folder');
          removeFolder.addEventListener('click', async () => {
            if (!confirm(`Remove folder "${folder.title}" and all links?`)) return;
            await postJson(REMOVE_FOLDER_API, { id: folder.id });
            folders = await loadFolders();
            renderList();
            fetchLinks();
          });
          f.appendChild(removeFolder);

          (folder.links || []).forEach(link => {
            const row = elt('div', { class: 'link-row' });
            row.appendChild(elt('div', {}, `${link.name} — ${link.url}`));
            const rm = elt('button', { class: 'link-btn danger', type: 'button' }, 'Remove');
            rm.addEventListener('click', async () => {
              if (!confirm(`Remove link "${link.name}"?`)) return;
              await postJson(REMOVE_LINK_API, { id: link.id });
              folders = await loadFolders();
              renderList();
              fetchLinks();
            });
            row.appendChild(rm);
            f.appendChild(row);
          });

          listWrap.appendChild(f);
        });
      }
    }
    renderList();

    // Add folder form
    const addFolderRow = elt('div', { class: 'form-row' });
    const folderInput = elt('input', { placeholder: 'New folder title' });
    const addFolderBtn = elt('button', { class: 'link-btn', type: 'button' }, 'Add Folder');
    addFolderBtn.addEventListener('click', async () => {
      const title = (folderInput.value || '').trim();
      if (!title) return alert('Folder title required.');
      const res = await postJson(ADD_FOLDER_API, { title });
      if (res && res.ok) {
        folderInput.value = '';
        folders = await loadFolders();
        renderList();
      } else {
        alert('Failed to add folder.');
      }
    });
    addFolderRow.appendChild(folderInput);
    addFolderRow.appendChild(addFolderBtn);
    container.appendChild(addFolderRow);

    // Add link form
    const addLinkWrap = elt('div', { style: 'margin-top:12px;' });
    addLinkWrap.appendChild(elt('h4', {}, 'Add Link'));
    const addLinkRow = elt('div', { class: 'form-row' });
    const folderSelect = elt('select', {});
    folderSelect.appendChild(elt('option', { value: '' }, '-- choose folder --'));
    (folders || []).forEach(f => folderSelect.appendChild(elt('option', { value: f.id }, f.title)));
    const linkName = elt('input', { placeholder: 'Link name' });
    addLinkRow.appendChild(folderSelect);
    addLinkRow.appendChild(linkName);
    addLinkWrap.appendChild(addLinkRow);

    const addLinkRow2 = elt('div', { class: 'form-row' });
    const linkUrl = elt('input', { placeholder: 'https://...' });
    const addLinkBtn = elt('button', { class: 'link-btn', type: 'button' }, 'Add Link');
    addLinkBtn.addEventListener('click', async () => {
      const folderId = folderSelect.value;
      const name = (linkName.value || '').trim();
      const url = (linkUrl.value || '').trim();
      if (!folderId) return alert('Select a folder.');
      if (!name || !url) return alert('Name and URL required.');
      const res = await postJson(ADD_LINK_API, { folderId, name, url });
      if (res && res.ok) {
        linkName.value = '';
        linkUrl.value = '';
        folders = await loadFolders();
        // refresh select options
        folderSelect.innerHTML = '';
        folderSelect.appendChild(elt('option', { value: '' }, '-- choose folder --'));
        folders.forEach(f => folderSelect.appendChild(elt('option', { value: f.id }, f.title)));
        renderList();
        fetchLinks();
      } else {
        alert('Failed to add link.');
      }
    });
    addLinkRow2.appendChild(linkUrl);
    addLinkRow2.appendChild(addLinkBtn);
    addLinkWrap.appendChild(addLinkRow2);
    container.appendChild(addLinkWrap);

    // Clear my timer button
    const clearRow = elt('div', { class: 'form-row' });
    const clearBtn = elt('button', { class: 'link-btn', type: 'button' }, 'Clear My Timer');
    clearBtn.addEventListener('click', async () => {
      if (!confirm('Clear your own claim timer?')) return;
      const res = await postJson(CLEAR_TIMER_API, {});
      if (res && res.ok) alert('Your timer has been cleared.');
      else alert('Failed to clear timer.');
    });
    clearRow.appendChild(clearBtn);
    container.appendChild(clearRow);
  }

  // --- helpers for admin ---
  async function loadFolders() {
    try {
      const res = await fetch(LINKS_API, { credentials: 'same-origin' });
      if (!res.ok) throw new Error();
      return await res.json();
    } catch (e) {
      return [];
    }
  }

  async function postJson(url, body) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  // --- init ---
  (function init() {
    fetchLinks();
    // expose a debug reload
    window.__divine_sites_reload = fetchLinks;
  })();

})();
