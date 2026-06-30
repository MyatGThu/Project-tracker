/* ─────────────────────────────────────────────────────────────
   Poker Tracker — app.js
   Loaded by index.html after config.js + settlement.js.
   ───────────────────────────────────────────────────────────── */

// Currency symbol — from config.js (CURRENCY), falls back to '$'.
const CUR = (typeof CURRENCY !== 'undefined' && CURRENCY) ? CURRENCY : '$';

/* ── Auth mode ─────────────────────────────────────────────────────
   When config.js sets AUTH0 = { domain, clientId, audience }, the app runs in
   multi-user mode: it signs in via Auth0 and attaches a Bearer token + the
   active group to every request. Otherwise it falls back to the original
   shared-password lock and the API stays unauthenticated. authMode() is the
   single source of truth. */
const AUTH0_CFG = (typeof AUTH0 !== 'undefined' && AUTH0 && AUTH0.domain && AUTH0.clientId) ? AUTH0 : null;
const authMode = () => (AUTH0_CFG ? 'auth0' : 'password');

let _auth0Client  = null;                                  // Auth0 SPA client
let activeGroupId = localStorage.getItem('poker_group') || null;

async function authToken() {
  if (authMode() !== 'auth0' || !_auth0Client) return null;
  try { return await _auth0Client.getTokenSilently(); }   // cached + auto-refreshed
  catch { return null; }
}

async function api(path, method = 'GET', body) {
  // Config guard — API_BASE missing or still the placeholder
  if (typeof API_BASE === 'undefined' || !API_BASE || API_BASE.includes('YOUR-WORKER')) {
    return { data: null, error: { kind: 'config',
      message: 'API not configured. Set API_BASE in config.js to your deployed Worker URL (ending in /api).' } };
  }

  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  // Multi-user mode: send the verified identity + active group.
  if (authMode() === 'auth0') {
    const tok = await authToken();
    if (tok) opts.headers['Authorization'] = `Bearer ${tok}`;
    if (activeGroupId) opts.headers['X-Group-Id'] = activeGroupId;
  }

  // Network layer — Worker unreachable, wrong URL, CORS, offline
  let res;
  try {
    res = await fetch(API_BASE + path, opts);
  } catch (e) {
    return { data: null, error: { kind: 'network',
      message: `Can't reach the API at ${API_BASE}${path}. Check the Worker is deployed and API_BASE in config.js is correct.` } };
  }

  // Parse body (may be empty/non-JSON on some errors)
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }

  if (!res.ok) {
    const detail = (json && json.error) ? json.error : `HTTP ${res.status}`;
    return { data: null, error: { kind: 'http', status: res.status,
      message: `${detail} (${method} ${path})` } };
  }

  return { data: json, error: null };
}

/* ── Role / permissions ───────────────────────────────────────────
   Two passwords share the lock screen (see /api/auth): the admin password
   grants full access; an optional user password grants a restricted role
   that hides destructive actions (delete / re-open / remove / edit buy-in /
   force-balance) so a borrowed phone can't cause an accidental change.
   Mistake-prevention only — the data API itself is open. Role is captured
   at unlock and kept in sessionStorage; default 'admin' (single-password
   setups and pre-role logins behave exactly as before). */
function getRole() { return sessionStorage.getItem('poker_role') || 'admin'; }
function isAdmin() { return getRole() === 'admin'; }

/* ── State ────────────────────────────────────────────────────── */
let currentSession        = null;  // { id, name, status, created_at }
let currentPlayers        = [];    // [{ id, player_name, final_chips, buyins: [{id, amount}] }]
let allSessions           = [];    // full list, kept for sessions-search filtering

// Buy-in modal modes
let modalMode             = 'add'; // 'add' | 'edit'
let pendingBuyinPlayerId  = null;  // session_player id (add mode)
let pendingEditBuyinId    = null;  // buyin id (edit mode)

// Delete modal
let pendingDeleteSessionId = null;

// Rename mode — reuses the new-session modal
let renameMode = false;

// App mode
let currentMode = localStorage.getItem('poker_mode') || 'home'; // 'home' | 'casino'

// Casino visit modal state
let editingVisitId  = null;
let selectedGames   = new Set();

// Casino period filter
let casinoPeriod = 'all'; // 'all' | 'year' | 'month'

// Blinds timer state
const BLIND_LEVELS = [
  { small: 5,   big: 10  }, { small: 10,  big: 20  }, { small: 15,  big: 30  },
  { small: 25,  big: 50  }, { small: 50,  big: 100 }, { small: 75,  big: 150 },
  { small: 100, big: 200 }, { small: 150, big: 300 }, { small: 200, big: 400 },
  { small: 300, big: 600 },
];
// Preset buy-ins for common home game stakes (100 big blinds each)
const BLIND_PRESETS = [
  { label: '0.10 / 0.20', desc: 'Micro stakes', buyin: 20   },
  { label: '1 / 2',       desc: 'Low stakes',   buyin: 200  },
  { label: '5 / 10',      desc: 'Mid stakes',   buyin: 1000 },
];
let timerInterval     = null;
let timerRunning      = false;
let timerLevel        = 0;
let timerSecondsLeft  = 300;
let timerLevelDuration = 300;

// Dealer tip — dismissed per session
let dealerTipDismissed = false;

// Session timer
let sessionTimerInterval = null;

function updateSessionTimer(createdAt) {
  const el   = document.getElementById('session-timer');
  if (!el) return;
  const diff = Date.now() - new Date(createdAt).getTime();
  const h    = Math.floor(diff / 3600000);
  const m    = Math.floor((diff % 3600000) / 60000);
  el.textContent = h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function clearSessionTimer() {
  clearInterval(sessionTimerInterval);
  sessionTimerInterval = null;
}

// Results state
let currentSorted       = [];      // sorted players for active results view
let adjustedNets        = null;    // Map<player_id, adjusted_net> after force balance
let originalDiscrepancy = null;    // raw discrepancy amount before force balance was applied
let justSettled         = false;   // true only when coming directly from the settle confirm

// Roster state
let roster          = [];          // [{id, name}] from players table
let pickerSelected  = new Set();   // names selected in the picker
let pickerBuyinDefault = null;     // buy-in pre-fill from blinds preset; null = enter manually

/* ═══════════════════════════════════════════════════════════════
   TOAST NOTIFICATIONS
   ═══════════════════════════════════════════════════════════════ */

function toast(msg, type = 'info', duration = 3200) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  // textContent, not innerHTML: messages can carry server/user-derived strings
  // (group names, error text), so never interpret them as HTML.
  const span = document.createElement('span');
  span.className = 'toast-msg';
  span.textContent = msg;
  el.appendChild(span);
  container.appendChild(el);
  const remove = () => {
    el.style.transition = 'opacity 0.25s, transform 0.25s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px) scale(0.96)';
    setTimeout(() => el.remove(), 260);
  };
  el.addEventListener('click', remove);
  setTimeout(remove, duration);
}

function toastUndo(msg, undoFn, duration = 5000) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = 'toast info';
  const span = document.createElement('span');
  span.className = 'toast-msg';
  span.textContent = msg;                       // text, not HTML (see toast())
  const undoBtn = document.createElement('button');
  undoBtn.className = 'toast-undo';
  undoBtn.textContent = 'Undo';
  el.append(span, undoBtn);
  container.appendChild(el);
  let acted = false;
  const remove = () => {
    el.style.transition = 'opacity 0.25s, transform 0.25s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    setTimeout(() => el.remove(), 260);
  };
  el.querySelector('.toast-undo').addEventListener('click', () => {
    if (acted) return;
    acted = true;
    undoFn();
    remove();
  });
  setTimeout(() => { if (!acted) remove(); }, duration);
}

/* ── Skeleton loader ─────────────────────────────────────────────── */
function skeletonHTML(count = 3) {
  return Array.from({ length: count }, () =>
    `<div class="skeleton-card">
       <div class="skeleton-line w-40"></div>
       <div class="skeleton-line w-75"></div>
     </div>`).join('');
}

/* ── View router (placeholder — real one in BOTTOM NAVIGATION) ─── */
// Defined below after DETAIL_VIEWS is declared.

/* ═══════════════════════════════════════════════════════════════
   HOME VIEW
   ═══════════════════════════════════════════════════════════════ */

// Called by: boot, back buttons, after delete
async function loadSessions() { return loadHome(); }
async function loadHome() {
  show('view-sessions');
  const list = document.getElementById('sessions-list');
  list.innerHTML = skeletonHTML(4);

  const { data, error } = await api('/sessions');

  if (error) { list.innerHTML = `<p class="empty-state">Error: ${error.message}</p>`; return; }
  allSessions = data || [];
  const q = document.getElementById('sessions-search').value.trim().toLowerCase();
  renderSessions(q ? allSessions.filter(s => s.name.toLowerCase().includes(q)) : allSessions);
}

// Called by: loadHome, sessions-search input
function renderSessions(sessions) {
  const list = document.getElementById('sessions-list');
  if (!sessions.length) {
    const msg = allSessions.length
      ? 'No sessions match your search.'
      : 'No sessions yet. Start a new game!';
    list.innerHTML = `<p class="empty-state">${msg}</p>`;
    return;
  }

  list.innerHTML = '';
  sessions.forEach(s => {
    // Compute winner + pot for settled sessions
    let winnerLine = '';
    let potLine    = '';
    if (s.status === 'settled' && s.session_players?.length) {
      let topNet = -Infinity, winnerName = '', totalPot = 0;
      s.session_players.forEach(p => {
        const buyin = (p.buyins || []).reduce((sum, b) => sum + Number(b.amount), 0);
        const net   = (p.final_chips ?? 0) - buyin;
        totalPot   += buyin;
        if (net > topNet) { topNet = net; winnerName = p.player_name; }
      });
      if (winnerName && topNet > 0) {
        winnerLine = `<span class="session-card-winner"><svg class="icon"><use href="#i-trophy"/></svg> ${winnerName} +${CUR}${topNet}</span>`;
      }
      potLine = `<span class="session-card-pot">Pot ${CUR}${totalPot}</span>`;
    }

    // Wrap card for swipe support. Users (non-admin) can never delete.
    const locked = !isAdmin() || isLockedForDelete(s);
    const wrap = document.createElement('div');
    wrap.className = 'session-swipe-wrap';
    if (!locked) wrap.innerHTML = `<div class="swipe-delete-bg"><svg class="icon"><use href="#i-x"/></svg></div>`;

    const card = document.createElement('div');
    card.className = `session-card ${s.status === 'active' ? 'active-session' : 'settled-session'}`;
    card.innerHTML = `
      <div class="session-card-info">
        <span class="session-card-name">${s.name}</span>
        <span class="session-card-meta">${formatDate(s.created_at)}</span>
        ${winnerLine}${potLine}
      </div>
      <div class="session-card-right">
        <span class="badge ${s.status === 'active' ? 'badge-active' : 'badge-settled'}">${s.status}</span>
        ${locked ? '' : `<button class="btn-delete" data-id="${s.id}" data-name="${s.name}" title="Delete session"><svg class="icon"><use href="#i-x"/></svg></button>`}
      </div>`;

    card.addEventListener('click', e => {
      if (!e.target.closest('.btn-delete')) openSession(s, 'forward');
    });

    const deleteBtn = card.querySelector('.btn-delete');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', e => {
        e.stopPropagation();
        openDeleteModal(s.id, s.name);
      });
    }

    wrap.appendChild(card);
    if (!locked) addSwipeToDelete(card, () => openDeleteModal(s.id, s.name));
    list.appendChild(wrap);
  });
}

document.getElementById('sessions-search').addEventListener('input', () => {
  const q = document.getElementById('sessions-search').value.trim().toLowerCase();
  renderSessions(q ? allSessions.filter(s => s.name.toLowerCase().includes(q)) : allSessions);
});

// Swipe left past threshold to trigger delete modal
function addSwipeToDelete(cardEl, onSwipe) {
  let startX = 0, dx = 0, dragging = false;
  const THRESHOLD = 72;

  cardEl.addEventListener('touchstart', e => {
    startX = e.touches[0].clientX;
    dragging = true;
    cardEl.style.transition = 'none';
  }, { passive: true });

  cardEl.addEventListener('touchmove', e => {
    if (!dragging) return;
    dx = e.touches[0].clientX - startX;
    if (dx < 0) cardEl.style.transform = `translateX(${Math.max(dx, -THRESHOLD - 16)}px)`;
  }, { passive: true });

  cardEl.addEventListener('touchend', () => {
    dragging = false;
    cardEl.style.transition = 'transform 0.22s ease';
    cardEl.style.transform  = 'translateX(0)';
    if (dx < -THRESHOLD) onSwipe();
    dx = 0;
  });
}

/* ── New session modal ──────────────────────────────────────────── */

function openNewSessionModal() {
  renameMode = false;
  document.getElementById('input-session-name').value = '';
  document.getElementById('input-session-date').value = new Date().toISOString().split('T')[0];
  document.getElementById('input-session-date').style.display = '';
  document.querySelector('#modal-new-session h3').textContent          = 'New Session';
  document.querySelector('#modal-new-session .modal-label').textContent = 'Name this game night.';
  document.getElementById('modal-new-session').classList.remove('hidden');
  setTimeout(() => document.getElementById('input-session-name').focus(), 50);
}

document.getElementById('btn-new-session').addEventListener('click', openNewSessionModal);

document.getElementById('modal-new-cancel').addEventListener('click', () => {
  renameMode = false;
  document.getElementById('modal-new-session').classList.add('hidden');
});

document.getElementById('modal-new-confirm').addEventListener('click', async () => {
  const name = document.getElementById('input-session-name').value.trim();
  if (!name) return;
  document.getElementById('modal-new-session').classList.add('hidden');

  if (renameMode) {
    renameMode = false;
    const { error } = await api(`/sessions/${currentSession.id}`, 'PATCH', { name });
    if (error) { toast('Error renaming session: ' + error.message, 'error'); return; }
    currentSession.name = name;
    document.getElementById('session-title').textContent = name;
    toast('Session renamed.', 'success');
    return;
  }

  const dateVal    = document.getElementById('input-session-date').value;
  // Store as local wall-clock in SQLite's "YYYY-MM-DD HH:MM:SS" format (matches
  // the DB default) — avoids toISOString()'s UTC shift moving the picked day.
  const created_at = dateVal ? `${dateVal} 20:00:00` : undefined;
  const { data, error } = await api('/sessions', 'POST', { name, ...(created_at && { created_at }) });

  if (error) { toast('Error creating session: ' + error.message, 'error'); return; }
  openSession(data);
});

document.getElementById('input-session-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('modal-new-confirm').click();
  if (e.key === 'Escape') document.getElementById('modal-new-cancel').click();
});

/* ── Delete session modal ───────────────────────────────────────── */

// Called by: delete button on session card
function openDeleteModal(sessionId, sessionName) {
  pendingDeleteSessionId = sessionId;
  document.getElementById('modal-delete-label').textContent =
    `"${sessionName}" and all its data will be permanently removed.`;
  document.getElementById('modal-delete').classList.remove('hidden');
}

document.getElementById('modal-delete-cancel').addEventListener('click', () => {
  document.getElementById('modal-delete').classList.add('hidden');
  pendingDeleteSessionId = null;
});

document.getElementById('modal-delete-confirm').addEventListener('click', async () => {
  if (!pendingDeleteSessionId) return;
  document.getElementById('modal-delete').classList.add('hidden');

  const { error } = await api(`/sessions/${pendingDeleteSessionId}`, 'DELETE');

  pendingDeleteSessionId = null;
  if (error) { toast('Error deleting session: ' + error.message, 'error'); return; }
  await loadHome();
});

document.getElementById('btn-rename-session').addEventListener('click', () => {
  renameMode = true;
  document.getElementById('input-session-name').value                   = currentSession.name;
  document.getElementById('input-session-date').style.display           = 'none';
  document.querySelector('#modal-new-session h3').textContent           = 'Rename Session';
  document.querySelector('#modal-new-session .modal-label').textContent = 'Enter a new name for this session.';
  document.getElementById('modal-new-session').classList.remove('hidden');
  setTimeout(() => document.getElementById('input-session-name').focus(), 50);
});

/* ═══════════════════════════════════════════════════════════════
   SESSION VIEW
   ═══════════════════════════════════════════════════════════════ */

// Called by: session-card click, new session confirm
async function openSession(session, dir = 'none') {
  currentSession = session;
  document.getElementById('session-title').textContent       = session.name;
  document.getElementById('session-date').textContent        = formatDate(session.created_at);
  document.getElementById('session-notes-input').value       = session.notes || '';
  document.getElementById('session-notes-input').readOnly    = session.status === 'settled';

  const settleBtn = document.getElementById('btn-settle');
  settleBtn.textContent = session.status === 'settled' ? 'View Results' : 'Settle Up';

  document.getElementById('btn-blinds-timer').classList.toggle('hidden', session.status === 'settled');

  // Session timer — only for active sessions
  const timerEl = document.getElementById('session-timer');
  clearSessionTimer();
  if (session.status === 'active') {
    timerEl.classList.remove('hidden');
    updateSessionTimer(session.created_at);
    sessionTimerInterval = setInterval(() => updateSessionTimer(session.created_at), 60000);
  } else {
    timerEl.classList.add('hidden');
  }

  dealerTipDismissed = false;

  // Settled sessions open straight to the results page; active ones to the
  // session (player list). loadPlayers() runs first either way so the results
  // view has the player/buy-in data it needs. Back from results → home, and
  // Re-open drops back into the (now active) session view.
  if (session.status === 'settled') {
    await loadPlayers();
    openResultsView(dir);
  } else {
    show('view-session', dir);
    await loadPlayers();
  }
}

// Called by: openSession(), after add-player/buyin/edit-buyin
async function loadPlayers() {
  const { data, error } = await api(`/sessions/${currentSession.id}/players`);

  if (error) { console.error(error); return; }
  currentPlayers = data || [];
  renderPlayers();
}

function getDefaultRebuy() { return parseInt(localStorage.getItem('default_rebuy') || '20', 10); }
function setDefaultRebuy(v) { localStorage.setItem('default_rebuy', v.toString()); }

function isLockedForDelete(session) {
  // A session can be deleted ONLY while it's active (i.e. re-opened, or still
  // in progress) AND by an admin (see `locked` in renderSessions, which also
  // requires isAdmin()). Re-open is itself admin-only, so deleting a finished
  // game means: admin re-opens it first, then deletes — preventing accidental
  // loss of a settled session.
  return session.status === 'settled';
}

// Called by: loadPlayers()
function renderPlayers() {
  // Live pot — only show during active sessions with at least one player
  const pot    = currentPlayers.reduce((sum, p) => sum + totalBuyin(p.buyins), 0);
  const potBar = document.getElementById('session-pot-bar');
  const potEl  = document.getElementById('session-live-pot');
  if (currentPlayers.length > 0 && currentSession.status === 'active') {
    potEl.textContent = `${CUR}${pot}`;
    potBar.classList.remove('hidden');
  } else {
    potBar.classList.add('hidden');
  }

  const seatsBtn   = document.getElementById('btn-randomize-seats');
  const dealerTip  = document.getElementById('dealer-tip');
  const rebuyWrap  = document.getElementById('rebuy-pill-wrap');
  const rebuyDisp  = document.getElementById('rebuy-amount-display');

  if (currentPlayers.length >= 2 && currentSession.status === 'active') {
    seatsBtn.classList.remove('hidden');
  } else {
    seatsBtn.classList.add('hidden');
  }

  if (currentPlayers.length > 5 && currentSession.status === 'active' && !dealerTipDismissed) {
    dealerTip.classList.remove('hidden');
  } else {
    dealerTip.classList.add('hidden');
  }

  if (currentPlayers.length > 0 && currentSession.status === 'active') {
    rebuyDisp.textContent = getDefaultRebuy();
    rebuyWrap.classList.remove('hidden');
  } else {
    rebuyWrap.classList.add('hidden');
  }

  const list = document.getElementById('players-list');
  const isSettled = currentSession.status === 'settled';
  const canEdit   = isAdmin(); // gates buy-in editing + player removal

  if (!currentPlayers.length) {
    list.innerHTML = '<p class="empty-state">Add players above to start tracking.</p>';
    return;
  }

  list.innerHTML = '';
  currentPlayers.forEach(p => {
    const total   = totalBuyin(p.buyins);
    const card    = document.createElement('div');
    card.className = 'player-card';

    // Each pill is a clickable button for editing
    const sortedBuyins = [...(p.buyins || [])].sort((a, b) =>
      new Date(a.created_at) - new Date(b.created_at)
    );

    // Editing a buy-in is admin-only; users see static (non-clickable) pills.
    const pills = sortedBuyins.map((b, i) => `
      <button class="buyin-pill ${i === 0 ? 'first' : ''} ${canEdit ? 'edit-buyin-btn' : ''}"
              ${canEdit
                ? `data-buyin-id="${b.id}" data-amount="${b.amount}" data-player="${p.player_name}" title="Click to edit"`
                : 'disabled'}>
        ${CUR}${b.amount}
        ${canEdit ? '<span class="pill-edit"><svg class="icon"><use href="#i-pencil"/></svg></span>' : ''}
      </button>`).join('');

    card.innerHTML = `
      <div class="player-card-header">
        <span class="player-name">${p.player_name}</span>
        <div class="player-header-right">
          <div class="player-total">
            <span class="player-total-label">Total in</span>
            <span class="player-total-amount">${CUR}${total}</span>
          </div>
          ${!isSettled && canEdit ? `<button class="btn-remove-player" data-id="${p.id}" data-name="${p.player_name}" title="Remove player"><svg class="icon"><use href="#i-x"/></svg></button>` : ''}
        </div>
      </div>
      <div class="buyin-history">${pills}</div>
      ${!isSettled ? `
        <div class="player-card-footer">
          <button class="btn-quick-rebuy quick-rebuy-btn"
                  data-id="${p.id}" data-name="${p.player_name}">
            +${CUR}${getDefaultRebuy()}
          </button>
          <button class="btn btn-ghost btn-sm add-buyin-btn"
                  data-id="${p.id}" data-name="${p.player_name}">
            Custom Re-buy
          </button>
        </div>` : ''}`;

    list.appendChild(card);
  });

  // Quick re-buy (amount from config / getDefaultRebuy)
  document.querySelectorAll('.quick-rebuy-btn').forEach(btn =>
    btn.addEventListener('click', () => quickRebuy(btn.dataset.id, btn.dataset.name))
  );

  // Custom re-buy (opens modal)
  document.querySelectorAll('.add-buyin-btn').forEach(btn =>
    btn.addEventListener('click', () => openAddBuyinModal(btn.dataset.id, btn.dataset.name))
  );

  // Edit buyin pills
  document.querySelectorAll('.edit-buyin-btn').forEach(btn =>
    btn.addEventListener('click', () =>
      openEditBuyinModal(btn.dataset.buyinId, Number(btn.dataset.amount), btn.dataset.player)
    )
  );

  // Remove player buttons
  document.querySelectorAll('.btn-remove-player').forEach(btn =>
    btn.addEventListener('click', () => removePlayer(btn.dataset.id, btn.dataset.name))
  );
}

/* ═══════════════════════════════════════════════════════════════
   PLAYER ROSTER & PICKER
   Default roster is hardcoded — no extra SQL table needed.
   Extra players added via the picker are saved to localStorage.
   ═══════════════════════════════════════════════════════════════ */

// Starter roster. Override per-deployment by setting DEFAULT_ROSTER in config.js.
const DEFAULT_PLAYERS = (typeof DEFAULT_ROSTER !== 'undefined' && Array.isArray(DEFAULT_ROSTER) && DEFAULT_ROSTER.length)
  ? DEFAULT_ROSTER
  : ['Alex', 'Sam', 'Jordan', 'Casey', 'Taylor', 'Morgan', 'Riley', 'Jamie'];

// Called by: openPlayerPicker, boot
function loadRoster() {
  const extras = getLocalPlayers();
  const allNames = [
    ...DEFAULT_PLAYERS,
    ...extras.filter(e => !DEFAULT_PLAYERS.some(d => d.toLowerCase() === e.toLowerCase()))
  ];
  roster = allNames.map((name, i) => ({ id: `player-${i}`, name }));
}

// localStorage helpers for extra players added at runtime
function getLocalPlayers() {
  try { return JSON.parse(localStorage.getItem('poker_extra_players') || '[]'); }
  catch { return []; }
}

function saveLocalPlayer(name) {
  const existing = getLocalPlayers();
  if (!existing.some(n => n.toLowerCase() === name.toLowerCase())) {
    existing.push(name);
    localStorage.setItem('poker_extra_players', JSON.stringify(existing));
  }
}

// Called by: btn-open-picker click — shows blind-level picker first
async function openPlayerPicker() {
  if (currentSession.status === 'settled') return;
  pickerBuyinDefault = null;
  renderBlindsPresets();
  document.getElementById('modal-blinds').classList.remove('hidden');
}

// Called by: renderBlindsPresets preset click, #blinds-skip
async function continueToPlayerPicker() {
  if (!roster.length) await loadRoster();
  pickerSelected = new Set();
  renderRosterChips();
  renderPickerBuyins();
  document.getElementById('new-roster-input').value = '';
  const label = document.querySelector('#modal-picker .modal-label');
  if (label) label.textContent = pickerBuyinDefault
    ? `Tap to select · ${CUR}${pickerBuyinDefault.toLocaleString()} buy-in pre-filled`
    : 'Tap to select · set each buy-in below';
  document.getElementById('modal-picker').classList.remove('hidden');
}

// Called by: openPlayerPicker
function renderBlindsPresets() {
  const list = document.getElementById('blinds-preset-list');
  list.innerHTML = '';
  BLIND_PRESETS.forEach(p => {
    const btn = document.createElement('button');
    btn.className = 'blinds-preset-btn';
    btn.innerHTML = `
      <div class="blinds-preset-left">
        <span class="blinds-preset-level">${p.label}</span>
        <span class="blinds-preset-desc">${p.desc}</span>
      </div>
      <span class="blinds-preset-buyin">${CUR}${p.buyin.toLocaleString()}</span>`;
    btn.addEventListener('click', () => {
      pickerBuyinDefault = p.buyin;
      setDefaultRebuy(p.buyin);
      document.getElementById('modal-blinds').classList.add('hidden');
      continueToPlayerPicker();
    });
    list.appendChild(btn);
  });
}

document.getElementById('btn-open-picker').addEventListener('click', openPlayerPicker);

// Called by: openPlayerPicker, chip click, addToRoster
function renderRosterChips() {
  const inSession = new Set(currentPlayers.map(p => p.player_name.toLowerCase()));
  const container = document.getElementById('roster-chips');
  container.innerHTML = '';

  roster.forEach(p => {
    const alreadyIn = inSession.has(p.name.toLowerCase());
    const chip = document.createElement('button');
    chip.className = `roster-chip${pickerSelected.has(p.name) ? ' selected' : ''}${alreadyIn ? ' in-session' : ''}`;
    chip.textContent = p.name;
    chip.disabled = alreadyIn;
    chip.title = alreadyIn ? 'Already in this session' : '';

    chip.addEventListener('click', () => {
      if (pickerSelected.has(p.name)) {
        pickerSelected.delete(p.name);
        chip.classList.remove('selected');
      } else {
        pickerSelected.add(p.name);
        chip.classList.add('selected');
      }
      renderPickerBuyins();
    });

    container.appendChild(chip);
  });
}

// Called by: chip click, continueToPlayerPicker
function renderPickerBuyins() {
  const container = document.getElementById('picker-buyins');
  container.innerHTML = '';

  pickerSelected.forEach(name => {
    const row = document.createElement('div');
    row.className = 'picker-buyin-row';
    const preVal = pickerBuyinDefault ? ` value="${pickerBuyinDefault}"` : '';
    row.innerHTML = `
      <span class="picker-buyin-name">${name}</span>
      <div class="input-with-prefix">
        <span class="input-prefix">${CUR}</span>
        <input class="input input-prefixed" type="number" inputmode="decimal" placeholder="0"
               min="1" data-player="${name}"${preVal} />
      </div>`;
    container.appendChild(row);
  });

  if (pickerSelected.size > 0 && !pickerBuyinDefault) {
    const first = container.querySelector('input');
    if (first) setTimeout(() => first.focus(), 50);
  }
}

// Confirm — add all selected players with their buy-ins
document.getElementById('picker-confirm').addEventListener('click', async () => {
  if (!pickerSelected.size) {
    document.getElementById('modal-picker').classList.add('hidden'); return;
  }

  const inputs = document.querySelectorAll('#picker-buyins input');
  const entries = [];

  for (const inp of inputs) {
    const amount = parseFloat(inp.value);
    if (!amount || amount <= 0) {
      toast(`Enter a buy-in amount for ${inp.dataset.player}.`, 'error'); return;
    }
    entries.push({ name: inp.dataset.player, amount });
  }

  document.getElementById('modal-picker').classList.add('hidden');

  for (const entry of entries) {
    const { data: player, error: pe } = await api('/session-players', 'POST', { session_id: currentSession.id, player_name: entry.name });
    if (pe) { toast('Error adding ' + entry.name + ': ' + pe.message, 'error'); continue; }
    await api('/buyins', 'POST', { session_player_id: player.id, amount: entry.amount });
  }

  await loadPlayers();
});

document.getElementById('picker-cancel').addEventListener('click', () => {
  document.getElementById('modal-picker').classList.add('hidden');
});

document.getElementById('blinds-skip').addEventListener('click', () => {
  document.getElementById('modal-blinds').classList.add('hidden');
  continueToPlayerPicker();
});

// Add a new permanent player to the roster
document.getElementById('btn-add-roster').addEventListener('click', () => {
  const input = document.getElementById('new-roster-input');
  const name  = input.value.trim();
  if (!name) return;

  const exists = roster.some(p => p.name.toLowerCase() === name.toLowerCase());
  if (exists) { toast(`${name} is already in the roster.`, 'info'); return; }

  saveLocalPlayer(name);
  loadRoster(); // rebuild roster with new name included
  input.value = '';
  pickerSelected.add(name);
  renderRosterChips();
  renderPickerBuyins();
});

document.getElementById('new-roster-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-add-roster').click();
});

// Called by: quick re-buy button — no modal, inserts immediately
async function quickRebuy(playerId, playerName) {
  const { error } = await api('/buyins', 'POST', { session_player_id: playerId, amount: getDefaultRebuy() });
  if (error) { toast('Error: ' + error.message, 'error'); return; }
  await loadPlayers();
}

// Called by: remove button on player card
async function removePlayer(playerId, playerName) {
  // Snapshot data for potential undo
  const snapshot = currentPlayers.find(p => p.id === playerId);

  const { error } = await api(`/session-players/${playerId}`, 'DELETE');
  if (error) { toast('Error removing player: ' + error.message, 'error'); return; }
  await loadPlayers();

  toastUndo(`Removed ${playerName}`, async () => {
    if (!snapshot) return;
    const { data: restored, error: re } = await api('/session-players', 'POST', { session_id: currentSession.id, player_name: snapshot.player_name });
    if (re) { toast('Could not undo', 'error'); return; }
    for (const b of snapshot.buyins) {
      await api('/buyins', 'POST', { session_player_id: restored.id, amount: b.amount });
    }
    await loadPlayers();
    toast(`${playerName} restored`, 'success');
  });
}

document.getElementById('dealer-tip-dismiss').addEventListener('click', () => {
  dealerTipDismissed = true;
  document.getElementById('dealer-tip').classList.add('hidden');
});

/* ── Seat Randomizer ────────────────────────────────────────────── */

function renderSeats() {
  const shuffled = [...currentPlayers].sort(() => Math.random() - 0.5);
  document.getElementById('seats-list').innerHTML = shuffled.map((p, i) => `
    <div class="seat-row">
      <span class="seat-num">${i + 1}</span>
      <span class="seat-player">${p.player_name}</span>
    </div>`).join('');
}

document.getElementById('btn-randomize-seats').addEventListener('click', () => {
  renderSeats();
  document.getElementById('modal-seats').classList.remove('hidden');
});

document.getElementById('btn-reshuffle').addEventListener('click', renderSeats);

document.getElementById('btn-seats-close').addEventListener('click', () => {
  document.getElementById('modal-seats').classList.add('hidden');
});

/* ── Buy-in modal (shared for add + edit) ───────────────────────── */

// Called by: Re-buy button — ADD mode
function openAddBuyinModal(playerId, playerName) {
  modalMode            = 'add';
  pendingBuyinPlayerId = playerId;
  pendingEditBuyinId   = null;

  document.getElementById('modal-title').textContent        = 'Re-buy';
  document.getElementById('modal-player-label').textContent = `Adding re-buy for ${playerName}`;
  document.getElementById('modal-buyin-amount').value       = '';
  document.getElementById('modal-remove-buyin').classList.add('hidden');
  document.getElementById('modal-overlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('modal-buyin-amount').focus(), 50);
}

// Called by: pill click — EDIT mode
function openEditBuyinModal(buyinId, currentAmount, playerName) {
  if (!isAdmin()) return; // editing buy-ins is admin-only
  modalMode            = 'edit';
  pendingEditBuyinId   = buyinId;
  pendingBuyinPlayerId = null;

  document.getElementById('modal-title').textContent        = 'Edit Buy-in';
  document.getElementById('modal-player-label').textContent = `Editing entry for ${playerName}`;
  document.getElementById('modal-buyin-amount').value       = currentAmount;
  document.getElementById('modal-remove-buyin').classList.remove('hidden');
  document.getElementById('modal-overlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('modal-buyin-amount').focus(), 50);
}

// Save — handles both add and edit
document.getElementById('modal-confirm').addEventListener('click', async () => {
  const amount = parseFloat(document.getElementById('modal-buyin-amount').value);
  if (!amount || amount <= 0) { toast('Enter a valid amount.', 'error'); return; }

  document.getElementById('modal-overlay').classList.add('hidden');

  if (modalMode === 'add') {
    await api('/buyins', 'POST', { session_player_id: pendingBuyinPlayerId, amount });
  } else {
    await api(`/buyins/${pendingEditBuyinId}`, 'PATCH', { amount });
  }

  pendingBuyinPlayerId = null;
  pendingEditBuyinId   = null;
  await loadPlayers();
});

document.getElementById('modal-cancel').addEventListener('click', () => {
  document.getElementById('modal-overlay').classList.add('hidden');
});

// Remove a buy-in entry entirely (edit mode only)
document.getElementById('modal-remove-buyin').addEventListener('click', async () => {
  // Find how many buy-ins this player has
  const player = currentPlayers.find(p =>
    p.buyins?.some(b => b.id === pendingEditBuyinId)
  );
  if (player && player.buyins.length === 1) {
    toast("Can't remove the only buy-in — remove the player instead.", 'info');
    return;
  }

  document.getElementById('modal-overlay').classList.add('hidden');
  await api(`/buyins/${pendingEditBuyinId}`, 'DELETE');
  pendingEditBuyinId = null;
  await loadPlayers();
});

document.getElementById('modal-buyin-amount').addEventListener('keydown', e => {
  if (e.key === 'Enter')  document.getElementById('modal-confirm').click();
  if (e.key === 'Escape') document.getElementById('modal-cancel').click();
});

/* ── Session Notes ──────────────────────────────────────────────── */
document.getElementById('session-notes-input').addEventListener('blur', async () => {
  if (!currentSession || currentSession.status !== 'active') return;
  const notes = document.getElementById('session-notes-input').value.trim();
  await api(`/sessions/${currentSession.id}`, 'PATCH', { notes });
});

/* ── Configurable Quick Rebuy ───────────────────────────────────── */
document.getElementById('btn-set-rebuy').addEventListener('click', () => {
  document.getElementById('input-rebuy-amount').value = getDefaultRebuy();
  document.getElementById('modal-set-rebuy').classList.remove('hidden');
  setTimeout(() => document.getElementById('input-rebuy-amount').focus(), 50);
});

document.getElementById('rebuy-amount-cancel').addEventListener('click', () => {
  document.getElementById('modal-set-rebuy').classList.add('hidden');
});

document.getElementById('rebuy-amount-confirm').addEventListener('click', () => {
  const val = parseInt(document.getElementById('input-rebuy-amount').value, 10);
  if (val > 0) {
    setDefaultRebuy(val);
    document.getElementById('modal-set-rebuy').classList.add('hidden');
    renderPlayers();
  } else {
    toast('Enter a valid amount.', 'error');
  }
});

document.getElementById('input-rebuy-amount').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('rebuy-amount-confirm').click();
});

/* ── Settle / Back ──────────────────────────────────────────────── */

document.getElementById('btn-back-home').addEventListener('click', () => {
  clearSessionTimer();
  loadHome();
});

document.getElementById('btn-settle').addEventListener('click', () => {
  if (currentSession.status === 'settled') {
    openResultsView();
  } else {
    if (!currentPlayers.length) { toast('Add at least one player first.', 'info'); return; }
    document.getElementById('modal-settle-confirm').classList.remove('hidden');
  }
});

document.getElementById('settle-confirm-cancel').addEventListener('click', () => {
  document.getElementById('modal-settle-confirm').classList.add('hidden');
});

document.getElementById('settle-confirm-ok').addEventListener('click', () => {
  document.getElementById('modal-settle-confirm').classList.add('hidden');
  openSettleView();
});

/* ═══════════════════════════════════════════════════════════════
   SETTLE VIEW
   ═══════════════════════════════════════════════════════════════ */

// Parse a money input tolerating commas / spaces. Returns NaN for blank or junk.
function parseAmount(str) {
  const cleaned = String(str ?? '').replace(/[,\s]/g, '');
  if (cleaned === '') return NaN;
  return Number(cleaned); // Number() (unlike parseFloat) rejects trailing junk
}

function openSettleView() {
  show('view-settle', 'forward');
  const list = document.getElementById('settle-list');
  list.innerHTML = '';

  document.querySelector('.settle-hint').textContent =
    `Enter each player's final chip count — profit/loss is worked out for you.`;

  currentPlayers.forEach(p => {
    const total = totalBuyin(p.buyins);
    const row   = document.createElement('div');
    row.className = 'settle-row';
    row.innerHTML = `
      <div class="settle-row-info">
        <span class="settle-row-name">${p.player_name}</span>
        <span class="settle-row-buyin">Buy-in: ${CUR}${total}</span>
      </div>
      <div class="settle-row-right">
        <span class="settle-net" id="net-${p.id}"></span>
        <button class="btn-busted" title="Lost everything — final count 0">Busted</button>
        <input class="input settle-pl-input" type="text" inputmode="decimal"
               placeholder="chips" data-player-id="${p.id}" />
      </div>`;

    // Busted button — final chip count of 0 (lost the lot)
    const bustedBtn = row.querySelector('.btn-busted');
    const inp       = row.querySelector('input');
    const netEl     = row.querySelector('.settle-net');

    bustedBtn.addEventListener('click', () => {
      inp.value = '0';
      inp.dispatchEvent(new Event('input')); // trigger live indicator
      inp.focus();
    });
    inp.addEventListener('input', () => {
      const chips = parseAmount(inp.value);
      if (isNaN(chips)) {
        netEl.textContent = '';
        netEl.className   = 'settle-net';
        inp.classList.remove('pl-positive', 'pl-negative', 'pl-invalid');
      } else if (chips < 0) {
        netEl.textContent = 'invalid';
        netEl.className   = 'settle-net negative';
        inp.classList.add('pl-invalid');
        inp.classList.remove('pl-positive', 'pl-negative');
      } else {
        // Live profit/loss = final count − buy-in
        const net = Math.round((chips - total) * 100) / 100;
        netEl.textContent = net === 0 ? 'Even' : `${net > 0 ? '+' : '−'}${CUR}${Math.abs(net)}`;
        netEl.className   = `settle-net ${net > 0 ? 'positive' : net < 0 ? 'negative' : ''}`;
        inp.classList.toggle('pl-positive', net > 0);
        inp.classList.toggle('pl-negative', net < 0);
        inp.classList.remove('pl-invalid');
      }
      updateSettleBalance();
    });

    list.appendChild(row);
  });

  updateSettleBalance();
}

// Live reconciliation: total counted chips should equal the pot (sum of buy-ins).
function updateSettleBalance() {
  const bar    = document.getElementById('settle-balance');
  const inputs = [...document.querySelectorAll('#settle-list input')];
  const pot    = round2(currentPlayers.reduce((s, p) => s + totalBuyin(p.buyins), 0));

  let counted = 0, entered = 0, invalid = false;
  inputs.forEach(inp => {
    if (inp.value.trim() === '') return;
    const v = parseAmount(inp.value);
    if (isNaN(v) || v < 0) { invalid = true; return; }
    counted += v; entered++;
  });
  counted = round2(counted);

  bar.classList.remove('hidden', 'ok', 'off');

  // Not everyone entered yet (or something invalid) — show progress, no verdict.
  if (entered < inputs.length || invalid) {
    const left = inputs.length - entered;
    bar.classList.add('off');
    bar.innerHTML = `
      <span class="settle-balance-main">Counted ${CUR}${counted} of ${CUR}${pot} pot</span>
      <span class="settle-balance-sub">${left} player${left === 1 ? '' : 's'} still to enter</span>`;
    return;
  }

  const diff = round2(counted - pot);
  if (Math.abs(diff) < 0.01) {
    bar.classList.add('ok');
    bar.innerHTML = `
      <span class="settle-balance-main">✓ Balances — ${CUR}${pot} counted</span>
      <span class="settle-balance-sub">Chips match the pot exactly</span>`;
  } else {
    bar.classList.add('off');
    const word = diff > 0 ? 'too many' : 'missing';
    bar.innerHTML = `
      <span class="settle-balance-main">${CUR}${Math.abs(diff)} ${word}</span>
      <span class="settle-balance-sub">Counted ${CUR}${counted} of ${CUR}${pot} pot</span>`;
  }
}

let pendingSettleUpdates = null; // updates awaiting the "settle anyway" confirmation

document.getElementById('btn-confirm-settle').addEventListener('click', () => {
  const inputs  = document.querySelectorAll('#settle-list input');
  const updates = [];

  for (const inp of inputs) {
    const chips = parseAmount(inp.value);
    if (isNaN(chips)) { toast('Enter a final chip count for every player.', 'error'); inp.focus(); return; }
    if (chips < 0)   { toast("Chip counts can't be negative.", 'error'); inp.focus(); return; }
    updates.push({ id: inp.dataset.playerId, finalChips: round2(chips) });
  }

  // Zero-sum guard: counted chips should equal the pot (sum of buy-ins).
  const pot     = round2(currentPlayers.reduce((s, p) => s + totalBuyin(p.buyins), 0));
  const counted = round2(updates.reduce((s, u) => s + u.finalChips, 0));
  const diff    = round2(counted - pot);

  if (Math.abs(diff) >= 0.01) {
    pendingSettleUpdates = updates;
    const word = diff > 0 ? 'more than' : 'less than';
    document.getElementById('settle-warn-text').textContent =
      `Counted chips (${CUR}${counted}) are ${CUR}${Math.abs(diff)} ${word} the pot (${CUR}${pot}). ` +
      `Go back to fix the counts, or settle anyway and use Force Balance on the results screen.`;
    document.getElementById('modal-settle-warn').classList.remove('hidden');
    return;
  }

  doSettle(updates);
});

async function doSettle(updates) {
  // Independent per-player writes — run in parallel (async-parallel) rather than
  // N serial round-trips, then flip session status once they've all landed.
  await Promise.all(updates.map(u =>
    api(`/session-players/${u.id}`, 'PATCH', { final_chips: u.finalChips })
  ));
  await api(`/sessions/${currentSession.id}`, 'PATCH', { status: 'settled' });
  currentSession.status = 'settled';

  justSettled = true;
  await loadPlayers();
  openResultsView();
}

document.getElementById('settle-warn-cancel').addEventListener('click', () => {
  document.getElementById('modal-settle-warn').classList.add('hidden');
  pendingSettleUpdates = null;
});

document.getElementById('settle-warn-ok').addEventListener('click', () => {
  document.getElementById('modal-settle-warn').classList.add('hidden');
  if (pendingSettleUpdates) { doSettle(pendingSettleUpdates); pendingSettleUpdates = null; }
});

document.getElementById('btn-back-session').addEventListener('click', () => show('view-session', 'back'));

/* ═══════════════════════════════════════════════════════════════
   RESULTS VIEW
   ═══════════════════════════════════════════════════════════════ */

function openResultsView(dir = 'forward') {
  show('view-results', dir);
  document.getElementById('results-session-name').textContent = currentSession.name;

  // Sort once, store for re-renders after force balance
  currentSorted       = [...currentPlayers].sort((a, b) => getNet(b) - getNet(a));
  adjustedNets        = null;
  originalDiscrepancy = null;

  let totalPot = 0;
  currentPlayers.forEach(p => { totalPot += totalBuyin(p.buyins); });
  document.getElementById('results-pot').textContent = `${CUR}${totalPot}`;

  renderResultCards();
  renderSettlements();
  renderBalanceCheck();

  // Celebrate the winner only on a freshly settled session
  if (justSettled) {
    justSettled = false;
    const winner = currentSorted.find(p => getNet(p) > 0);
    if (winner) {
      setTimeout(() => {
        launchConfetti();
        showWinnerAnnouncement(winner.player_name, getNet(winner));
      }, 400);
    }
  }
}

// Returns net for a player, using adjusted value if force balance was applied.
// Called by: renderResultCards, calculateSettlements, renderBalanceCheck
function getNet(p) {
  if (adjustedNets?.has(p.id)) return adjustedNets.get(p.id);
  return computeNet(p.final_chips, p.buyins); // computeNet from settlement.js
}

// Called by: openResultsView, applyForceBalance
function renderResultCards() {
  const list        = document.getElementById('results-list');
  list.innerHTML    = '';

  // Re-sort by adjusted net each render
  const sorted = [...currentSorted].sort((a, b) => getNet(b) - getNet(a));

  sorted.forEach((p, i) => {
    const buyin       = totalBuyin(p.buyins);
    const chips       = p.final_chips ?? 0;
    const net         = getNet(p);
    const rawNet      = Math.round((chips - buyin) * 100) / 100;
    const isAdjusted  = adjustedNets?.has(p.id) && net !== rawNet;

    const rankClass = i === 0 ? 'result-rank-1' : i === 1 ? 'result-rank-2' : i === 2 ? 'result-rank-3' : '';
    const medalClass = ['gold', 'silver', 'bronze'][i] ?? '';
    // Hellfire for the rock-bottom loser — last place AND in the red (and >1 player).
    const hellClass = (i === sorted.length - 1 && net < 0 && sorted.length > 1) ? 'rock-bottom' : '';
    const card = document.createElement('div');
    card.className = `result-card ${net > 0 ? 'winner' : net < 0 ? 'loser' : ''} ${rankClass} ${hellClass}`.trim();
    card.innerHTML = `
      <span class="result-rank ${medalClass}">${i + 1}</span>
      <div class="result-info">
        <span class="result-name">${p.player_name}</span>
        <span class="result-detail">in ${CUR}${buyin} · out ${CUR}${chips}${isAdjusted ? ' · <span class="adj-badge">adj</span>' : ''}</span>
      </div>
      <span class="net-gain ${net > 0 ? 'positive' : net < 0 ? 'negative' : 'zero'}">
        ${net >= 0 ? '+' : ''}${CUR}${net}
      </span>`;
    list.appendChild(card);
  });
}

// Calculates minimum transactions to settle all debts.
// Delegates to the tested pure function in settlement.js.
// Called by: renderSettlements
function calculateSettlements() {
  return minimalSettlements(
    currentSorted.map(p => ({ name: p.player_name, net: getNet(p) }))
  );
}

// Called by: openResultsView, applyForceBalance
function renderSettlements() {
  const settlements = calculateSettlements();
  const el = document.getElementById('settlements-list');
  el.innerHTML = '';

  if (!settlements.length) {
    el.innerHTML = '<p class="no-settlements">No payments needed — everyone is square.</p>';
    return;
  }

  settlements.forEach(t => {
    const row = document.createElement('div');
    row.className = 'settlement-row';
    row.innerHTML = `
      <span class="settlement-from">${t.from}</span>
      <span class="settlement-arrow">→</span>
      <span class="settlement-to">${t.to}</span>
      <span class="settlement-amount">${CUR}${t.amount}</span>`;
    el.appendChild(row);
  });
}

// Called by: openResultsView, applyForceBalance
function renderBalanceCheck() {
  const totalNet  = currentSorted.reduce((sum, p) => sum + getNet(p), 0);
  const D         = Math.round(totalNet * 100) / 100;
  const el        = document.getElementById('balance-check');
  const wasForced = adjustedNets !== null;

  if (Math.abs(D) < 0.01) {
    if (wasForced) {
      const amount  = Math.abs(originalDiscrepancy);
      const action  = originalDiscrepancy < 0
        ? `${CUR}${amount} removed from losers' losses`
        : `${CUR}${amount} removed from winners' gains`;
      el.className = 'balance-check balanced forced';
      el.innerHTML = `
        <span class="balance-check-icon"><svg class="icon"><use href="#i-check"/></svg></span>
        <div class="balance-check-body">
          <div>${action}</div>
          <div class="balance-check-detail">Winners unchanged — losers absorbed the discrepancy</div>
        </div>
        <button class="btn btn-force" id="btn-reset-balance">Reset</button>`;
      document.getElementById('btn-reset-balance').addEventListener('click', resetForceBalance);
    } else {
      el.className = 'hidden';
    }
    return;
  }

  // Determine direction and who absorbs
  const isNegative = D < 0;
  const absD       = Math.abs(D);

  // Negative D → needs losers to reduce. Positive D → needs winners to reduce.
  const hasLosers  = currentSorted.some(p => ((p.final_chips ?? 0) - totalBuyin(p.buyins)) < 0);
  const hasWinners = currentSorted.some(p => ((p.final_chips ?? 0) - totalBuyin(p.buyins)) > 0);
  const canForce   = (isNegative ? hasLosers : hasWinners) && isAdmin();

  const mainMsg = isNegative
    ? `${CUR}${absD} in chips missing from count`
    : `${CUR}${absD} more chips counted than exist`;
  const hintMsg = isNegative
    ? `Losers' losses will be reduced — winners unchanged`
    : `Winners' gains will be reduced — losers unchanged`;

  el.className = 'balance-check unbalanced';
  el.innerHTML = `
    <span class="balance-check-icon"><svg class="icon"><use href="#i-alert"/></svg></span>
    <div class="balance-check-body">
      <div>${mainMsg}</div>
      <div class="balance-check-detail">${hintMsg}</div>
    </div>
    ${canForce ? `<button class="btn btn-force" id="btn-force-balance">Force Balance</button>` : ''}`;

  document.getElementById('btn-force-balance')?.addEventListener('click', applyForceBalance);
}

// Negative D → reduce losers' losses proportionally. Winners unchanged.
// Positive D → reduce winners' gains proportionally. Losers unchanged.
// Called by: Force Balance button
function applyForceBalance() {
  // Raw chip values → tested pure forceBalance() in settlement.js
  const rawNets = currentSorted.map(p => ({ id: p.id, net: computeNet(p.final_chips, p.buyins) }));
  const result  = forceBalance(rawNets);

  if (!result) return;                                                        // already balanced
  if (result.error === 'no-losers')  { toast("Can't spread — no losers.",  'info'); return; }
  if (result.error === 'no-winners') { toast("Can't spread — no winners.", 'info'); return; }

  originalDiscrepancy = result.discrepancy;
  adjustedNets        = result.adjusted;

  renderResultCards();
  renderSettlements();
  renderBalanceCheck();
}

document.getElementById('btn-back-results-home').addEventListener('click', () => {
  clearSessionTimer();
  loadHome();
});

document.getElementById('btn-reopen-session').addEventListener('click', () => {
  document.getElementById('modal-reopen-confirm').classList.remove('hidden');
});

document.getElementById('reopen-confirm-cancel').addEventListener('click', () => {
  document.getElementById('modal-reopen-confirm').classList.add('hidden');
});

document.getElementById('reopen-confirm-ok').addEventListener('click', async () => {
  document.getElementById('modal-reopen-confirm').classList.add('hidden');
  // Clear every player's chips in parallel (async-parallel), then reactivate.
  await Promise.all(currentPlayers.map(p =>
    api(`/session-players/${p.id}`, 'PATCH', { final_chips: null })
  ));
  await api(`/sessions/${currentSession.id}`, 'PATCH', { status: 'active' });
  currentSession.status = 'active';
  document.getElementById('btn-settle').textContent = 'Settle Up';
  document.getElementById('btn-blinds-timer').classList.remove('hidden'); // re-opened sessions can use the timer again
  await loadPlayers();
  show('view-session', 'back');
  clearSessionTimer();
  const timerEl = document.getElementById('session-timer');
  timerEl.classList.remove('hidden');
  updateSessionTimer(currentSession.created_at);
  sessionTimerInterval = setInterval(() => updateSessionTimer(currentSession.created_at), 60000);
  toast('Session re-opened.', 'success');
});

document.getElementById('btn-copy-settlements').addEventListener('click', () => {
  const settlements = calculateSettlements();
  if (!settlements.length) { toast('Everyone is square — nothing to copy.', 'info'); return; }
  const text = settlements.map(t => `${t.from} → ${t.to}  ${CUR}${t.amount}`).join('\n');
  navigator.clipboard.writeText(text).then(
    ()  => toast('Settlements copied!', 'success'),
    ()  => toast('Could not access clipboard.', 'error')
  );
});

// Undoes force balance and restores raw chip values.
// Called by: Reset button in renderBalanceCheck
function resetForceBalance() {
  adjustedNets        = null;
  originalDiscrepancy = null;
  renderResultCards();
  renderSettlements();
  renderBalanceCheck();
}

/* ═══════════════════════════════════════════════════════════════
   DASHBOARD VIEW
   ═══════════════════════════════════════════════════════════════ */

async function loadDashboard() {
  show('view-dashboard');

  const leaderEl     = document.getElementById('dash-leader');
  const winEl        = document.getElementById('dash-top-win');
  const lossEl       = document.getElementById('dash-top-loss');
  const winStreakEl  = document.getElementById('dash-win-streak');
  const lossStreakEl = document.getElementById('dash-loss-streak');
  const potEl        = document.getElementById('dash-pot');
  const hellEl       = document.getElementById('dash-hell');
  const payEl        = document.getElementById('dash-top-payer');
  const avgEl        = document.getElementById('dash-avg-payer');

  // Skeleton while fetching
  leaderEl.innerHTML =
    `<div class="dash-skeleton">
       <div class="skeleton-line w-40" style="margin:0 auto 10px"></div>
       <div class="skeleton-line w-60" style="margin:0 auto 10px"></div>
       <div class="skeleton-line w-30" style="margin:0 auto"></div>
     </div>`;
  [winEl, lossEl, winStreakEl, lossStreakEl, potEl, payEl, avgEl].forEach(el =>
    el.innerHTML = '<div class="skeleton-line w-75"></div>');
  hellEl.classList.remove('rock-bottom');
  hellEl.innerHTML = '<div class="skeleton-line w-75"></div>';

  const { stats, allResults, sessions, sessionPots, error } = await fetchStats();

  if (error || !stats || !Object.keys(stats).length) {
    leaderEl.innerHTML = '<p class="empty-state" style="padding:32px 0">No settled sessions yet.</p>';
    [winEl, lossEl, winStreakEl, lossStreakEl, potEl, payEl, avgEl].forEach(el =>
      el.innerHTML = '<p class="dash-stat-empty">No data yet</p>');
    hellEl.classList.remove('rock-bottom');
    hellEl.innerHTML = '<p class="dash-stat-empty">No data yet</p>';
    return;
  }

  // ── Settlement records used by several cards below ────────────
  const payments = aggregatePayments(sessions || []);

  // ── Highest total earnings (gross payouts received in settlements) ──
  const received = {};
  for (const p of payments) received[p.to] = round2((received[p.to] || 0) + p.total);
  const earner = Object.entries(received)
    .map(([name, total]) => ({ name, total }))
    .sort((a, b) => b.total - a.total)[0];

  leaderEl.innerHTML = earner
    ? `<div class="dash-coin"><svg class="dash-coin-svg"><use href="#i-poker-chip"/></svg></div>
       <div class="dash-leader-name">${earner.name}</div>
       <div class="dash-leader-net">${CUR}${earner.total}</div>
       <div class="dash-leader-meta">highest total earnings · paid out to them</div>`
    : '<p class="empty-state" style="padding:32px 0">No payouts yet.</p>';

  // ── Best single-session win ───────────────────────────────────
  const bigWin  = [...allResults].filter(r => r.net > 0).sort((a, b) => b.net - a.net)[0];
  const bigLoss = [...allResults].filter(r => r.net < 0).sort((a, b) => a.net - b.net)[0];

  winEl.innerHTML = bigWin
    ? `<div class="dash-stat-amount positive">+${CUR}${bigWin.net}</div>
       <div class="dash-stat-name">${bigWin.name}</div>
       <div class="dash-stat-session">${bigWin.sessionName}</div>`
    : '<p class="dash-stat-empty">No wins yet</p>';

  lossEl.innerHTML = bigLoss
    ? `<div class="dash-stat-amount negative">-${CUR}${Math.abs(bigLoss.net)}</div>
       <div class="dash-stat-name">${bigLoss.name}</div>
       <div class="dash-stat-session">${bigLoss.sessionName}</div>`
    : '<p class="dash-stat-empty">No losses yet</p>';

  // ── Longest win / losing streaks across every player ─────────
  const streaks = Object.values(stats).map(p => ({ name: p.name, ...longestStreaks(p.results) }));
  const bestWinStreak  = streaks.filter(s => s.win  >= 2).sort((a, b) => b.win  - a.win)[0];
  const bestLossStreak = streaks.filter(s => s.loss >= 2).sort((a, b) => b.loss - a.loss)[0];

  winStreakEl.innerHTML = bestWinStreak
    ? `<div class="dash-stat-amount streak-win">${bestWinStreak.win}W</div>
       <div class="dash-stat-name">${bestWinStreak.name}</div>
       <div class="dash-stat-session">in a row</div>`
    : '<p class="dash-stat-empty">No streak yet</p>';

  lossStreakEl.innerHTML = bestLossStreak
    ? `<div class="dash-stat-amount streak-loss">${bestLossStreak.loss}L</div>
       <div class="dash-stat-name">${bestLossStreak.name}</div>
       <div class="dash-stat-session">in a row</div>`
    : '<p class="dash-stat-empty">No streak yet</p>';

  // ── Highest recorded total pot (biggest single-session pot) ──
  const bigPot = [...(sessionPots || [])].sort((a, b) => b.pot - a.pot)[0];
  potEl.innerHTML = (bigPot && bigPot.pot > 0)
    ? `<p class="dash-stat-label"><svg class="icon"><use href="#i-coins"/></svg> Highest Total Pot</p>
       <div class="dash-stat-amount pot">${CUR}${bigPot.pot}</div>
       <div class="dash-stat-name">${bigPot.name}</div>
       ${bigPot.date ? `<div class="dash-stat-session">${formatDate(bigPot.date)}</div>` : ''}`
    : `<p class="dash-stat-label"><svg class="icon"><use href="#i-coins"/></svg> Highest Total Pot</p>
       <p class="dash-stat-empty">No pots yet</p>`;

  // ── Person in Hell — last place overall, in the red (needs ≥2 players) ──
  const ranked = Object.values(stats).sort((a, b) => a.totalNet - b.totalNet);
  const hell   = (ranked.length > 1 && ranked[0].totalNet < 0) ? ranked[0] : null;
  hellEl.classList.toggle('rock-bottom', !!hell);
  hellEl.innerHTML = hell
    ? `${embersHTML(12)}<p class="dash-stat-label"><svg class="icon"><use href="#i-trending-down"/></svg> Person in Hell</p>
       <div class="dash-stat-amount negative">-${CUR}${Math.abs(hell.totalNet)}</div>
       <div class="dash-stat-name">${hell.name}</div>
       <div class="dash-stat-session">last place overall</div>`
    : `<p class="dash-stat-label"><svg class="icon"><use href="#i-trending-down"/></svg> Person in Hell</p>
       <p class="dash-stat-empty">Nobody's underwater</p>`;

  // ── Settlement records — who has paid who the most (total + per-game avg) ──
  const topPay   = [...payments].sort((a, b) => b.total - a.total)[0];
  // "On average" is only meaningful over repeat payments; prefer pairs seen 2+
  // times, else fall back to all.
  const repeat   = payments.filter(p => p.count >= 2);
  const avgPay   = (repeat.length ? repeat : payments)
    .map(p => ({ ...p, avg: round2(p.total / p.count) }))
    .sort((a, b) => b.avg - a.avg)[0];

  payEl.innerHTML = topPay
    ? `<div class="dash-stat-amount">${CUR}${topPay.total}</div>
       <div class="dash-stat-name">${topPay.from} → ${topPay.to}</div>
       <div class="dash-stat-session">${topPay.count} game${topPay.count !== 1 ? 's' : ''}</div>`
    : '<p class="dash-stat-empty">No payments yet</p>';

  avgEl.innerHTML = avgPay
    ? `<div class="dash-stat-amount">${CUR}${avgPay.avg}</div>
       <div class="dash-stat-name">${avgPay.from} → ${avgPay.to}</div>
       <div class="dash-stat-session">avg · ${avgPay.count} game${avgPay.count !== 1 ? 's' : ''}</div>`
    : '<p class="dash-stat-empty">No payments yet</p>';
}

// Aggregate who-pays-who across all settled sessions. Runs the app's own
// minimal-settlement math per session, then sums each from→to pair.
// Returns [{ from, to, total, count }].
function aggregatePayments(sessions) {
  const pairs = {};
  for (const players of sessions) {
    minimalSettlements(players.map(p => ({ name: p.name, net: p.net }))).forEach(t => {
      const key = `${t.from}${t.to}`;
      (pairs[key] ??= { from: t.from, to: t.to, total: 0, count: 0 });
      pairs[key].total = round2(pairs[key].total + t.amount);
      pairs[key].count++;
    });
  }
  return Object.values(pairs);
}

document.getElementById('btn-new-session-dash').addEventListener('click', openNewSessionModal);

/* ═══════════════════════════════════════════════════════════════
   BOTTOM NAVIGATION
   ═══════════════════════════════════════════════════════════════ */

const DETAIL_VIEWS = new Set(['view-session', 'view-settle', 'view-results']);

// Called by: everywhere. dir: 'forward' | 'back' | 'none'
function show(viewId, dir = 'none') {
  document.querySelectorAll('.view').forEach(v =>
    v.classList.remove('active', 'slide-forward', 'slide-back')
  );
  const view = document.getElementById(viewId);
  view.classList.add('active');
  if (dir === 'forward') view.classList.add('slide-forward');
  if (dir === 'back')    view.classList.add('slide-back');

  const nav = document.getElementById('bottom-nav');
  DETAIL_VIEWS.has(viewId) ? nav.classList.add('hidden') : nav.classList.remove('hidden');
}

/* ── Float-in tiles ───────────────────────────────────────────────
   Cards rise + fade as they scroll into view, and whenever a page renders
   (new tiles start hidden, then float in when they intersect the viewport —
   which fires immediately for whatever's on-screen after a page change).
   IntersectionObserver-driven; degrades to fully-visible if unsupported. */
const FLOAT_SELECTOR = '.session-card, .player-card, .result-card, .lb-card';
const floatObserver = ('IntersectionObserver' in window)
  ? new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add('floated-in');
          floatObserver.unobserve(e.target);
        }
      }
    }, { threshold: 0.06, rootMargin: '0px 0px -4% 0px' })
  : null;

function revealTiles() {
  if (!floatObserver) return;
  let i = 0;
  document.querySelectorAll(FLOAT_SELECTOR).forEach((el) => {
    if (el.dataset.float) return;          // already armed
    el.dataset.float = '1';
    el.classList.add('float-tile');
    el.style.animationDelay = `${(i++ % 5) * 45}ms`;  // light cascade per batch
    floatObserver.observe(el);
  });
}

if (floatObserver) {
  document.body.classList.add('js-float');
  // Re-arm new tiles on every render (runs before paint, so no flash of visible).
  new MutationObserver(revealTiles).observe(document.body, { childList: true, subtree: true });
  revealTiles();
}

// Bottom nav buttons
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.view;
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    if (currentMode === 'casino') {
      if (target === 'dashboard')   { show('view-casino-dashboard'); loadCasinoDashboard(); }
      if (target === 'sessions')    { show('view-casino-visits');    loadCasinoVisits();    }
      if (target === 'records')     { show('view-casino-stats');     loadCasinoStats();     }
      if (target === 'leaderboard') { show('view-casino-timer');     initCasinoTimer();     }
    } else {
      if (target === 'dashboard')   { show('view-dashboard');   loadDashboard();   }
      if (target === 'sessions')    { show('view-sessions');    loadSessions();    }
      if (target === 'records')     { show('view-records');     loadRecords();     }
      if (target === 'leaderboard') { show('view-leaderboard'); loadLeaderboard(); }
    }
  });
});

// Records sub-tabs (Records / Averages)
document.querySelectorAll('.sub-tab[data-sub]').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.sub-tab[data-sub]').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const target = tab.dataset.sub;
    document.getElementById('rec-main').classList.toggle('hidden', target !== 'rec-main');
    document.getElementById('rec-avg').classList.toggle('hidden',  target !== 'rec-avg');
  });
});

// Leaderboard sub-tabs (Rankings / P&L Chart)
document.querySelectorAll('.sub-tab[data-lb-sub]').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.sub-tab[data-lb-sub]').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const target = tab.dataset.lbSub;
    document.getElementById('lb-rankings').classList.toggle('hidden', target !== 'lb-rankings');
    document.getElementById('lb-chart').classList.toggle('hidden',    target !== 'lb-chart');
    if (target === 'lb-chart') loadPLChart();
  });
});

/* ═══════════════════════════════════════════════════════════════
   SHARED STATS FETCH
   Used by both Leaderboard and Records views.
   ═══════════════════════════════════════════════════════════════ */

async function fetchStats() {
  const { data, error } = await api('/stats');
  if (error) return { error };

  const stats       = {};
  const allResults  = [];
  const sessionsMap = {};   // session key -> [{ name, net }], for settlement records
  const potsMap     = {};   // session key -> { name, date, pot }, for the biggest-pot record

  (data || []).forEach(p => {
    const key         = p.player_name.toLowerCase().trim();
    const buyin       = (p.buyins || []).reduce((s, b) => s + Number(b.amount), 0);
    const net         = Math.round(((p.final_chips ?? 0) - buyin) * 100) / 100;
    const sessionName = p.session_name ?? 'Unknown session';
    const sessionDate = p.session_date;

    if (!stats[key]) {
      stats[key] = { name: p.player_name, sessions: 0, wins: 0, losses: 0, totalNet: 0, totalWon: 0, totalLost: 0, results: [] };
    }
    stats[key].sessions++;
    stats[key].results.push({ net, date: sessionDate });
    stats[key].totalNet = Math.round((stats[key].totalNet + net) * 100) / 100;
    if (net > 0) {
      stats[key].wins++;
      stats[key].totalWon = Math.round((stats[key].totalWon + net) * 100) / 100;
    } else if (net < 0) {
      stats[key].losses++;
      stats[key].totalLost = Math.round((stats[key].totalLost + Math.abs(net)) * 100) / 100;
    }
    allResults.push({ name: p.player_name, sessionName, net });
    const sKey = (sessionDate || '') + '|' + sessionName;
    (sessionsMap[sKey] ??= []).push({ name: p.player_name, net });
    (potsMap[sKey] ??= { name: sessionName, date: sessionDate, pot: 0 });
    potsMap[sKey].pot = Math.round((potsMap[sKey].pot + buyin) * 100) / 100;
  });

  return { stats, allResults, sessions: Object.values(sessionsMap), sessionPots: Object.values(potsMap) };
}

// Returns { count, type: 'win'|'loss' } if current streak is ≥ 2, else null.
// Called by: loadLeaderboard, buildPodium
function computeStreak(results) {
  if (!results || results.length < 2) return null;
  const sorted = [...results].sort((a, b) => new Date(b.date) - new Date(a.date));
  const type   = sorted[0].net > 0 ? 'win' : sorted[0].net < 0 ? 'loss' : null;
  if (!type) return null;
  let count = 0;
  for (const r of sorted) {
    if (type === 'win'  && r.net > 0) count++;
    else if (type === 'loss' && r.net < 0) count++;
    else break;
  }
  return count >= 2 ? { count, type } : null;
}

// Longest run of consecutive wins and losses over a player's whole history
// (chronological). Returns { win, loss } counts. Called by: loadDashboard.
function longestStreaks(results) {
  if (!results || !results.length) return { win: 0, loss: 0 };
  const sorted = [...results].sort((a, b) => new Date(a.date) - new Date(b.date));
  let win = 0, loss = 0, curWin = 0, curLoss = 0;
  for (const r of sorted) {
    if (r.net > 0)      { curWin++;  curLoss = 0; }
    else if (r.net < 0) { curLoss++; curWin  = 0; }
    else                { curWin = 0; curLoss = 0; }
    if (curWin  > win)  win  = curWin;
    if (curLoss > loss) loss = curLoss;
  }
  return { win, loss };
}

// Rising-embers markup for the hell cards: n glowing motes, each with its own
// size/speed/delay/drift so they drift up and fade independently. CSS in
// .ember / @keyframes emberRise. Called by: loadDashboard, loadLeaderboard.
function embersHTML(n) {
  let s = '<div class="embers" aria-hidden="true">';
  for (let i = 0; i < n; i++) {
    const dur = 2.6 + Math.random() * 2.8;
    s += `<span class="ember" style="`
       + `--x:${Math.round(Math.random() * 100)}%;`
       + `--size:${(2 + Math.random() * 2.4).toFixed(1)}px;`
       + `--dur:${dur.toFixed(2)}s;--delay:${(-Math.random() * dur).toFixed(2)}s;`
       + `--drift:${Math.round((Math.random() - 0.5) * 40)}px;`
       + `--rise:-${Math.round(85 + Math.random() * 75)}px;`
       + `--op:${(0.55 + Math.random() * 0.4).toFixed(2)}"></span>`;
  }
  return s + '</div>';
}

/* ── Leaderboard view — rankings only ──────────────────────────── */

async function loadLeaderboard() {
  const list = document.getElementById('leaderboard-list');
  list.innerHTML = skeletonHTML(5);

  const { stats, error } = await fetchStats();
  if (error) { list.innerHTML = `<p class="empty-state">Error: ${error.message}</p>`; return; }
  if (!stats || !Object.keys(stats).length) {
    list.innerHTML = '<p class="empty-state">No settled sessions yet.</p>'; return;
  }

  const sorted   = Object.values(stats).sort((a, b) => b.totalNet - a.totalNet);
  list.innerHTML = '';

  // ── Podium (top 1–3) ──────────────────────────────────────────
  if (sorted.length >= 1) {
    list.appendChild(buildPodium(sorted));
  }

  // ── Remaining players (#4 onwards) ────────────────────────────
  const rest = sorted.slice(3);
  rest.forEach((p, i) => {
    const rank      = i + 4;
    const netClass  = p.totalNet > 0 ? 'positive' : p.totalNet < 0 ? 'negative' : 'zero';
    const netStr    = `${p.totalNet >= 0 ? '+' : ''}${CUR}${p.totalNet}`;
    const winRate   = Math.round((p.wins / p.sessions) * 100);
    const streak    = computeStreak(p.results);
    const streakStr = streak ? ` · ${streak.type === 'win' ? '🔥' : '🥀'} ${streak.count}${streak.type === 'win' ? 'W' : 'L'}` : '';

    const card = document.createElement('div');
    // Last place in the red gets the hellfire treatment.
    const isHell = (i === rest.length - 1 && p.totalNet < 0);
    card.className = isHell ? 'lb-card rock-bottom' : 'lb-card';
    card.innerHTML = `
      ${isHell ? embersHTML(7) : ''}
      <span class="lb-rank">#${rank}</span>
      <div class="lb-info">
        <span class="lb-name">${p.name}</span>
        <span class="lb-meta">${p.sessions} session${p.sessions !== 1 ? 's' : ''} · ${winRate}% wins${streakStr}</span>
      </div>
      <span class="lb-net ${netClass}">${netStr}</span>`;
    card.addEventListener('click', () => openPlayerHistory(p.name));
    list.appendChild(card);
  });
}

// Fun floating decorations above podium ranks 2 & 3, configured in config.js via
// RANK_BADGES ({ 2: {...}, 3: {...} }). The jester is built-in; an { img } entry
// floats a local image. Keep third-party logos personal-only — config.js never
// ships in the resale package, so trademarked badges stay out of buyer builds.
const JESTER_SVG = `<svg viewBox="0 0 24 24" class="podium-deco-svg" aria-hidden="true"><polygon points="3,17 6,6 10,13.5 12,5 14,13.5 18,6 21,17" fill="#9D7AD6"/><rect x="2.5" y="16" width="19" height="3" rx="1.5" fill="#7E5BB8"/><circle cx="6" cy="5.4" r="1.7" fill="#E7C66B"/><circle cx="12" cy="4.3" r="1.7" fill="#E7C66B"/><circle cx="18" cy="5.4" r="1.7" fill="#E7C66B"/></svg>`;

function rankDecoHTML(rank) {
  const cfg = (typeof RANK_BADGES !== 'undefined' && RANK_BADGES) ? RANK_BADGES[rank] : null;
  if (!cfg) return '';
  if (cfg.icon === 'jester') return `<div class="podium-deco">${JESTER_SVG}</div>`;
  if (cfg.img)  return `<div class="podium-deco"><img class="podium-deco-img" src="${cfg.img}" alt="" onerror="this.closest('.podium-deco').remove()"></div>`;
  return '';
}

// Builds the podium element for top 1–3 players.
// Arrangement: 2nd · 1st · 3rd (Olympic order).
function buildPodium(sorted) {
  const wrap = document.createElement('div');
  wrap.className = 'podium-wrap';

  // Reorder: [2nd, 1st, 3rd] for visual display
  const slots = [sorted[1], sorted[0], sorted[2]].filter(Boolean);
  const ranks  = sorted[1] ? [2, 1, 3] : [1]; // handle < 3 players

  slots.forEach((p, idx) => {
    const rank     = ranks[idx];
    const netClass = p.totalNet > 0 ? 'positive' : p.totalNet < 0 ? 'negative' : 'zero';
    const netStr   = `${p.totalNet >= 0 ? '+' : ''}${CUR}${p.totalNet}`;
    const winRate   = Math.round((p.wins / p.sessions) * 100);
    const streak    = computeStreak(p.results);
    const streakStr = streak ? ` · ${streak.type === 'win' ? '🔥' : '🥀'} ${streak.count}${streak.type === 'win' ? 'W' : 'L'}` : '';

    const step = document.createElement('div');
    step.className = `podium-step podium-rank-${rank}`;

    step.innerHTML = `
      ${rank === 1 ? `
        <div class="champion-crown">
          <span class="crown-icon"><svg class="icon"><use href="#i-crown"/></svg></span>
          <span class="crown-text">Champion</span>
        </div>` : rankDecoHTML(rank)}
      <div class="podium-info">
        <span class="podium-medal">${rank}</span>
        <span class="podium-name">${p.name}</span>
        <span class="podium-net ${netClass}">${netStr}</span>
        <span class="podium-meta">${p.sessions} session${p.sessions !== 1 ? 's' : ''} · ${winRate}% wins${streakStr}</span>
      </div>
      <div class="podium-block">
        <span class="podium-rank-num">${rank}</span>
      </div>`;

    step.addEventListener('click', () => openPlayerHistory(p.name));
    wrap.appendChild(step);
  });

  return wrap;
}

/* ── Records view — records + averages ─────────────────────────── */

async function loadRecords() {
  const empty = '<p class="empty-state" style="padding:16px 0">No data yet.</p>';
  ['lb-total-won','lb-biggest-win','lb-biggest-loss',
   'lb-avg-net','lb-avg-win','lb-avg-loss',
   'lb-attendance','lb-consistent'].forEach(id => {
    document.getElementById(id).innerHTML = '<p class="empty-state" style="padding:16px 0">Loading…</p>';
  });

  const { stats, allResults, error } = await fetchStats();
  if (error || !stats) {
    ['lb-total-won','lb-biggest-win','lb-biggest-loss',
     'lb-avg-net','lb-avg-win','lb-avg-loss',
     'lb-attendance','lb-consistent'].forEach(id => {
      document.getElementById(id).innerHTML = empty;
    });
    return;
  }

  // Most Money Won (top 3)
  renderRecords('lb-total-won',
    Object.values(stats).filter(p => p.totalWon > 0)
      .sort((a, b) => b.totalWon - a.totalWon).slice(0, 3)
      .map(p => ({ name: p.name, sessionName: `across ${p.wins} winning session${p.wins !== 1 ? 's' : ''}`, net: p.totalWon })),
    'total');

  // Biggest Win — record holder only
  renderRecords('lb-biggest-win',
    [...allResults].filter(r => r.net > 0).sort((a, b) => b.net - a.net).slice(0, 1),
    'win');

  // Biggest Loss — record holder only
  renderRecords('lb-biggest-loss',
    [...allResults].filter(r => r.net < 0).sort((a, b) => a.net - b.net).slice(0, 1),
    'loss');

  // Avg Net per session (top 3)
  renderRecords('lb-avg-net',
    Object.values(stats).filter(p => p.sessions > 0)
      .map(p => ({ name: p.name, sessionName: `across ${p.sessions} session${p.sessions !== 1 ? 's' : ''}`, net: Math.round((p.totalNet / p.sessions) * 100) / 100 }))
      .sort((a, b) => b.net - a.net).slice(0, 3),
    'total');

  // Avg Win per winning session (top 3)
  renderRecords('lb-avg-win',
    Object.values(stats).filter(p => p.wins > 0)
      .map(p => ({ name: p.name, sessionName: `across ${p.wins} winning session${p.wins !== 1 ? 's' : ''}`, net: Math.round((p.totalWon / p.wins) * 100) / 100 }))
      .sort((a, b) => b.net - a.net).slice(0, 3),
    'win');

  // Avg Loss per losing session (top 3)
  renderRecords('lb-avg-loss',
    Object.values(stats).filter(p => p.losses > 0)
      .map(p => ({ name: p.name, sessionName: `across ${p.losses} losing session${p.losses !== 1 ? 's' : ''}`, net: -Math.round((p.totalLost / p.losses) * 100) / 100 }))
      .sort((a, b) => a.net - b.net).slice(0, 3),
    'loss');

  // Most sessions attended (top 3)
  renderRecords('lb-attendance',
    Object.values(stats)
      .sort((a, b) => b.sessions - a.sessions)
      .slice(0, 3)
      .map(p => ({
        name:       p.name,
        sessionName: `${p.sessions} session${p.sessions !== 1 ? 's' : ''} played`,
        net:         p.sessions,
        displayVal:  `${p.sessions} ✓`,
      })),
    'attendance');

  // Most consistent — lowest std dev, min 3 sessions
  const consistentData = Object.values(stats)
    .filter(p => p.sessions >= 3)
    .map(p => {
      const nets     = p.results.map(r => r.net);
      const mean     = nets.reduce((s, v) => s + v, 0) / nets.length;
      const variance = nets.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / nets.length;
      const sd       = Math.round(Math.sqrt(variance) * 100) / 100;
      return { name: p.name, sessions: p.sessions, sd };
    })
    .sort((a, b) => a.sd - b.sd)
    .slice(0, 3)
    .map(p => ({
      name:        p.name,
      sessionName: `${p.sessions} sessions · ±${CUR}${p.sd} avg swing`,
      net:         p.sd,
      displayVal:  `±${CUR}${p.sd}`,
    }));

  renderRecords('lb-consistent', consistentData, 'consistent');
}

// Called by: loadLeaderboard — renders win or loss record cards
function renderRecords(containerId, records, type) {
  const el          = document.getElementById(containerId);
  el.innerHTML      = '';

  if (!records.length) {
    el.innerHTML = '<p class="empty-state" style="padding:16px 0">No data yet.</p>';
    return;
  }

  records.forEach((r, i) => {
    const sign      = r.net > 0 ? '+' : '';
    const amount    = r.displayVal ?? `${sign}${CUR}${Math.abs(r.net)}`;
    const rankClass = i === 0 ? 'result-rank-1' : i === 1 ? 'result-rank-2' : i === 2 ? 'result-rank-3' : '';
    const card   = document.createElement('div');
    card.className = `lb-record-card ${type}-card ${rankClass}`.trim();
    card.innerHTML = `
      <span class="lb-record-rank ${['gold', 'silver', 'bronze'][i] ?? ''}">#${i + 1}</span>
      <div class="lb-record-info">
        <span class="lb-record-name">${r.name}</span>
        <span class="lb-record-session">${r.sessionName}</span>
      </div>
      <span class="lb-record-amount ${type}">${amount}</span>`;
    el.appendChild(card);
  });
}

/* ═══════════════════════════════════════════════════════════════
   P&L CHART
   ═══════════════════════════════════════════════════════════════ */

let plChartInstance = null;

async function loadPLChart() {
  const wrapEl = document.getElementById('lb-chart');
  wrapEl.innerHTML = `
    <div class="chart-wrap"><canvas id="pl-chart-canvas"></canvas></div>
    <div id="pl-legend" class="pl-legend"></div>`;

  if (plChartInstance) { plChartInstance.destroy(); plChartInstance = null; }

  const { data: rawData, error } = await api('/stats');
  if (error || !rawData?.length) {
    wrapEl.innerHTML = '<p class="empty-state">No settled sessions yet.</p>';
    return;
  }

  // Group by session date, accumulate per player
  const sessionMap = new Map();
  for (const row of rawData) {
    if (!sessionMap.has(row.session_date)) {
      sessionMap.set(row.session_date, { name: row.session_name, date: row.session_date, players: {} });
    }
    const buyin = (row.buyins || []).reduce((s, b) => s + Number(b.amount), 0);
    sessionMap.get(row.session_date).players[row.player_name] =
      Math.round(((row.final_chips ?? 0) - buyin) * 100) / 100;
  }

  const sessions   = [...sessionMap.values()].sort((a, b) => new Date(a.date) - new Date(b.date));
  const labels     = sessions.map(s => formatDate(s.date));
  const allPlayers = [...new Set(rawData.map(r => r.player_name))];

  const COLORS = ['#2FB67D','#f0b429','#E5484D','#38bdf8','#a78bfa','#fb923c','#34d399','#f472b6','#94a3b8','#fbbf24'];

  const datasets = allPlayers.map((player, i) => {
    let cumulative = 0;
    const data = sessions.map(s => {
      if (s.players[player] !== undefined) {
        cumulative = Math.round((cumulative + s.players[player]) * 100) / 100;
        return cumulative;
      }
      return null;
    });
    if (data.every(d => d === null)) return null;
    const color = COLORS[i % COLORS.length];
    return {
      label: player, data, borderColor: color, backgroundColor: color + '15',
      tension: 0.35, fill: false, spanGaps: true,
      pointRadius: 4, pointHoverRadius: 6, borderWidth: 2.5,
    };
  }).filter(Boolean);

  const ctx = document.getElementById('pl-chart-canvas').getContext('2d');
  plChartInstance = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false }, // replaced by the custom checkbox legend (built below)
        tooltip: {
          backgroundColor: '#101013',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          titleColor: '#ededf0',
          bodyColor:  '#909098',
          padding: 12,
          callbacks: {
            label: ctx => ctx.raw === null ? null : ` ${ctx.dataset.label}:  ${ctx.raw >= 0 ? '+' : ''}${CUR}${ctx.raw}`
          }
        }
      },
      scales: {
        x: {
          ticks:  { color: '#606068', font: { family: 'DM Mono', size: 10 }, maxRotation: 30 },
          grid:   { color: 'rgba(255,255,255,0.04)' },
          border: { color: 'rgba(255,255,255,0.08)' },
        },
        y: {
          ticks:  { color: '#606068', font: { family: 'DM Mono', size: 10 }, callback: v => `${CUR}${v}` },
          grid:   { color: 'rgba(255,255,255,0.04)' },
          border: { color: 'rgba(255,255,255,0.08)' },
        }
      }
    }
  });

  // Custom checkbox legend, rendered outside the chart (replaces Chart.js's
  // built-in legend). Each checkbox toggles that player's line via
  // setDatasetVisibility; the row dims + strikes through when hidden.
  const legendEl = document.getElementById('pl-legend');
  legendEl.innerHTML = datasets.map((ds, i) => `
    <label class="pl-legend-item">
      <input type="checkbox" class="pl-legend-cb" data-idx="${i}" checked>
      <span class="pl-legend-swatch" style="background:${ds.borderColor}"></span>
      <span class="pl-legend-name">${ds.label}</span>
    </label>`).join('');
  legendEl.querySelectorAll('.pl-legend-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      const idx = Number(cb.dataset.idx);
      plChartInstance.setDatasetVisibility(idx, cb.checked);
      plChartInstance.update();
      cb.closest('.pl-legend-item').classList.toggle('off', !cb.checked);
    });
  });
}

/* ── Share Results ───────────────────────────────────────────────── */

document.getElementById('btn-share-results').addEventListener('click', () => {
  const sorted  = [...currentSorted].sort((a, b) => getNet(b) - getNet(a));
  const medals  = ['🥇', '🥈', '🥉'];
  const sep     = '─'.repeat(26);
  const pot     = currentPlayers.reduce((s, p) => s + totalBuyin(p.buyins), 0);

  let text = `🃏 ${currentSession.name} · ${formatDate(currentSession.created_at)}\n${sep}\n`;
  sorted.forEach((p, i) => {
    const net    = getNet(p);
    const netStr = `${net >= 0 ? '+' : ''}${CUR}${net}`;
    text += `${medals[i] ?? ' '} ${p.player_name}: ${netStr}\n`;
  });
  text += `${sep}\n💰 Pot: ${CUR}${pot}`;

  if (navigator.share) {
    navigator.share({ title: `${currentSession.name} Results`, text }).catch(() => {});
  } else {
    navigator.clipboard.writeText(text).then(
      ()  => toast('Results copied!', 'success'),
      ()  => toast('Could not copy', 'error')
    );
  }
});

/* ═══════════════════════════════════════════════════════════════
   PLAYER HISTORY
   ═══════════════════════════════════════════════════════════════ */

// Called by: leaderboard card click, podium step click
async function openPlayerHistory(playerName) {
  document.getElementById('player-history-name').textContent    = playerName;
  document.getElementById('player-history-summary').textContent = 'Loading…';
  document.getElementById('player-history-list').innerHTML      = skeletonHTML(3);
  document.getElementById('modal-player-history').classList.remove('hidden');

  const { data, error } = await api(`/players/${encodeURIComponent(playerName)}/history`);

  const listEl = document.getElementById('player-history-list');

  if (error) {
    listEl.innerHTML = `<p class="empty-state">Error: ${error.message}</p>`;
    document.getElementById('player-history-summary').textContent = '';
    return;
  }

  if (!data || !data.length) {
    listEl.innerHTML = '<p class="empty-state">No settled sessions yet.</p>';
    document.getElementById('player-history-summary').textContent = 'No history';
    return;
  }

  // Sort by session date, newest first
  data.sort((a, b) => new Date(b.session_date) - new Date(a.session_date));

  let wins = 0, totalNet = 0;
  listEl.innerHTML = '';

  data.forEach(row => {
    const buyin = (row.buyins || []).reduce((s, b) => s + Number(b.amount), 0);
    const net   = Math.round(((row.final_chips ?? 0) - buyin) * 100) / 100;
    if (net > 0) wins++;
    totalNet = Math.round((totalNet + net) * 100) / 100;

    const el = document.createElement('div');
    el.className = 'history-row';
    el.innerHTML = `
      <div class="history-row-info">
        <span class="history-session-name">${row.session_name}</span>
        <span class="history-session-date">${formatDate(row.session_date)}</span>
      </div>
      <div class="history-row-right">
        <span class="history-buyin">In ${CUR}${buyin}</span>
        <span class="history-net ${net > 0 ? 'positive' : net < 0 ? 'negative' : 'zero'}">
          ${net >= 0 ? '+' : ''}${CUR}${net}
        </span>
      </div>`;
    listEl.appendChild(el);
  });

  const winRate = Math.round((wins / data.length) * 100);
  const netStr  = `${totalNet >= 0 ? '+' : ''}${CUR}${totalNet}`;
  document.getElementById('player-history-summary').textContent =
    `${data.length} session${data.length !== 1 ? 's' : ''} · ${winRate}% wins · ${netStr} total`;
}

document.getElementById('player-history-close').addEventListener('click', () => {
  document.getElementById('modal-player-history').classList.add('hidden');
});

/* ═══════════════════════════════════════════════════════════════
   UTILITIES
   ═══════════════════════════════════════════════════════════════ */

// totalBuyin() is defined in settlement.js (loaded before app.js) and tested there.

function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric'
  });
}

/* ═══════════════════════════════════════════════════════════════
   SPLASH SCREEN
   Sequence: bar fills → cards deal in → "Royal Flush" glows →
             splash fades out (app already loaded in background)
   ═══════════════════════════════════════════════════════════════ */

function initSplash(onComplete) {
  const splash   = document.getElementById('splash');
  const bar      = document.getElementById('splash-bar');
  const subtext  = document.getElementById('splash-subtext');
  const rfLabel  = document.getElementById('rf-label');
  const cards    = document.querySelectorAll('.playing-card');

  // Eased progress bar — slow start, slight pause near end for drama
  const steps = [
    { pct: 18,  delay: 180  },
    { pct: 35,  delay: 280  },
    { pct: 52,  delay: 260  },
    { pct: 68,  delay: 220  },
    { pct: 79,  delay: 300  },  // brief hesitation
    { pct: 88,  delay: 200  },
    { pct: 94,  delay: 280  },  // another pause near the end
    { pct: 100, delay: 200  },
  ];

  let elapsed = 0;
  steps.forEach(({ pct, delay }) => {
    setTimeout(() => { bar.style.width = pct + '%'; }, elapsed);
    elapsed += delay;
  });

  // Bar done → change text
  setTimeout(() => {
    subtext.style.opacity = '0';
    setTimeout(() => { subtext.textContent = 'Dealing the hand…'; subtext.style.opacity = '1'; }, 200);
  }, elapsed - 100);

  // Deal cards one by one
  const cardStart = elapsed + 100;
  cards.forEach((card, i) => {
    setTimeout(() => card.classList.add('show'), cardStart + i * 130);
  });

  // "Royal Flush" label after last card
  const labelStart = cardStart + cards.length * 130 + 200;
  setTimeout(() => {
    rfLabel.classList.add('show');
    subtext.style.opacity = '0';
    setTimeout(() => { subtext.textContent = '♠ ♥ ♦ ♣'; subtext.style.opacity = '0.4'; }, 200);
  }, labelStart);

  // Fade out splash
  const fadeStart = labelStart + 1100;
  setTimeout(() => {
    splash.classList.add('fade-out');
    document.body.classList.add('bg-dealt'); // deal the ambient card background as the splash dissolves
    setTimeout(() => {
      splash.style.display = 'none';
      if (onComplete) onComplete();
    }, 750);
  }, fadeStart);
}

/* ═══════════════════════════════════════════════════════════════
   WINNER CELEBRATION
   ═══════════════════════════════════════════════════════════════ */

function launchConfetti() {
  // Respect reduced-motion: skip the decorative particle burst entirely
  // (the winner announcement still shows — it conveys the result, not just motion).
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;z-index:998;pointer-events:none;width:100%;height:100%';
  document.body.appendChild(canvas);
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
  const ctx     = canvas.getContext('2d');

  const COLORS  = ['#f0b429','#2FB67D','#E5484D','#ffffff','#C9A24A','#38bdf8'];
  const SHAPES  = ['rect','circle','diamond'];
  const COUNT   = 140;
  const FRAMES  = 220;

  const particles = Array.from({ length: COUNT }, () => ({
    x:        Math.random() * canvas.width,
    y:        -20 - Math.random() * canvas.height * 0.3,
    vx:       (Math.random() - 0.5) * 5,
    vy:       Math.random() * 3 + 1.5,
    size:     Math.random() * 9 + 4,
    color:    COLORS[Math.floor(Math.random() * COLORS.length)],
    rot:      Math.random() * Math.PI * 2,
    rotSpeed: (Math.random() - 0.5) * 0.18,
    shape:    SHAPES[Math.floor(Math.random() * SHAPES.length)],
    wobble:   Math.random() * Math.PI * 2,
  }));

  let frame = 0;
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const alpha = Math.max(0, 1 - frame / FRAMES);

    particles.forEach(p => {
      p.wobble += 0.05;
      p.x  += p.vx + Math.sin(p.wobble) * 0.8;
      p.y  += p.vy;
      p.vy += 0.06;
      p.rot += p.rotSpeed;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle   = p.color;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);

      if (p.shape === 'rect') {
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      } else if (p.shape === 'circle') {
        ctx.beginPath();
        ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(0, -p.size / 2);
        ctx.lineTo(p.size / 2, 0);
        ctx.lineTo(0, p.size / 2);
        ctx.lineTo(-p.size / 2, 0);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    });

    frame++;
    if (frame < FRAMES) requestAnimationFrame(draw);
    else canvas.remove();
  }
  requestAnimationFrame(draw);
}

function showWinnerAnnouncement(name, amount) {
  const el = document.createElement('div');
  el.className = 'winner-overlay';
  el.innerHTML = `
    <div class="winner-card-announce">
      <div class="winner-trophy"><svg class="icon"><use href="#i-trophy"/></svg></div>
      <div class="winner-announce-name">${name}</div>
      <div class="winner-announce-amount">+${CUR}${amount}</div>
      <div class="winner-announce-label">Tonight's Winner</div>
      <button class="winner-dismiss">Tap to continue</button>
    </div>`;
  document.body.appendChild(el);

  requestAnimationFrame(() => el.classList.add('show'));

  const dismiss = () => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 500);
  };

  el.querySelector('.winner-dismiss').addEventListener('click', dismiss);
  setTimeout(dismiss, 4000);
}

/* ═══════════════════════════════════════════════════════════════
   MODE SELECTOR & CASINO MODE
   ═══════════════════════════════════════════════════════════════ */

// Called by: mode card click, switchMode()
function updateModeUI(mode) {
  const btns = document.querySelectorAll('.nav-btn');
  const setNavIcon = (btn, id) => btn.querySelector('.nav-icon use').setAttribute('href', id);
  document.body.classList.toggle('mode-home',   mode === 'home');
  document.body.classList.toggle('mode-casino', mode === 'casino');
  if (mode === 'casino') {
    setNavIcon(btns[1], '#i-dice');
    btns[1].querySelector('.nav-label').textContent = 'Visits';
    btns[3].style.display = '';
    setNavIcon(btns[3], '#i-clock');
    btns[3].querySelector('.nav-label').textContent = 'Timer';
  } else {
    setNavIcon(btns[1], '#i-layers');
    btns[1].querySelector('.nav-label').textContent = 'Sessions';
    btns[3].style.display = '';
    setNavIcon(btns[3], '#i-trophy');
    btns[3].querySelector('.nav-label').textContent = 'Leaderboard';
  }
}

function switchMode(mode) {
  localStorage.setItem('poker_mode', mode);
  currentMode = mode;
  document.getElementById('mode-select').classList.add('hidden');
  updateModeUI(mode);
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.nav-btn[data-view="dashboard"]').classList.add('active');
  if (mode === 'casino') loadCasinoDashboard();
  else loadDashboard();
}

document.querySelectorAll('.mode-card').forEach(card => {
  card.addEventListener('click', () => switchMode(card.dataset.mode));
});

document.getElementById('btn-switch-to-home').addEventListener('click', () => switchMode('home'));
document.getElementById('btn-switch-to-casino').addEventListener('click', () => switchMode('casino'));

// ── Period filter helper ─────────────────────────────────────────

function filterByPeriod(data) {
  if (casinoPeriod === 'all') return data;
  const now = new Date();
  return data.filter(v => {
    const d = new Date(v.created_at);
    if (casinoPeriod === 'year')  return d.getFullYear() === now.getFullYear();
    if (casinoPeriod === 'month') return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    return true;
  });
}

function setCasinoPeriod(period) {
  casinoPeriod = period;
  document.querySelectorAll('[data-period]').forEach(t => {
    t.classList.toggle('active', t.dataset.period === period);
  });
  const dashActive  = document.getElementById('view-casino-dashboard')?.classList.contains('active');
  const statsActive = document.getElementById('view-casino-stats')?.classList.contains('active');
  if (dashActive)  loadCasinoDashboard();
  if (statsActive) loadCasinoStats();
}

document.querySelectorAll('[data-period]').forEach(tab => {
  tab.addEventListener('click', () => setCasinoPeriod(tab.dataset.period));
});

// ── Casino Dashboard ─────────────────────────────────────────────

async function loadCasinoDashboard() {
  show('view-casino-dashboard');
  const el = document.getElementById('casino-dash-content');
  el.innerHTML = skeletonHTML(2);
  renderNextTrip();

  const { data: raw, error } = await api('/casino/stats');
  const data = filterByPeriod(raw || []);

  if (error || !data.length) {
    el.innerHTML = '<p class="empty-state">No visits recorded yet.<br>Tap + Log a Visit to get started.</p>';
    return;
  }

  const totalPL  = Math.round(data.reduce((s, v) => s + ((v.cash_out ?? 0) - v.buy_in), 0) * 100) / 100;
  const wins     = data.filter(v => (v.cash_out ?? 0) > v.buy_in).length;
  const winRate  = Math.round((wins / data.length) * 100);
  const plStr    = `${totalPL >= 0 ? '+' : ''}${CUR}${Math.abs(totalPL)}`;
  const best     = [...data].sort((a, b) => ((b.cash_out ?? 0) - b.buy_in) - ((a.cash_out ?? 0) - a.buy_in))[0];
  const worst    = [...data].sort((a, b) => ((a.cash_out ?? 0) - a.buy_in) - ((b.cash_out ?? 0) - b.buy_in))[0];
  const bestNet  = Math.round(((best.cash_out ?? 0)  - best.buy_in)  * 100) / 100;
  const worstNet = Math.round(((worst.cash_out ?? 0) - worst.buy_in) * 100) / 100;

  el.innerHTML = `
    <div class="casino-stat-grid">
      <div class="casino-stat-card ${totalPL >= 0 ? 'win' : 'loss'}">
        <div class="casino-stat-label">Total P&amp;L</div>
        <div class="casino-stat-value ${totalPL >= 0 ? 'positive' : 'negative'}">${plStr}</div>
        <div class="casino-stat-sub">${data.length} visit${data.length !== 1 ? 's' : ''} · ${winRate}% win rate</div>
      </div>
      <div class="casino-stat-row">
        <div class="casino-mini-stat">
          <span class="casino-mini-label">Best</span>
          <span class="casino-mini-val positive">+${CUR}${Math.max(0, bestNet)}</span>
          <span class="casino-mini-sub">${best.casino_name}</span>
        </div>
        <div class="casino-mini-stat">
          <span class="casino-mini-label">Worst</span>
          <span class="casino-mini-val negative">-${CUR}${Math.abs(Math.min(0, worstNet))}</span>
          <span class="casino-mini-sub">${worst.casino_name}</span>
        </div>
      </div>
    </div>`;
}

// ── Casino Visits ────────────────────────────────────────────────

async function loadCasinoVisits() {
  show('view-casino-visits');
  const listEl = document.getElementById('casino-visits-list');
  listEl.innerHTML = skeletonHTML(3);

  const { data, error } = await api('/casino/visits');
  if (error) { listEl.innerHTML = '<p class="empty-state">Error loading visits.</p>'; return; }
  if (!data?.length) { listEl.innerHTML = '<p class="empty-state">No visits logged yet.</p>'; return; }

  listEl.innerHTML = '';
  data.forEach(v => {
    const net   = v.cash_out !== null ? Math.round(((v.cash_out ?? 0) - v.buy_in) * 100) / 100 : null;
    const games = v.games ? v.games.split(',').filter(Boolean).map(g => g[0].toUpperCase() + g.slice(1)).join(', ') : '';
    const card  = document.createElement('div');
    card.className = 'session-card';
    card.innerHTML = `
      <div class="session-card-info">
        <span class="session-card-name">${v.casino_name}</span>
        <span class="session-card-meta">${formatDate(v.created_at)}${games ? ' · ' + games : ''}</span>
        <span class="session-card-meta">In ${CUR}${v.buy_in}${v.cash_out !== null ? ' → Out ' + CUR + v.cash_out : ' · Playing'}</span>
      </div>
      <div class="session-card-right">
        ${net !== null
          ? `<span class="lb-net ${net > 0 ? 'positive' : net < 0 ? 'negative' : 'zero'}">${net >= 0 ? '+' : ''}${CUR}${net}</span>`
          : `<span class="badge badge-active">active</span>`}
        <span class="card-edit-hint" title="Tap to edit"><svg class="icon"><use href="#i-pencil"/></svg></span>
        ${isAdmin() ? `<button class="btn-delete" title="Delete visit"><svg class="icon"><use href="#i-x"/></svg></button>` : ''}
      </div>`;

    // Tap the card to edit; the ✕ deletes (with undo). Delete is admin-only.
    card.addEventListener('click', e => {
      if (!e.target.closest('.btn-delete')) openCasinoVisitModal(v);
    });
    card.querySelector('.btn-delete')?.addEventListener('click', e => {
      e.stopPropagation();
      deleteCasinoVisit(v);
    });
    listEl.appendChild(card);
  });
}

// Delete a visit with a 5s undo window (re-creates it on undo).
async function deleteCasinoVisit(v) {
  const { error } = await api(`/casino/visits/${v.id}`, 'DELETE');
  if (error) { toast('Error deleting visit: ' + error.message, 'error'); return; }
  await loadCasinoVisits();

  toastUndo(`Deleted ${v.casino_name} visit`, async () => {
    const { error: re } = await api('/casino/visits', 'POST', {
      casino_name: v.casino_name,
      buy_in:      v.buy_in,
      cash_out:    v.cash_out,
      games:       v.games,
      notes:       v.notes,
      created_at:  v.created_at,
    });
    if (re) { toast('Could not undo', 'error'); return; }
    await loadCasinoVisits();
    toast('Visit restored', 'success');
  });
}

// ── Casino Stats ─────────────────────────────────────────────────

async function loadCasinoStats() {
  show('view-casino-stats');
  const el = document.getElementById('casino-stats-content');
  el.innerHTML = skeletonHTML(3);

  const { data: raw, error } = await api('/casino/stats');
  const data = filterByPeriod(raw || []);
  if (error || !data.length) { el.innerHTML = '<p class="empty-state">No settled visits yet.</p>'; return; }

  // Favourite games
  const gameCounts = {};
  data.forEach(v => (v.games || '').split(',').filter(Boolean).forEach(g => { gameCounts[g] = (gameCounts[g] || 0) + 1; }));
  const topGames = Object.entries(gameCounts).sort(([,a],[,b]) => b - a);

  // Monthly summary
  const months = {};
  data.forEach(v => {
    const m = v.created_at.substring(0, 7);
    if (!months[m]) months[m] = { wins: 0, total: 0, pl: 0 };
    const net = (v.cash_out ?? 0) - v.buy_in;
    months[m].total++;
    months[m].pl = Math.round((months[m].pl + net) * 100) / 100;
    if (net > 0) months[m].wins++;
  });

  // Per casino breakdown
  const venueMap = {};
  data.forEach(v => {
    const key = v.casino_name;
    if (!venueMap[key]) venueMap[key] = { name: key, visits: 0, wins: 0, pl: 0 };
    const net = (v.cash_out ?? 0) - v.buy_in;
    venueMap[key].visits++;
    venueMap[key].pl = Math.round((venueMap[key].pl + net) * 100) / 100;
    if (net > 0) venueMap[key].wins++;
  });
  const venues = Object.values(venueMap).sort((a, b) => b.pl - a.pl);

  el.innerHTML = `
    ${venues.length > 1 ? `
    <div class="lb-record-section">
      <p class="lb-record-title"><svg class="icon"><use href="#i-building"/></svg> By Casino</p>
      <p class="lb-record-desc">Your performance at each venue</p>
      ${venues.map(v => {
        const plStr = `${v.pl >= 0 ? '+' : ''}${CUR}${Math.abs(v.pl)}`;
        const wr = Math.round((v.wins / v.visits) * 100);
        return `<div class="casino-month-row">
          <span class="casino-month-name">${v.name}</span>
          <span class="casino-month-meta">${v.visits} visit${v.visits !== 1 ? 's' : ''} · ${wr}% wins</span>
          <span class="casino-month-pl ${v.pl >= 0 ? 'positive' : 'negative'}">${plStr}</span>
        </div>`;
      }).join('')}
    </div>` : ''}
    ${topGames.length ? `
    <div class="lb-record-section">
      <p class="lb-record-title"><svg class="icon"><use href="#i-dice"/></svg> Favourite Games</p>
      <p class="lb-record-desc">Most played games across all visits</p>
      ${topGames.slice(0, 5).map(([game, count]) => `
        <div class="casino-game-row">
          <span class="casino-game-name">${game[0].toUpperCase() + game.slice(1)}</span>
          <span class="casino-game-count">${count} time${count !== 1 ? 's' : ''}</span>
        </div>`).join('')}
    </div>` : ''}
    <div class="lb-record-section">
      <p class="lb-record-title"><svg class="icon"><use href="#i-calendar"/></svg> Monthly Summary</p>
      <p class="lb-record-desc">Win/loss breakdown by month</p>
      ${Object.entries(months).reverse().map(([month, s]) => {
        const plStr = `${s.pl >= 0 ? '+' : ''}${CUR}${Math.abs(s.pl)}`;
        return `<div class="casino-month-row">
          <span class="casino-month-name">${new Date(month + '-01').toLocaleDateString(undefined,{month:'short',year:'numeric'})}</span>
          <span class="casino-month-meta">${s.wins}/${s.total} wins</span>
          <span class="casino-month-pl ${s.pl >= 0 ? 'positive' : 'negative'}">${plStr}</span>
        </div>`;
      }).join('')}
    </div>`;
}

// ── Casino Visit Modal ───────────────────────────────────────────

function openCasinoVisitModal(visit = null) {
  editingVisitId = visit?.id ?? null;
  selectedGames  = new Set((visit?.games || '').split(',').filter(Boolean));

  document.getElementById('casino-visit-modal-title').textContent = visit ? 'Edit Visit' : 'Log Visit';
  document.getElementById('visit-casino-name').value  = visit?.casino_name ?? '';
  document.getElementById('visit-date').value         = visit ? visit.created_at.split('T')[0] : new Date().toISOString().split('T')[0];
  document.getElementById('visit-buy-in').value       = visit?.buy_in ?? '';
  document.getElementById('visit-cash-out').value     = visit?.cash_out ?? '';
  document.getElementById('visit-notes-input').value  = visit?.notes ?? '';
  document.getElementById('casino-visit-delete').classList.toggle('hidden', !visit || !isAdmin());

  document.querySelectorAll('.game-chip').forEach(chip => {
    chip.classList.toggle('selected', selectedGames.has(chip.dataset.game));
  });

  document.getElementById('modal-casino-visit').classList.remove('hidden');
  setTimeout(() => document.getElementById('visit-casino-name').focus(), 50);
}

document.querySelectorAll('.game-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    const g = chip.dataset.game;
    selectedGames.has(g) ? selectedGames.delete(g) : selectedGames.add(g);
    chip.classList.toggle('selected', selectedGames.has(g));
  });
});

document.getElementById('casino-visit-cancel').addEventListener('click', () => {
  document.getElementById('modal-casino-visit').classList.add('hidden');
});

document.getElementById('casino-visit-confirm').addEventListener('click', async () => {
  const name    = document.getElementById('visit-casino-name').value.trim();
  const buyIn   = parseFloat(document.getElementById('visit-buy-in').value);
  const cashOut = document.getElementById('visit-cash-out').value;
  const dateVal = document.getElementById('visit-date').value;
  const notes   = document.getElementById('visit-notes-input').value.trim();

  if (!name)         { toast('Enter a casino name.', 'error'); return; }
  if (!buyIn || buyIn <= 0) { toast('Enter a buy-in amount.', 'error'); return; }

  const games      = [...selectedGames].join(',');
  const cashOutVal = cashOut ? parseFloat(cashOut) : null;
  // Local wall-clock in SQLite's "YYYY-MM-DD HH:MM:SS" format (see session date note).
  const created_at = dateVal ? `${dateVal} 20:00:00` : undefined;

  document.getElementById('modal-casino-visit').classList.add('hidden');

  if (editingVisitId) {
    await api(`/casino/visits/${editingVisitId}`, 'PATCH', { casino_name: name, buy_in: buyIn, cash_out: cashOutVal, games, notes });
  } else {
    await api('/casino/visits', 'POST', { casino_name: name, buy_in: buyIn, cash_out: cashOutVal, games, notes, ...(created_at && { created_at }) });
  }

  if (document.getElementById('view-casino-visits').classList.contains('active')) loadCasinoVisits();
  else loadCasinoDashboard();
  toast(editingVisitId ? 'Visit updated.' : 'Visit logged!', 'success');
});

document.getElementById('casino-visit-delete').addEventListener('click', async () => {
  if (!editingVisitId) return;
  document.getElementById('modal-casino-visit').classList.add('hidden');
  await api(`/casino/visits/${editingVisitId}`, 'DELETE');
  loadCasinoVisits();
  toast('Visit deleted.', 'success');
});

document.getElementById('btn-new-visit').addEventListener('click',   () => openCasinoVisitModal());
document.getElementById('btn-new-visit-2').addEventListener('click', () => openCasinoVisitModal());

// ── Next Trip Scheduler ──────────────────────────────────────────

function getNextTrip() {
  try { return JSON.parse(localStorage.getItem('casino_next_trip')); } catch { return null; }
}

function renderNextTrip() {
  const trip = getNextTrip();
  const el   = document.getElementById('casino-next-trip');
  if (!trip) { el.classList.add('hidden'); return; }

  const tripDate  = new Date(trip.date);
  const today     = new Date(); today.setHours(0,0,0,0);
  const diffDays  = Math.ceil((tripDate - today) / 86400000);
  const countdown = diffDays < 0 ? 'Past' : diffDays === 0 ? 'Today! 🎉' : diffDays === 1 ? 'Tomorrow' : `in ${diffDays} days`;

  el.classList.remove('hidden');
  el.innerHTML = `
    <div class="next-trip-card">
      <span class="next-trip-icon"><svg class="icon"><use href="#i-calendar"/></svg></span>
      <div class="next-trip-info">
        <span class="next-trip-name">${trip.name}</span>
        <span class="next-trip-date">${formatDate(trip.date + 'T00:00:00')} · ${countdown}</span>
      </div>
      <button id="btn-edit-trip" class="btn btn-ghost btn-sm">Edit</button>
    </div>`;
  document.getElementById('btn-edit-trip').addEventListener('click', openTripModal);
}

function openTripModal() {
  const trip = getNextTrip();
  document.getElementById('trip-casino-name').value = trip?.name ?? '';
  document.getElementById('trip-date').value         = trip?.date ?? new Date().toISOString().split('T')[0];
  document.getElementById('modal-schedule-trip').classList.remove('hidden');
  setTimeout(() => document.getElementById('trip-casino-name').focus(), 50);
}

document.getElementById('btn-schedule-trip').addEventListener('click', openTripModal);

document.getElementById('trip-cancel').addEventListener('click', () => {
  document.getElementById('modal-schedule-trip').classList.add('hidden');
});

document.getElementById('trip-clear').addEventListener('click', () => {
  localStorage.removeItem('casino_next_trip');
  document.getElementById('modal-schedule-trip').classList.add('hidden');
  renderNextTrip();
});

document.getElementById('trip-confirm').addEventListener('click', () => {
  const name = document.getElementById('trip-casino-name').value.trim();
  const date = document.getElementById('trip-date').value;
  if (!name || !date) { toast('Enter a casino name and date.', 'error'); return; }
  localStorage.setItem('casino_next_trip', JSON.stringify({ name, date }));
  document.getElementById('modal-schedule-trip').classList.add('hidden');
  renderNextTrip();
  toast('Trip scheduled!', 'success');
});

// ── Blinds Timer ─────────────────────────────────────────────────

function initCasinoTimer() {
  // The back button only applies when the timer is launched from a Home-game
  // session; when reached via the Casino nav tab the bottom nav is the way out.
  document.getElementById('btn-back-timer').classList.add('hidden');
  show('view-casino-timer');
  updateTimerDisplay();
}

function updateTimerDisplay() {
  const level = BLIND_LEVELS[timerLevel];
  const next  = BLIND_LEVELS[timerLevel + 1];
  const mins  = Math.floor(timerSecondsLeft / 60);
  const secs  = timerSecondsLeft % 60;

  document.getElementById('timer-level-num').textContent     = timerLevel + 1;
  document.getElementById('timer-current-blinds').textContent = `${level.small} / ${level.big}`;
  document.getElementById('timer-next-blinds').textContent   = next ? `${next.small} / ${next.big}` : 'Final Level';
  document.getElementById('timer-toggle').innerHTML          = timerRunning ? '<svg class="icon"><use href="#i-pause"/></svg> Pause' : '<svg class="icon"><use href="#i-play"/></svg> Start';

  const el = document.getElementById('timer-countdown');
  el.textContent = `${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
  el.className   = `timer-countdown${timerSecondsLeft <= 60 ? ' timer-warning' : ''}`;
}

document.getElementById('timer-toggle').addEventListener('click', () => {
  timerRunning = !timerRunning;
  if (timerRunning) {
    timerInterval = setInterval(() => {
      timerSecondsLeft--;
      if (timerSecondsLeft <= 0) {
        if (timerLevel < BLIND_LEVELS.length - 1) {
          timerLevel++;
          timerSecondsLeft = timerLevelDuration;
          toast(`Level ${timerLevel + 1} — ${BLIND_LEVELS[timerLevel].small}/${BLIND_LEVELS[timerLevel].big}`, 'info', 4000);
        } else {
          timerRunning = false;
          clearInterval(timerInterval);
          timerSecondsLeft = 0;
          toast('Final blind level reached!', 'info', 5000);
        }
      }
      updateTimerDisplay();
    }, 1000);
  } else {
    clearInterval(timerInterval);
  }
  updateTimerDisplay();
});

document.getElementById('timer-reset').addEventListener('click', () => {
  clearInterval(timerInterval);
  timerRunning      = false;
  timerSecondsLeft  = timerLevelDuration;
  updateTimerDisplay();
});

document.getElementById('timer-prev').addEventListener('click', () => {
  if (timerLevel > 0) {
    clearInterval(timerInterval); timerRunning = false;
    timerLevel--; timerSecondsLeft = timerLevelDuration;
    updateTimerDisplay();
  }
});

document.getElementById('timer-next-btn').addEventListener('click', () => {
  if (timerLevel < BLIND_LEVELS.length - 1) {
    clearInterval(timerInterval); timerRunning = false;
    timerLevel++; timerSecondsLeft = timerLevelDuration;
    updateTimerDisplay();
  }
});

document.getElementById('timer-duration').addEventListener('change', e => {
  timerLevelDuration = parseInt(e.target.value, 10);
  timerSecondsLeft   = timerLevelDuration;
  clearInterval(timerInterval); timerRunning = false;
  updateTimerDisplay();
});

// Home Game: launch the blinds timer from inside the active session,
// and the timer's back button returns to that session.
document.getElementById('btn-blinds-timer').addEventListener('click', () => {
  initCasinoTimer();
  document.getElementById('btn-back-timer').classList.remove('hidden');
});
document.getElementById('btn-back-timer').addEventListener('click', () => show('view-session', 'back'));

/* ═══════════════════════════════════════════════════════════════
   LOCK SCREEN
   ═══════════════════════════════════════════════════════════════ */

// Apply the configured currency symbol to static markup (input prefixes, pot placeholders).
function applyCurrency() {
  document.querySelectorAll('.input-prefix').forEach(el => { el.textContent = CUR; });
  ['results-pot', 'session-live-pot'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = `${CUR}0`;
  });
}

/* ── Ambient card background ───────────────────────────────────────
   Faint face cards (A/K/Q/J + the occasional Joker, random suits) that
   float and drift like a slow mid-air shuffle. Each gets a random spot +
   path + speed so the motion feels organic. Reduced-motion stills them (CSS). */
function buildCardBg() {
  const bg = document.getElementById('card-bg');
  if (!bg) return;
  const RANKS = ['A', 'K', 'Q', 'J'];
  const SUITS = ['♠', '♥', '♦', '♣'];
  const rnd = (a, b) => Math.round(a + Math.random() * (b - a));
  let html = '';
  for (let i = 0; i < 14; i++) {
    const joker = Math.random() < 0.14;                 // ~2 jokers in the deck
    const suit  = SUITS[rnd(0, 3)];
    const rank  = RANKS[rnd(0, 3)];
    const red   = suit === '♥' || suit === '♦';
    const cls   = joker ? 'bg-card joker' : (red ? 'bg-card red' : 'bg-card');
    const face  = joker
      ? '<span class="bg-corner">★</span><span class="bg-pip">★</span><span class="bg-joker-label">JOKER</span>'
      : `<span class="bg-corner">${rank}<br>${suit}</span><span class="bg-pip">${suit}</span>`;
    const vars = [
      `left:${rnd(0, 88)}%`, `top:${rnd(0, 86)}%`,
      `--dur:${(9 + Math.random() * 10).toFixed(1)}s`,   // 9–19s loop
      `--d:${(-Math.random() * 12).toFixed(1)}s`,        // desync via negative delay
      `--r0:${rnd(-18, 18)}deg`,
      `--mx1:${rnd(-90, 90)}px`, `--my1:${rnd(-70, 70)}px`, `--r1:${rnd(-40, 40)}deg`,
      `--mx2:${rnd(-90, 90)}px`, `--my2:${rnd(-70, 70)}px`, `--r2:${rnd(-40, 40)}deg`,
      `--mx3:${rnd(-90, 90)}px`, `--my3:${rnd(-70, 70)}px`, `--r3:${rnd(-40, 40)}deg`,
    ].join(';');
    html += `<div class="${cls}" style="${vars}">${face}</div>`;
  }
  bg.innerHTML = html;
}

function boot() {
  document.body.classList.toggle('role-user', !isAdmin()); // gate destructive UI
  wireAccountButtons();                                     // reveal account UI in Auth0 mode
  buildCardBg();
  applyCurrency();
  initSplash(() => {
    const mode = localStorage.getItem('poker_mode');
    if (!mode) {
      document.getElementById('mode-select').classList.remove('hidden');
    } else {
      currentMode = mode;
      updateModeUI(mode);
      if (mode === 'casino') loadCasinoDashboard();
    }
  });
  loadDashboard(); // pre-load home dashboard in background
  loadRoster();
}

function unlockApp(role) {
  document.activeElement?.blur(); // dismiss keyboard & reset iOS viewport zoom
  sessionStorage.setItem('poker_auth', 'true');
  sessionStorage.setItem('poker_role', role || 'admin');
  // Reveal the splash *underneath* the lock screen (splash z-index 1000 sits
  // below the lock's 1001) BEFORE the lock fades, so the dashboard never
  // flashes through during the 0.4s fade-out.
  document.getElementById('splash').style.removeProperty('display');
  const lockEl = document.getElementById('lock-screen');
  lockEl.style.transition = 'opacity 0.4s ease';
  lockEl.style.opacity    = '0';
  setTimeout(() => {
    lockEl.classList.add('hidden');
    boot();
  }, 400);
}

document.getElementById('lock-submit').addEventListener('click', async () => {
  const pw    = document.getElementById('lock-password').value;
  const btn   = document.getElementById('lock-submit');
  const errEl = document.getElementById('lock-error');
  const inpEl = document.getElementById('lock-password');

  if (!pw) return;

  btn.disabled    = true;
  btn.textContent = 'Checking…';
  errEl.classList.add('hidden');

  const { data, error } = await api('/auth', 'POST', { password: pw });

  btn.disabled    = false;
  btn.textContent = 'Unlock';

  if (data?.success) {
    unlockApp(data.role);
    return;
  }

  if (error && error.kind !== 'http') {
    // Config or network problem — show the accurate reason, not "wrong password"
    errEl.textContent = error.message;
    errEl.classList.remove('hidden');
    return;
  }

  // HTTP 401 from /auth → genuinely the wrong password
  errEl.textContent = 'Incorrect password';
  errEl.classList.remove('hidden');
  inpEl.classList.add('shake');
  setTimeout(() => inpEl.classList.remove('shake'), 450);
  inpEl.value = '';
  inpEl.focus();
});

document.getElementById('lock-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('lock-submit').click();
});

/* ── Auth0 sign-in (multi-user mode) ──────────────────────────────
   Only wired up when config.js defines AUTH0; in password mode these helpers
   are inert and the original lock flow above is used unchanged. */
async function initAuth0() {
  if (typeof auth0 === 'undefined') throw new Error('Auth0 SDK failed to load');
  _auth0Client = await auth0.createAuth0Client({
    domain:   AUTH0_CFG.domain,
    clientId: AUTH0_CFG.clientId,
    authorizationParams: {
      audience:     AUTH0_CFG.audience,
      redirect_uri: window.location.origin + window.location.pathname,
    },
    cacheLocation:   'localstorage',
    useRefreshTokens: true,
  });
  // Complete a redirect login if we're returning from Auth0.
  const q = window.location.search;
  if (q.includes('code=') && q.includes('state=')) {
    try { await _auth0Client.handleRedirectCallback(); }
    catch (e) { console.warn('Auth0 callback failed', e); }
    window.history.replaceState({}, document.title, window.location.pathname);
  }
  return _auth0Client.isAuthenticated();
}

// Pull the signed-in identity, set the active group, and map the per-group role
// onto the existing admin/user gating (owner|admin → admin, member → user).
async function syncIdentity() {
  const { data } = await api('/me');
  if (!data) return false;
  if (data.group) {
    activeGroupId = data.group.id;
    localStorage.setItem('poker_group', activeGroupId);
    const r = data.group.role;
    sessionStorage.setItem('poker_role', (r === 'owner' || r === 'admin') ? 'admin' : 'user');
  }
  return true;
}

function showLockScreen() {
  document.getElementById('lock-screen').classList.remove('hidden');
  document.getElementById('splash').style.display = 'none';
  const auth = authMode() === 'auth0';
  document.getElementById('lock-form-password')?.classList.toggle('hidden', auth);
  document.getElementById('lock-form-auth0')?.classList.toggle('hidden', !auth);
  if (auth) {
    const sub = document.querySelector('.lock-subtitle');
    if (sub) sub.textContent = 'Sign in to continue';
  }
}

document.getElementById('lock-auth0-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('lock-auth0-btn');
  btn.disabled = true; btn.textContent = 'Redirecting…';
  try {
    if (!_auth0Client) await initAuth0();
    await _auth0Client.loginWithRedirect();
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Sign in';
    const errEl = document.getElementById('lock-error');
    errEl.textContent = e.message || 'Sign-in failed'; errEl.classList.remove('hidden');
  }
});

/* ── Account / groups (multi-user mode) ───────────────────────────
   All inert in password mode — the account buttons stay hidden and these
   handlers are never reached. */
function wireAccountButtons() {
  const show = authMode() === 'auth0';
  document.querySelectorAll('.account-btn').forEach(b => b.classList.toggle('hidden', !show));
}

async function openAccountModal() {
  const { data } = await api('/me');
  if (!data) { toast('Could not load account', 'error'); return; }
  document.getElementById('account-identity').textContent =
    (data.name || data.email || 'Signed in') + (data.name && data.email ? ` · ${data.email}` : '');

  const wrap = document.getElementById('account-groups');
  wrap.innerHTML = '';
  const activeId = data.group && data.group.id;
  for (const g of data.groups || []) {
    const isActive = g.id === activeId;
    const btn = document.createElement('button');
    btn.className = 'btn btn-ghost btn-block account-group' + (isActive ? ' active' : '');
    btn.textContent = `${g.name} · ${g.role}${isActive ? '  (current)' : ''}`;
    btn.disabled = isActive;
    if (!isActive) btn.addEventListener('click', () => switchGroup(g.id));
    wrap.appendChild(btn);
  }

  const canInvite = data.group && (data.group.role === 'owner' || data.group.role === 'admin');
  document.getElementById('account-invite-wrap').classList.toggle('hidden', !canInvite);
  const out = document.getElementById('account-invite-out');
  out.classList.add('hidden'); out.value = '';

  document.getElementById('modal-account').classList.remove('hidden');
}

async function switchGroup(id) {
  activeGroupId = id;
  localStorage.setItem('poker_group', id);
  document.getElementById('modal-account').classList.add('hidden');
  await syncIdentity();                                   // refresh role for the new group
  document.body.classList.toggle('role-user', !isAdmin());
  loadDashboard();
  loadRoster();
  if (currentMode === 'casino') loadCasinoDashboard();
  toast('Switched group', 'success');
}

async function generateInvite() {
  const btn = document.getElementById('account-invite-btn');
  btn.disabled = true; btn.textContent = 'Creating…';
  const { data, error } = await api('/invites', 'POST', { role: 'member' });
  btn.disabled = false; btn.textContent = 'Create invite link';
  if (!data || !data.code) { toast(error?.message || 'Could not create invite', 'error'); return; }
  const link = `${location.origin}${location.pathname}?invite=${data.code}`;
  const out = document.getElementById('account-invite-out');
  out.value = link; out.classList.remove('hidden'); out.focus(); out.select();
  try { await navigator.clipboard.writeText(link); toast('Invite link copied', 'success'); }
  catch { toast('Invite link ready — copy it', 'info'); }
}

async function signOut() {
  localStorage.removeItem('poker_group');
  sessionStorage.removeItem('poker_role');
  activeGroupId = null;
  if (_auth0Client) {
    try { await _auth0Client.logout({ logoutParams: { returnTo: location.origin + location.pathname } }); return; }
    catch (e) { console.warn(e); }
  }
  location.reload();
}

// Redeem an invite code (from a ?invite= link, preserved across the Auth0
// redirect via sessionStorage) and land the user in that group.
async function maybeAcceptInvite() {
  const code = sessionStorage.getItem('pending_invite')
            || new URLSearchParams(location.search).get('invite');
  if (!code) return;
  sessionStorage.removeItem('pending_invite');
  const { data } = await api(`/invites/${encodeURIComponent(code)}/accept`, 'POST');
  if (data && data.group) {
    activeGroupId = data.group.id;
    localStorage.setItem('poker_group', activeGroupId);
    toast(`Joined ${data.group.name}`, 'success');
  }
  const url = new URL(location.href);
  if (url.searchParams.has('invite')) {
    url.searchParams.delete('invite');
    window.history.replaceState({}, document.title, url.pathname + url.search);
  }
}

document.getElementById('btn-account')?.addEventListener('click', openAccountModal);
document.getElementById('btn-account-casino')?.addEventListener('click', openAccountModal);
document.getElementById('account-close')?.addEventListener('click', () =>
  document.getElementById('modal-account').classList.add('hidden'));
document.getElementById('account-invite-btn')?.addEventListener('click', generateInvite);
document.getElementById('account-signout')?.addEventListener('click', signOut);

/* ── Boot ─────────────────────────────────────────────────────── */
async function startup() {
  if (authMode() === 'auth0') {
    // Preserve an invite code across the Auth0 redirect round-trip.
    const inviteParam = new URLSearchParams(location.search).get('invite');
    if (inviteParam) sessionStorage.setItem('pending_invite', inviteParam);

    let authed = false;
    try { authed = await initAuth0(); }
    catch (e) { console.warn(e); }
    if (authed) {
      await maybeAcceptInvite();          // before syncIdentity so the joined group is active
      if (await syncIdentity()) {
        document.getElementById('lock-screen').classList.add('hidden');
        boot();
        return;
      }
    }
    showLockScreen();
  } else if (sessionStorage.getItem('poker_auth') === 'true') {
    boot();
  } else {
    showLockScreen();
  }
}
startup();

/* ── Service Worker registration (PWA) ─────────────────────────── */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err =>
      console.warn('Service worker registration failed:', err)
    );
  });
}

/* ── Android/Chrome install prompt ─────────────────────────────── */
let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();                 // stop Chrome's default mini-infobar
  deferredInstallPrompt = e;
  if (sessionStorage.getItem('install_dismissed') !== 'true') {
    document.getElementById('install-banner').classList.remove('hidden');
  }
});

document.getElementById('install-accept').addEventListener('click', async () => {
  document.getElementById('install-banner').classList.add('hidden');
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
});

document.getElementById('install-dismiss').addEventListener('click', () => {
  sessionStorage.setItem('install_dismissed', 'true');
  document.getElementById('install-banner').classList.add('hidden');
});

window.addEventListener('appinstalled', () => {
  document.getElementById('install-banner').classList.add('hidden');
  deferredInstallPrompt = null;
});
