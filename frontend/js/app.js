// ============================================================
// Illusion Dashboard - AI-Powered Trade Assistant
// ============================================================

const API_BASE = '';
let _authUser = null;

function isAdminUser() {
    return (_authUser?.role || '') === 'admin';
}

function _toggleAuthOverlay(show) {
    const el = document.getElementById('auth-overlay');
    if (!el) return;
    el.style.display = show ? 'flex' : 'none';
}

function applyRoleAccess() {
    const badge = document.getElementById('auth-user-badge');
    const logoutBtn = document.getElementById('auth-logout-btn');
    if (badge) {
        badge.textContent = _authUser
            ? `${_authUser.username} (${_authUser.role})`
            : '';
    }
    if (logoutBtn) logoutBtn.style.display = _authUser ? 'inline-flex' : 'none';

    const settingsTab = document.getElementById('tab-settings');
    if (settingsTab) settingsTab.style.display = isAdminUser() ? '' : 'none';

    const adminButtons = [
        'btn-index-scan', 'btn-index-scan-positional',
        'btn-index-ce-buy', 'btn-index-pe-buy',
        'btn-index-manual-refresh', 'btn-refresh-instruments', 'btn-value-refresh',
        'btn-refresh-sectors', 'btn-sector-telegram'
    ];
    adminButtons.forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.disabled = !isAdminUser();
    });
    const pnlInputs = ['pnl-max-profit', 'pnl-max-loss'];
    pnlInputs.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = !isAdminUser();
    });
}

async function initAuth() {
    try {
        const resp = await fetch(`${API_BASE}/api/auth/me`);
        const data = await resp.json();
        if (data?.authenticated && data?.user) {
            _authUser = data.user;
            _toggleAuthOverlay(false);
            applyRoleAccess();
            return true;
        }
    } catch (_) {}
    _authUser = null;
    _toggleAuthOverlay(true);
    applyRoleAccess();
    return false;
}

async function loginAppUser() {
    const u = document.getElementById('auth-username');
    const p = document.getElementById('auth-password');
    const err = document.getElementById('auth-error');
    const btn = document.getElementById('btn-auth-login');
    if (!u || !p || !err || !btn) return;
    err.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Signing In...';
    try {
        const resp = await fetch(`${API_BASE}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: u.value.trim(), password: p.value }),
        });
        const data = await resp.json();
        if (!data?.success) throw new Error(data?.message || 'Login failed');
        _authUser = data.user;
        _toggleAuthOverlay(false);
        applyRoleAccess();
        startApp();
    } catch (e) {
        err.textContent = e.message || 'Login failed';
    } finally {
        btn.disabled = false;
        btn.textContent = 'Sign In';
    }
}

async function logoutAppUser() {
    try { await fetch(`${API_BASE}/api/auth/logout`, { method: 'POST' }); } catch (_) {}
    _authUser = null;
    _toggleAuthOverlay(true);
    applyRoleAccess();
}

// --- Sidebar Collapse ---

function toggleSidebar() {
    const sidebar = document.querySelector('.sidebar');
    sidebar.classList.toggle('collapsed');
    localStorage.setItem('sidebar-collapsed', sidebar.classList.contains('collapsed'));
}

function initSidebar() {
    const collapsed = localStorage.getItem('sidebar-collapsed') === 'true';
    if (collapsed) document.querySelector('.sidebar').classList.add('collapsed');
}

// --- Sidebar menu: grouped flyouts + reordering (drag-and-drop or ▲/▼ on hover; saved per browser) ---
//
// Top-level entries (.sidebar-nav children) are tabs or .nav-group menus. Each group's
// .nav-submenu is moved to <body> at init and shown as a fixed flyout on hover: the
// sidebar uses backdrop-filter + overflow:hidden, which would clip it in place.
// Order is kept per container: { nav: [...], longterm: [...], fo: [...] }.

const TAB_ORDER_KEY = 'nav-tab-order-v2';
const _NAV_ARROW_UP = '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>';
const _NAV_ARROW_DOWN = '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
let _navInitDone = false;
let _navDragging = null;

function _navRoot() { return document.querySelector('.sidebar-nav'); }
function _navSubmenu(key) { return document.querySelector(`.nav-submenu[data-group="${key}"]`); }
function _navContainers() { return [_navRoot(), ...document.querySelectorAll('.nav-submenu')].filter(Boolean); }
function _navContainerKey(c) { return c.classList.contains('nav-submenu') ? c.dataset.group : 'nav'; }
function _navEntries(c) {
    return Array.from(c.children).filter(el => el.classList.contains('nav-item') || el.classList.contains('nav-group'));
}
function _navKey(el) {
    return el.classList.contains('nav-group') ? `group:${el.dataset.group}` : el.id.replace(/^tab-/, '');
}

function _saveTabOrder() {
    const order = {};
    _navContainers().forEach(c => { order[_navContainerKey(c)] = _navEntries(c).map(_navKey); });
    try { localStorage.setItem(TAB_ORDER_KEY, JSON.stringify(order)); } catch (_) {}
}

function _applySavedTabOrder() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(TAB_ORDER_KEY) || 'null'); } catch (_) {}
    if (!saved || typeof saved !== 'object') return;
    _navContainers().forEach(c => {
        const keys = saved[_navContainerKey(c)];
        if (!Array.isArray(keys)) return;
        const byKey = new Map(_navEntries(c).map(el => [_navKey(el), el]));
        // Saved entries first in saved order; anything new keeps its default spot after them.
        const ordered = keys.map(k => byKey.get(k)).filter(Boolean);
        _navEntries(c).forEach(el => { if (!ordered.includes(el)) ordered.push(el); });
        ordered.forEach(el => c.appendChild(el));
    });
}

/** Tab to open on load: the first one (in the user's order) they can see. */
function firstNavTab() {
    const root = _navRoot();
    if (!root) return 'sectors';
    for (const el of _navEntries(root)) {
        if (el.style.display === 'none') continue;
        if (!el.classList.contains('nav-group')) return _navKey(el);
        const menu = _navSubmenu(el.dataset.group);
        const first = menu && _navEntries(menu).find(s => s.style.display !== 'none');
        if (first) return _navKey(first);
    }
    return 'sectors';
}

function _moveNavEntry(el, delta) {
    const siblings = _navEntries(el.parentElement);
    const target = siblings[siblings.indexOf(el) + delta];
    if (!target) return;
    if (delta < 0) target.before(el); else target.after(el);
    _saveTabOrder();
}

/** Highlight a group's header when one of its tabs is open. Called from switchTab. */
function syncNavGroupActive() {
    document.querySelectorAll('.nav-group').forEach(group => {
        const menu = _navSubmenu(group.dataset.group);
        const active = menu && menu.querySelector('.nav-sub-item.active');
        const head = group.querySelector('.nav-group-head');
        if (!head) return;
        head.classList.toggle('group-active', !!active);
        const label = head.querySelector('span')?.textContent || '';
        head.title = active ? `${label} · ${active.querySelector('span')?.textContent || ''}` : label;
    });
}

function _closeNavFlyouts(except) {
    document.querySelectorAll('.nav-submenu.open').forEach(m => { if (m !== except) m._navHide?.(0); });
}

function _initNavGroups() {
    const sidebar = document.querySelector('.sidebar');
    document.querySelectorAll('.nav-group').forEach(group => {
        const menu = group.querySelector('.nav-submenu');
        const head = group.querySelector('.nav-group-head');
        if (!menu || !head) return;
        document.body.appendChild(menu);

        let hideTimer = null;
        const place = () => {
            const r = head.getBoundingClientRect();
            const sb = sidebar ? sidebar.getBoundingClientRect() : r;
            menu.style.left = `${Math.round(sb.right + 6)}px`;
            const maxTop = window.innerHeight - menu.offsetHeight - 8;
            menu.style.top = `${Math.round(Math.max(8, Math.min(r.top - 6, maxTop)))}px`;
        };
        const show = () => {
            clearTimeout(hideTimer);
            _closeNavFlyouts(menu);
            menu.classList.add('open');
            head.classList.add('open');
            head.setAttribute('aria-expanded', 'true');
            place();
        };
        const hide = (delay = 180) => {
            clearTimeout(hideTimer);
            hideTimer = setTimeout(() => {
                if (_navDragging && menu.contains(_navDragging)) return;
                menu.classList.remove('open');
                head.classList.remove('open');
                head.setAttribute('aria-expanded', 'false');
            }, delay);
        };
        menu._navHide = hide;

        group.addEventListener('mouseenter', show);
        group.addEventListener('mouseleave', () => hide());
        menu.addEventListener('mouseenter', show);
        menu.addEventListener('mouseleave', () => hide());
        head.addEventListener('click', e => {
            if (e.target.closest('.nav-move')) return;
            menu.classList.contains('open') ? hide(0) : show();
        });
        head.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') {
                e.preventDefault();
                show();
                menu.querySelector('.nav-sub-item')?.focus();
            } else if (e.key === 'Escape') hide(0);
        });
        menu.addEventListener('keydown', e => {
            const item = e.target.closest('.nav-sub-item');
            if (item && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); item.click(); }
            if (e.key === 'Escape' || e.key === 'ArrowLeft') { hide(0); head.focus(); }
        });
        menu.addEventListener('click', e => {
            if (e.target.closest('.nav-sub-item') && !e.target.closest('.nav-move')) hide(0);
        });
        menu.querySelectorAll('.nav-sub-item').forEach(item => {
            item.tabIndex = 0;
            item.setAttribute('role', 'menuitem');
        });
    });
    document.addEventListener('click', e => {
        if (!e.target.closest('.nav-group, .nav-submenu')) _closeNavFlyouts(null);
    });
    window.addEventListener('resize', () => _closeNavFlyouts(null));
}

function _addNavMoveControls(entry) {
    const host = entry.classList.contains('nav-group') ? entry.querySelector('.nav-group-head') : entry;
    if (!host || host.querySelector('.nav-move')) return;
    const ctl = document.createElement('span');
    ctl.className = 'nav-move';
    ctl.innerHTML =
        `<button type="button" class="nav-move-btn" title="Move up" aria-label="Move up">${_NAV_ARROW_UP}</button>` +
        `<button type="button" class="nav-move-btn" title="Move down" aria-label="Move down">${_NAV_ARROW_DOWN}</button>`;
    const [up, down] = ctl.querySelectorAll('button');
    up.addEventListener('click', e => { e.stopPropagation(); _moveNavEntry(entry, -1); });
    down.addEventListener('click', e => { e.stopPropagation(); _moveNavEntry(entry, +1); });
    const chev = host.querySelector('.nav-group-chev');
    if (chev) host.insertBefore(ctl, chev); else host.appendChild(ctl);
}

function _initNavDrag(entry) {
    entry.draggable = true;
    entry.addEventListener('dragstart', e => {
        e.stopPropagation();
        _navDragging = entry;
        entry.classList.add('nav-dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', _navKey(entry)); } catch (_) {}
    });
    entry.addEventListener('dragend', () => {
        entry.classList.remove('nav-dragging');
        document.querySelectorAll('.nav-drop-before, .nav-drop-after')
            .forEach(n => n.classList.remove('nav-drop-before', 'nav-drop-after'));
        _navDragging = null;
    });
    // Drops are only allowed between entries of the same menu.
    const sameMenu = () => _navDragging && _navDragging !== entry && _navDragging.parentElement === entry.parentElement;
    entry.addEventListener('dragover', e => {
        if (!sameMenu()) return;
        e.preventDefault();
        e.stopPropagation();
        const r = entry.getBoundingClientRect();
        const after = e.clientY > r.top + r.height / 2;
        entry.classList.toggle('nav-drop-after', after);
        entry.classList.toggle('nav-drop-before', !after);
    });
    entry.addEventListener('dragleave', () => entry.classList.remove('nav-drop-before', 'nav-drop-after'));
    entry.addEventListener('drop', e => {
        if (!sameMenu()) return;
        e.preventDefault();
        e.stopPropagation();
        const after = entry.classList.contains('nav-drop-after');
        entry.classList.remove('nav-drop-before', 'nav-drop-after');
        if (after) entry.after(_navDragging); else entry.before(_navDragging);
        _saveTabOrder();
    });
}

function initTabOrder() {
    if (_navInitDone || !_navRoot()) return;
    _navInitDone = true;
    _initNavGroups();
    _applySavedTabOrder();
    _navContainers().forEach(c => _navEntries(c).forEach(entry => {
        entry.title = entry.title || 'Drag to reorder';
        _addNavMoveControls(entry);
        _initNavDrag(entry);
    }));
}

// --- Table Sorting ---

function makeTableSortable(tableEl) {
    if (!tableEl) return;
    const headers = tableEl.querySelectorAll('th');
    headers.forEach((th, colIdx) => {
        if (!th.textContent.trim()) return;
        th.classList.add('sortable');
        th.addEventListener('click', () => sortTable(tableEl, colIdx, th));
    });
}

function sortTable(tableEl, colIdx, th) {
    const tbody = tableEl.querySelector('tbody');
    if (!tbody) return;

    const rows = Array.from(tbody.querySelectorAll('tr'));
    const isAsc = th.classList.contains('sort-asc');
    const dir = isAsc ? -1 : 1;

    tableEl.querySelectorAll('th').forEach(h => h.classList.remove('sort-asc', 'sort-desc'));
    th.classList.add(isAsc ? 'sort-desc' : 'sort-asc');

    rows.sort((a, b) => {
        const aCell = a.children[colIdx];
        const bCell = b.children[colIdx];
        if (!aCell || !bCell) return 0;

        let aVal = (aCell.textContent || '').trim();
        let bVal = (bCell.textContent || '').trim();

        const aNum = parseFloat(aVal.replace(/[^0-9.\-]/g, ''));
        const bNum = parseFloat(bVal.replace(/[^0-9.\-]/g, ''));

        if (!isNaN(aNum) && !isNaN(bNum)) return (aNum - bNum) * dir;
        return aVal.localeCompare(bVal) * dir;
    });

    rows.forEach(r => tbody.appendChild(r));
}

function applySortable(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const table = el.querySelector('.data-table');
    if (table) makeTableSortable(table);
}

// --- Filter Pills ---

function togglePill(pill, section) {
    const container = pill.parentElement;
    const isAllPill = pill.dataset.value === '';

    if (isAllPill) {
        container.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
    } else {
        const allPill = container.querySelector('.filter-pill[data-value=""]');
        if (allPill) allPill.classList.remove('active');
        pill.classList.toggle('active');
        const anyActive = container.querySelectorAll('.filter-pill.active');
        if (anyActive.length === 0 && allPill) allPill.classList.add('active');
    }

    if (section === 'swing') loadSignals('swing');
    else if (section === 'fno') loadFnoSignals();
}

function getSelectedPills(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return [];
    const active = container.querySelectorAll('.filter-pill.active');
    const values = Array.from(active).map(p => p.dataset.value).filter(v => v !== '');
    return values;
}

// --- Theme ---

function initTheme() {
    const saved = localStorage.getItem('vcp-theme') || 'dark';
    document.documentElement.setAttribute('data-theme', saved);
    updateThemeIcons(saved);
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('vcp-theme', next);
    updateThemeIcons(next);

    if (_selectedSector) loadSectorChart(_selectedSector);
    if (_sxRotation) sxRenderRrg(false);
}

function updateThemeIcons(theme) {
    const sun = document.getElementById('icon-sun');
    const moon = document.getElementById('icon-moon');
    if (!sun || !moon) return;
    if (theme === 'dark') {
        sun.classList.remove('hidden');
        moon.classList.add('hidden');
    } else {
        sun.classList.add('hidden');
        moon.classList.remove('hidden');
    }
}

function isDark() {
    return document.documentElement.getAttribute('data-theme') === 'dark';
}

// --- Daily P&L Guard (Dhan pnlExit) ---

function _setPnlGuardStatus(msg, isError = false) {
    const el = document.getElementById('pnl-guard-status');
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = isError ? '#ef4444' : 'var(--text-muted)';
}

async function loadPnlGuardStatus() {
    const profitInput = document.getElementById('pnl-max-profit');
    const lossInput = document.getElementById('pnl-max-loss');
    if (!profitInput || !lossInput) return;
    _setPnlGuardStatus('Checking status...');
    try {
        const resp = await fetch(`${API_BASE}/api/settings/pnl-exit`);
        const result = await resp.json();
        if (!result?.success) {
            _setPnlGuardStatus(result?.message || 'Not configured');
            return;
        }

        const data = result.data || {};
        const status = String(data.pnlExitStatus || data.status || '').toUpperCase();
        const profit = data.profit ?? data.profitValue ?? '';
        const loss = data.loss ?? data.lossValue ?? '';
        if (profit !== '' && profit !== null && profit !== undefined) profitInput.value = Number(profit);
        if (loss !== '' && loss !== null && loss !== undefined) lossInput.value = Math.abs(Number(loss));

        // Dhan returns PENDING before it moves to ACTIVE; both should be treated
        // as configured for UI clarity.
        if (status === 'ACTIVE' || status === 'PENDING') {
            const profitLabel = (profit !== '' && profit !== null && profit !== undefined) ? Number(profit) : '-';
            const lossLabel = (loss !== '' && loss !== null && loss !== undefined) ? Math.abs(Number(loss)) : '-';
            _setPnlGuardStatus(`${status} · Profit ${profitLabel} · Loss ${lossLabel}`);
        } else {
            _setPnlGuardStatus('Inactive');
        }
    } catch (e) {
        _setPnlGuardStatus(`Status error: ${e.message}`, true);
    }
}

async function savePnlGuard() {
    if (!isAdminUser()) {
        _setPnlGuardStatus('Readonly user cannot modify P&L Guard', true);
        return;
    }
    const profitInput = document.getElementById('pnl-max-profit');
    const lossInput = document.getElementById('pnl-max-loss');
    if (!profitInput || !lossInput) return;

    const maxProfit = profitInput.value ? Number(profitInput.value) : null;
    const maxLoss = lossInput.value ? Number(lossInput.value) : null;
    if (maxProfit === null && maxLoss === null) {
        _setPnlGuardStatus('Enter max profit or max loss first', true);
        return;
    }

    _setPnlGuardStatus('Applying...');
    try {
        const resp = await fetch(`${API_BASE}/api/settings/pnl-exit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                max_profit: maxProfit,
                max_loss: maxLoss,
                product_type: ['INTRADAY', 'DELIVERY'],
                enable_kill_switch: false,
            }),
        });
        const result = await resp.json();
        if (!result?.success) {
            _setPnlGuardStatus(result?.message || 'Failed to apply', true);
            return;
        }
        _setPnlGuardStatus('Applied successfully');
        await loadPnlGuardStatus();
    } catch (e) {
        _setPnlGuardStatus(`Apply error: ${e.message}`, true);
    }
}

async function disablePnlGuard() {
    if (!isAdminUser()) {
        _setPnlGuardStatus('Readonly user cannot disable P&L Guard', true);
        return;
    }
    _setPnlGuardStatus('Disabling...');
    try {
        const resp = await fetch(`${API_BASE}/api/settings/pnl-exit`, { method: 'DELETE' });
        const result = await resp.json();
        if (!result?.success) {
            _setPnlGuardStatus(result?.message || 'Failed to disable', true);
            return;
        }
        _setPnlGuardStatus('Disabled');
    } catch (e) {
        _setPnlGuardStatus(`Disable error: ${e.message}`, true);
    }
}

// --- Tab Switching ---

function switchTab(tab) {
    if (tab === 'settings' && !isAdminUser()) return;
    document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));

    document.getElementById(`content-${tab}`).classList.remove('hidden');
    document.getElementById(`tab-${tab}`).classList.add('active');
    syncNavGroupActive();

    if (tab === 'sectors') {
        loadSectorsTab();
        syncSectorTelegramToggle();
    }
    if (tab === 'ipos') { loadIposTab(); }
    if (tab === 'technofunda') { tfInit(); }
    if (tab === 'swing') { loadSignals('swing'); showVcpInfo(); }
    if (tab === 'fno') { loadFnoSignals(); loadSchedulerStatus(); switchFnoSubTab(fnoSubTab); }
    if (tab === 'index') { loadIndexSignals(); }
    if (tab === 'value') { loadValueInvesting(); }
    if (tab === 'journal') loadTrades();
    if (tab === 'settings') { loadSettingsTab(); }
    if (tab !== 'index' && _indexManualMonitorTimer) {
        clearInterval(_indexManualMonitorTimer);
        _indexManualMonitorTimer = null;
    }
}

// --- Sector Analysis Tab (rotation map, money flow, heatmap, leaderboard) ---

const SECTOR_TELEGRAM_TOGGLE_KEY = 'sector-telegram-on-refresh';
const SX_TF_KEY = 'sector-rotation-timeframe';
let _sectorTelegramOnRefresh = localStorage.getItem(SECTOR_TELEGRAM_TOGGLE_KEY) === 'true';
let _selectedSector = null;
let _sxSectors = [];          // leaderboard rows (/sectors/all)
let _sxRotation = null;       // rotation payload (/sectors/rotation) or null
let _sxTf = (() => { try { return localStorage.getItem(SX_TF_KEY) || 'daily'; } catch (_) { return 'daily'; } })();
let _sxCur = {};              // sector -> current tail points [[ratio, momentum], ...] (animation state)
let _sxAnim = 0;              // requestAnimationFrame id
let _sxFocusName = null;
let _sxResizeObs = null;

const SX_QUADS = ['Leading', 'Improving', 'Weakening', 'Lagging'];
const SX_KPI_VISIBLE = 4;     // sector chips shown per quadrant tile before "+N more"
const _sxKpiOpen = new Set(); // quadrant tiles the user expanded
const SX_Q_VAR = { Leading: '--sx-lead', Weakening: '--sx-weak', Lagging: '--sx-lag', Improving: '--sx-impr' };
const SX_Q_HINT = {
    Leading: 'Strong and still accelerating',
    Improving: 'Weak but gaining momentum',
    Weakening: 'Strong but losing momentum',
    Lagging: 'Weak and losing momentum',
};
const SX_ARROW = '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

const sxShort = name => String(name || '').replace(/^Nifty\s+/i, '');
const sxPct = v => (v === null || v === undefined || Number.isNaN(v)) ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}%`;
const sxEase = t => 1 - Math.pow(1 - t, 4);

function sxColor(q) {
    const root = document.getElementById('content-sectors');
    return getComputedStyle(root).getPropertyValue(SX_Q_VAR[q] || '--sx-lead').trim() || '#22c55e';
}

function sxStatus(text, kind) {
    const el = document.getElementById('sector-tab-status');
    if (!el) return;
    el.textContent = text || '';
    el.className = `sx-status${kind ? ` sx-status--${kind}` : ''}`;
}

function sxRotationRows(tf = _sxTf) {
    return _sxRotation?.timeframes?.[tf]?.sectors || [];
}

function sxRotationOf(name, tf = _sxTf) {
    return sxRotationRows(tf).find(r => r.sector_name === name) || null;
}

function sxReturnsOf(name) {
    return (_sxRotation?.performance || []).find(p => p.sector_name === name)?.returns || {};
}

function sxQChip(q, text) {
    return q ? `<span class="sx-chip sx-chip--q" data-q="${stEsc(q)}">${stEsc(text || q)}</span>` : '';
}

// ── Telegram toggle ──

function syncSectorTelegramToggle() {
    const btn = document.getElementById('btn-sector-telegram');
    if (!btn) return;
    btn.setAttribute('aria-checked', String(_sectorTelegramOnRefresh));
    btn.title = _sectorTelegramOnRefresh
        ? 'Telegram report after refresh: ON (click to turn off)'
        : 'Telegram report after refresh: OFF (click to turn on)';
}

function toggleSectorTelegramOnRefresh() {
    if (!isAdminUser()) return;
    _sectorTelegramOnRefresh = !_sectorTelegramOnRefresh;
    try { localStorage.setItem(SECTOR_TELEGRAM_TOGGLE_KEY, _sectorTelegramOnRefresh ? 'true' : 'false'); } catch (_) {}
    syncSectorTelegramToggle();
    sxStatus(`Telegram after refresh: ${_sectorTelegramOnRefresh ? 'on' : 'off'}`, _sectorTelegramOnRefresh ? 'ok' : '');
}

async function notifySectorReportToTelegram() {
    const response = await fetch(`${API_BASE}/api/settings/sectors/notify`, { method: 'POST' });
    const data = await response.json();
    if (!response.ok || !data?.ok) {
        throw new Error(data?.message || data?.error || 'Telegram notification failed');
    }
    return data;
}

// ── Loading ──

async function loadSectorsTab() {
    const root = document.getElementById('content-sectors');
    const getJson = url => fetch(url).then(r => (r.ok ? r.json() : null)).catch(() => null);
    const [sectors, rotation] = await Promise.all([
        getJson(`${API_BASE}/api/settings/sectors/all`),
        getJson(`${API_BASE}/api/settings/sectors/rotation`),
    ]);
    _sxSectors = Array.isArray(sectors) ? sectors : [];
    _sxRotation = rotation && rotation.available ? rotation : null;
    window._lastSectors = _sxSectors;
    renderSectorsTab();

    // Replay the staggered reveal each time the tab is opened.
    root.classList.remove('sx-in');
    void root.offsetWidth;
    requestAnimationFrame(() => root.classList.add('sx-in'));

    if (!_sxResizeObs && 'ResizeObserver' in window) {
        let pending = 0;
        _sxResizeObs = new ResizeObserver(() => {
            cancelAnimationFrame(pending);
            pending = requestAnimationFrame(() => { sxSyncSeg(); sxRenderRrg(false); });
        });
        _sxResizeObs.observe(document.getElementById('sx-rrg-wrap'));
    }
}

function renderSectorsTab() {
    sxRenderAsOf();
    sxSyncSeg();
    sxRenderKpis();
    sxRenderAgree();
    sxRenderFlow();
    sxRenderHeat();
    renderSectorsTable(_sxSectors);
    sxRenderRrg(true);
}

function sxRenderAsOf() {
    const el = document.getElementById('sx-asof');
    if (!el) return;
    if (_sxRotation) {
        const updated = _sxRotation.generated_at ? new Date(_sxRotation.generated_at) : null;
        el.textContent = `Relative strength vs ${_sxRotation.benchmark || 'Nifty 50'} · data as of ${_sxRotation.as_of || '—'}`
            + (updated && !Number.isNaN(updated.getTime()) ? ` · computed ${updated.toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}` : '');
    } else {
        el.textContent = 'Relative strength of every Nifty sector against Nifty 50. Refresh to compute the rotation map.';
    }
}

function setRotationTimeframe(tf) {
    if (!['daily', 'weekly'].includes(tf) || tf === _sxTf) return;
    _sxTf = tf;
    try { localStorage.setItem(SX_TF_KEY, tf); } catch (_) {}
    sxSyncSeg();
    sxRenderKpis();
    sxRenderFlow();
    renderSectorsTable(_sxSectors);
    sxRenderRrg(true);
}

function sxSyncSeg() {
    const seg = document.getElementById('sx-tf');
    if (!seg) return;
    let active = null;
    seg.querySelectorAll('button').forEach(b => {
        const on = b.dataset.tf === _sxTf;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', String(on));
        if (on) active = b;
    });
    const ink = seg.querySelector('.sx-seg-ink');
    if (ink && active) {
        ink.style.width = `${active.offsetWidth}px`;
        ink.style.transform = `translateX(${active.offsetLeft}px)`;
    }
}

// ── KPI tiles ──

function sxRenderKpis() {
    const box = document.getElementById('sx-kpis');
    if (!box) return;
    const rows = sxRotationRows();
    const chip = r => `<button type="button" class="sx-chip" title="${stEsc(r.sector_name)}"
        onclick="expandSector(${stEsc(JSON.stringify(r.sector_name))})">${stEsc(sxShort(r.sector_name))}</button>`;
    box.innerHTML = SX_QUADS.map(q => {
        const members = rows.filter(r => r.quadrant === q);
        const extra = members.length - SX_KPI_VISIBLE;
        const open = extra > 0 && _sxKpiOpen.has(q);
        return `<div class="sx-kpi" data-q="${q}">
            <div class="sx-kpi-top">
                <span class="sx-kpi-label">${q}<button type="button" class="sx-info" data-help="q-${q}"
                    aria-label="About ${q}" aria-expanded="false" aria-controls="sx-pop">i</button></span>
                <span class="sx-kpi-count">${_sxRotation ? members.length : '—'}</span>
            </div>
            <div class="sx-kpi-hint">${SX_Q_HINT[q]}</div>
            <div class="sx-kpi-names">${members.slice(0, SX_KPI_VISIBLE).map(chip).join('')}</div>
            ${extra > 0 ? `
                <div class="sx-kpi-more${open ? ' open' : ''}" id="sx-kpi-more-${q}">
                    <div>${members.slice(SX_KPI_VISIBLE).map(chip).join('')}</div>
                </div>
                <button type="button" class="sx-kpi-toggle" aria-expanded="${open}" aria-controls="sx-kpi-more-${q}"
                    data-more="+${extra} more" onclick="sxToggleKpi('${q}')">${open ? 'Show less' : `+${extra} more`}</button>` : ''}
        </div>`;
    }).join('');
}

/** Expand/collapse a quadrant tile in place (state survives re-renders). */
function sxToggleKpi(q) {
    const open = !_sxKpiOpen.has(q);
    if (open) _sxKpiOpen.add(q); else _sxKpiOpen.delete(q);
    const tile = document.querySelector(`#sx-kpis .sx-kpi[data-q="${q}"]`);
    if (!tile) return;
    tile.querySelector('.sx-kpi-more')?.classList.toggle('open', open);
    const btn = tile.querySelector('.sx-kpi-toggle');
    if (btn) {
        btn.setAttribute('aria-expanded', String(open));
        btn.textContent = open ? 'Show less' : btn.dataset.more;
    }
}

// ── Daily × Weekly agreement ──

let _sxAgreeMixedOpen = false;
const SX_AGREE_ORDER = ['Leading', 'Improving', 'Weakening', 'Lagging'];

/**
 * Compare each sector's quadrant on the daily and weekly rotation views.
 * Returns { confirmed: {Leading: [...], ...}, mixed: [...], total }.
 */
function sxAgreement() {
    const daily = new Map(sxRotationRows('daily').map(r => [r.sector_name, r]));
    const weekly = new Map(sxRotationRows('weekly').map(r => [r.sector_name, r]));
    const names = [...new Set([...daily.keys(), ...weekly.keys()])];
    const confirmed = Object.fromEntries(SX_AGREE_ORDER.map(q => [q, []]));
    const mixed = [];
    // Strength of a reading = distance of its latest point from the centre (100, 100).
    const dist = r => {
        const p = r?.trail?.[r.trail.length - 1];
        return p ? Math.hypot(p.ratio - 100, p.momentum - 100) : 0;
    };
    for (const name of names) {
        const d = daily.get(name), w = weekly.get(name);
        if (d && w && d.quadrant === w.quadrant) {
            confirmed[d.quadrant].push({ name, strength: dist(d) + dist(w) });
        } else {
            mixed.push({ name, daily: d?.quadrant || null, weekly: w?.quadrant || null });
        }
    }
    SX_AGREE_ORDER.forEach(q => confirmed[q].sort((a, b) => b.strength - a.strength));
    // Mixed: show the most actionable combinations first (anything involving Leading/Improving).
    const rank = q => (q ? SX_AGREE_ORDER.indexOf(q) : 9);
    mixed.sort((a, b) => Math.min(rank(a.daily), rank(a.weekly)) - Math.min(rank(b.daily), rank(b.weekly))
        || a.name.localeCompare(b.name));
    return { confirmed, mixed, total: names.length };
}

function sxRenderAgree() {
    const box = document.getElementById('sx-agree');
    const summary = document.getElementById('sx-agree-summary');
    if (!box) return;
    const hasBoth = sxRotationRows('daily').length && sxRotationRows('weekly').length;
    if (!hasBoth) {
        if (summary) summary.textContent = '';
        box.innerHTML = `<div class="sx-empty"><b>Needs both timeframes</b>${
            _sxRotation ? 'Not enough weekly history yet to compare.' : 'Press Refresh to compute the rotation map.'}</div>`;
        return;
    }
    const { confirmed, mixed, total } = sxAgreement();
    const agreeCount = SX_AGREE_ORDER.reduce((n, q) => n + confirmed[q].length, 0);
    if (summary) summary.innerHTML = `<b>${agreeCount}</b> of ${total} agree`;

    const chip = (name, extra = '') => `<button type="button" class="sx-chip${extra}" title="${stEsc(name)}"
        onclick="expandSector(${stEsc(JSON.stringify(name))})"
        onmouseenter="sxFocus(${stEsc(JSON.stringify(name))})" onmouseleave="sxFocus(null)">${stEsc(sxShort(name))}</button>`;

    const cols = SX_AGREE_ORDER.map(q => {
        const list = confirmed[q];
        return `<div class="sx-agree-col" data-q="${q}">
            <div class="sx-agree-top">
                <span class="sx-kpi-label">${q} on both</span>
                <span class="sx-agree-count">${list.length}</span>
            </div>
            <div class="sx-agree-chips">${list.length
                ? list.map(x => chip(x.name)).join('')
                : '<span class="sx-agree-none">None right now</span>'}</div>
        </div>`;
    }).join('');

    const tag = (tf, q) => q
        ? `<span class="sx-chip sx-chip--q" data-q="${q}">${tf} ${q}</span>`
        : `<span class="sx-chip">${tf} n/a</span>`;
    const mixedRows = mixed.map(m => `<div class="sx-agree-mixed-row">
            ${chip(m.name, ' sx-chip--name')}
            <span class="sx-agree-vs">${tag('Daily', m.daily)}${tag('Weekly', m.weekly)}</span>
        </div>`).join('');

    box.innerHTML = `<div class="sx-agree">${cols}</div>${mixed.length ? `
        <button type="button" class="sx-agree-toggle" aria-expanded="${_sxAgreeMixedOpen}" aria-controls="sx-agree-mixed"
            onclick="sxToggleAgreeMixed()">${_sxAgreeMixedOpen ? 'Hide' : 'Show'} ${mixed.length} mixed reading${mixed.length === 1 ? '' : 's'}</button>
        <div id="sx-agree-mixed" class="sx-kpi-more sx-agree-mixed${_sxAgreeMixedOpen ? ' open' : ''}">
            <div>${mixedRows}</div>
        </div>` : ''}`;
}

function sxToggleAgreeMixed() {
    _sxAgreeMixedOpen = !_sxAgreeMixedOpen;
    const panel = document.getElementById('sx-agree-mixed');
    const btn = document.querySelector('.sx-agree-toggle');
    panel?.classList.toggle('open', _sxAgreeMixedOpen);
    if (btn) {
        const n = panel ? panel.querySelectorAll('.sx-agree-mixed-row').length : 0;
        btn.setAttribute('aria-expanded', String(_sxAgreeMixedOpen));
        btn.textContent = `${_sxAgreeMixedOpen ? 'Hide' : 'Show'} ${n} mixed reading${n === 1 ? '' : 's'}`;
    }
}

// ── Money flow ──

function sxRenderFlow() {
    const box = document.getElementById('sx-flow');
    if (!box) return;
    const rows = sxRotationRows();
    if (!rows.length) {
        box.innerHTML = '<div class="sx-empty"><b>No rotation data yet</b>Press Refresh to compute where money is rotating.</div>';
        return;
    }
    const maxAbs = Math.max(...rows.map(r => Math.abs(r.flow || 0)), 0.0001);
    const row = r => {
        const q = r.quadrant;
        const moved = r.previous_quadrant && r.previous_quadrant !== q;
        const angle = r.heading?.angle ?? 0;
        return `<div class="sx-flow-row" style="--q:${sxColor(q)}" onclick="expandSector(${stEsc(JSON.stringify(r.sector_name))})"
                    onmouseenter="sxFocus(${stEsc(JSON.stringify(r.sector_name))})" onmouseleave="sxFocus(null)">
            <span class="sx-arrow" title="Heading ${Math.round(angle)}°"><span style="display:inline-flex;transform:rotate(${-angle}deg)">${SX_ARROW}</span></span>
            <div style="min-width:0">
                <div class="sx-flow-name">${stEsc(sxShort(r.sector_name))}</div>
                <div class="sx-flow-meta">${moved ? `${stEsc(r.previous_quadrant)} → ${sxQChip(q)}` : sxQChip(q)}</div>
            </div>
            <div class="sx-flow-bar" title="Rotation score ${(r.flow || 0).toFixed(2)}"><span style="--w:${(Math.abs(r.flow || 0) / maxAbs).toFixed(3)}"></span></div>
        </div>`;
    };
    const inflow = rows.filter(r => r.flow > 0).slice(0, 5);
    const outflow = rows.filter(r => r.flow < 0).slice(-5).reverse();
    const group = (title, color, list, empty) => `
        <div class="sx-flow-group">
            <h4><i style="background:${color}"></i>${title}</h4>
            ${list.length ? list.map(row).join('') : `<div class="sx-flow-empty">${empty}</div>`}
        </div>`;
    box.innerHTML = group('Rotating in', sxColor('Leading'), inflow, 'No sector gained relative momentum.')
        + group('Rotating out', sxColor('Lagging'), outflow, 'No sector lost relative momentum.');
}

// ── Heatmap ──

function sxRenderHeat() {
    const box = document.getElementById('sx-heat');
    if (!box) return;
    const perf = _sxRotation?.performance || [];
    if (!perf.length) {
        box.innerHTML = '<div class="sx-empty"><b>No returns yet</b>Returns appear after the next refresh.</div>';
        return;
    }
    const cols = ['1D', '1W', '1M', '3M'];
    const cap = Object.fromEntries(cols.map(c => [c, Math.max(0.5, ...perf.map(p => Math.abs(p.returns?.[c] ?? 0)))]));
    const cell = (v, c) => {
        if (v === null || v === undefined) return '<div class="sx-cell">—</div>';
        const a = 0.1 + 0.62 * Math.min(1, Math.abs(v) / cap[c]);
        const bg = v >= 0 ? `rgba(34,197,94,${a.toFixed(3)})` : `rgba(244,63,94,${a.toFixed(3)})`;
        return `<div class="sx-cell" style="background:${bg}" title="${c}: ${sxPct(v)}">${sxPct(v)}</div>`;
    };
    box.innerHTML = `<div class="sx-heat-row"><div class="sx-heat-head">Sector</div>${cols.map(c => `<div class="sx-heat-head">${c}</div>`).join('')}</div>`
        + perf.map(p => `<div class="sx-heat-row">
            <div class="sx-heat-name" onclick="expandSector(${stEsc(JSON.stringify(p.sector_name))})">${stEsc(sxShort(p.sector_name))}</div>
            ${cols.map(c => cell(p.returns?.[c], c)).join('')}
        </div>`).join('');
}

// ── Leaderboard ──

function renderSectorsTable(sectors) {
    const box = document.getElementById('sectors-table');
    if (!box) return;
    window._lastSectors = sectors;
    if (!sectors || !sectors.length) {
        box.innerHTML = '<div class="sx-empty"><b>No sector data yet</b>Press Refresh to run the sector analysis.</div>';
        return;
    }
    const trendColor = { Strong: 'var(--sx-lead)', Moderate: 'var(--sx-weak)', Weak: 'var(--text-muted)', Bearish: 'var(--sx-lag)' };
    const bar = (label, v) => {
        const pct = Math.round((v || 0) * 100);
        const c = pct >= 65 ? 'var(--sx-lead)' : pct >= 40 ? 'var(--sx-weak)' : 'var(--sx-lag)';
        return `<span class="sx-bar" title="${label}: ${pct}%"><i style="--h:${pct}%;--c:${c}"></i><em>${label}</em></span>`;
    };
    const ring = v => {
        const pct = Math.max(0, Math.min(100, Math.round((v || 0) * 100)));
        const r = 18, len = 2 * Math.PI * r;
        const c = pct >= 60 ? 'var(--sx-lead)' : pct >= 40 ? 'var(--sx-weak)' : 'var(--sx-lag)';
        return `<svg viewBox="0 0 44 44"><circle class="bg" cx="22" cy="22" r="${r}"/><circle class="fg" cx="22" cy="22" r="${r}" stroke="${c}"
            stroke-dasharray="${len.toFixed(2)}" stroke-dashoffset="${(len * (1 - pct / 100)).toFixed(2)}"/></svg><span>${pct}</span>`;
    };
    const head = `<div class="sx-board-head"><span>#</span><span>Sector</span><span class="sx-hide-sm">Rotation</span>
        <span class="sx-hide-sm">RS · H D W M</span><span class="sx-hide-sm">Trend</span><span>Score</span><span class="sx-hide-sm">Signals</span></div>`;
    const rows = sectors.map((s, i) => {
        const rot = sxRotationOf(s.sector_name);
        const tags = [
            s.is_above_20ema ? '<span class="sx-tag">20E</span>' : '',
            s.is_above_50ema ? '<span class="sx-tag">50E</span>' : '',
            s.is_making_higher_highs ? '<span class="sx-tag sx-tag--hh">HH</span>' : '',
        ].join('');
        const name = JSON.stringify(s.sector_name);
        return `<div class="sx-board-row${_selectedSector === s.sector_name ? ' is-selected' : ''}" data-name="${stEsc(s.sector_name)}"
                onclick="expandSector(${stEsc(name)})" onmouseenter="sxFocus(${stEsc(name)})" onmouseleave="sxFocus(null)">
            <span class="sx-rank">${i + 1}</span>
            <div class="sx-name"><b>${stEsc(s.sector_name)}</b><small>${stEsc(s.stock_count ?? 0)} stocks ${tags}</small></div>
            <span class="sx-hide-sm">${rot ? sxQChip(rot.quadrant) : '<span class="sx-flow-empty" style="padding:0">—</span>'}</span>
            <div class="sx-bars sx-hide-sm">${bar('H', s.hourly_rs ?? s.daily_rs)}${bar('D', s.daily_rs)}${bar('W', s.weekly_rs)}${bar('M', s.monthly_rs)}</div>
            <div class="sx-trend sx-hide-sm"><span style="color:${trendColor[s.trend] || 'var(--text-muted)'}">${stEsc(s.trend && s.trend !== '—' ? s.trend : '—')}</span>${sxTurnTag(s)}</div>
            <div class="sx-ring" onmouseenter="sxScoreTip(event, ${i})" onmouseleave="hideScoreTooltip()">${ring(s.combined_score)}</div>
            <span class="sx-hide-sm" style="justify-self:center">${s.active_signals > 0 ? `<span class="sx-sig">${stEsc(s.active_signals)}</span>` : ''}</span>
        </div>`;
    }).join('');
    box.innerHTML = head + rows;
}

// The trend label is a level (how the sector has done); the rotation map is a direction.
// When they disagree, say so: a weak sector gaining on Nifty is "turning up", a strong one
// losing ground is "cooling". Shown only when Daily and Weekly both agree (one timeframe
// alone flips too often to be worth flagging).
const SX_TURN_WEAK = new Set(['Weak', 'Bearish']);
const SX_TURN_STRONG = new Set(['Strong', 'Moderate']);

function sxTurnOf(s) {
    const d = sxRotationOf(s.sector_name, 'daily')?.quadrant;
    const w = sxRotationOf(s.sector_name, 'weekly')?.quadrant;
    const pick = (qs, kind) => (qs.includes(d) && qs.includes(w)) ? { kind, d, w } : null;
    if (SX_TURN_WEAK.has(s.trend)) return pick(['Improving', 'Leading'], 'up');
    if (SX_TURN_STRONG.has(s.trend)) return pick(['Weakening', 'Lagging'], 'down');
    return null;
}

function sxTurnTag(s) {
    const t = sxTurnOf(s);
    if (!t) return '';
    const quads = `Daily: ${t.d || '—'}, Weekly: ${t.w || '—'}`;
    const tip = t.kind === 'up'
        ? `${s.trend} so far, but relative strength vs Nifty is now rising (${quads}). An early turn: watch it, confirm before acting.`
        : `${s.trend} so far, but relative strength vs Nifty is now fading (${quads}). Momentum is cooling: tighten stops, be careful adding.`;
    return `<span class="sx-turn sx-turn--${t.kind}" title="${stEsc(tip)}">`
        + `${t.kind === 'up' ? '↗ Turning up' : '↘ Cooling'}<small>D + W</small></span>`;
}

function sxScoreTip(event, index) {
    const s = _sxSectors[index];
    if (s) showScoreTooltip(event, s);
}

// ── Rotation map (SVG) ──

function sxPath(pts) {
    if (pts.length < 2) return '';
    let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
        const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
        const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
        d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
    }
    return d;
}

function sxResample(pts, n) {
    if (!pts || !pts.length) return null;
    // Align from the newest point backwards; pad with the oldest point.
    const out = [];
    for (let i = 0; i < n; i++) {
        const src = pts.length - n + i;
        out.push(pts[Math.max(0, src)].slice());
    }
    return out;
}

function sxRenderRrg(animate) {
    const svg = document.getElementById('sx-rrg');
    const wrap = document.getElementById('sx-rrg-wrap');
    if (!svg || !wrap) return;
    const W = wrap.clientWidth, H = wrap.clientHeight;
    if (!W || !H) return;
    cancelAnimationFrame(_sxAnim);
    sxBindRrgPointer(svg);
    sxHoverClear();
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const NS = 'http://www.w3.org/2000/svg';
    const rows = sxRotationRows();

    if (!rows.length) {
        svg.innerHTML = `<text class="sx-empty-svg" x="${W / 2}" y="${H / 2}" text-anchor="middle">${
            _sxRotation ? 'Not enough history for this timeframe yet.' : 'Press Refresh to compute the rotation map.'}</text>`;
        _sxCur = {};
        return;
    }

    // Domain: symmetric around 100 so the quadrants stay centred.
    let ext = 1.5;
    rows.forEach(r => r.trail.forEach(p => { ext = Math.max(ext, Math.abs(p.ratio - 100), Math.abs(p.momentum - 100)); }));
    ext *= 1.14;
    const pad = { l: 46, r: 18, t: 16, b: 36 };
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    const X = v => pad.l + ((v - (100 - ext)) / (2 * ext)) * iw;
    const Y = v => pad.t + (1 - (v - (100 - ext)) / (2 * ext)) * ih;
    const cx = X(100), cy = Y(100);

    // Static layer: quadrant tints, grid, axes, labels.
    const quad = (x, y, w, h, q, lx, ly, anchor) => `
        <rect class="sx-q-bg" x="${x}" y="${y}" width="${w}" height="${h}" fill="${sxColor(q)}" fill-opacity="0.07"/>
        <text class="sx-q-label" x="${lx}" y="${ly}" text-anchor="${anchor}" fill="${sxColor(q)}" fill-opacity="0.75">${q}</text>`;
    let stat = quad(cx, pad.t, pad.l + iw - cx, cy - pad.t, 'Leading', pad.l + iw - 10, pad.t + 18, 'end')
        + quad(cx, cy, pad.l + iw - cx, pad.t + ih - cy, 'Weakening', pad.l + iw - 10, pad.t + ih - 10, 'end')
        + quad(pad.l, cy, cx - pad.l, pad.t + ih - cy, 'Lagging', pad.l + 10, pad.t + ih - 10, 'start')
        + quad(pad.l, pad.t, cx - pad.l, cy - pad.t, 'Improving', pad.l + 10, pad.t + 18, 'start');
    const step = ext > 6 ? 2 : ext > 3 ? 1 : 0.5;
    for (let v = Math.ceil((100 - ext) / step) * step; v <= 100 + ext; v += step) {
        if (Math.abs(v - 100) < 1e-9) continue;
        stat += `<line class="sx-grid-line" x1="${X(v)}" y1="${pad.t}" x2="${X(v)}" y2="${pad.t + ih}"/>
                 <line class="sx-grid-line" x1="${pad.l}" y1="${Y(v)}" x2="${pad.l + iw}" y2="${Y(v)}"/>
                 <text class="sx-tick" x="${X(v)}" y="${pad.t + ih + 14}" text-anchor="middle">${+v.toFixed(1)}</text>
                 <text class="sx-tick" x="${pad.l - 6}" y="${Y(v) + 3}" text-anchor="end">${+v.toFixed(1)}</text>`;
    }
    stat += `<line class="sx-axis" x1="${cx}" y1="${pad.t}" x2="${cx}" y2="${pad.t + ih}"/>
             <line class="sx-axis" x1="${pad.l}" y1="${cy}" x2="${pad.l + iw}" y2="${cy}"/>
             <text class="sx-axis-title" x="${pad.l + iw / 2}" y="${H - 4}" text-anchor="middle">RS-Ratio →</text>
             <text class="sx-axis-title" transform="translate(12 ${pad.t + ih / 2}) rotate(-90)" text-anchor="middle">RS-Momentum →</text>`;

    svg.innerHTML = `<defs></defs><g>${stat}</g><g id="sx-series-layer"></g>`;
    const defs = svg.querySelector('defs');
    const layer = svg.querySelector('#sx-series-layer');

    // Series: target points, starting points (current animation state or the centre).
    const series = rows.map((r, i) => {
        const target = r.trail.map(p => [p.ratio, p.momentum]);
        const start = animate
            ? (sxResample(_sxCur[r.sector_name], target.length) || target.map(() => [100, 100]))
            : target.map(p => p.slice());
        const color = sxColor(r.quadrant);
        const id = `sxg-${i}`;
        const grad = document.createElementNS(NS, 'linearGradient');
        grad.setAttribute('id', id);
        grad.setAttribute('gradientUnits', 'userSpaceOnUse');
        grad.innerHTML = `<stop offset="0" stop-color="${color}" stop-opacity="0.04"/><stop offset="1" stop-color="${color}" stop-opacity="0.95"/>`;
        defs.appendChild(grad);

        const g = document.createElementNS(NS, 'g');
        g.setAttribute('class', `sx-series${_sxFocusName === r.sector_name ? ' is-focus' : ''}`);
        g.dataset.name = r.sector_name;
        g.innerHTML = `<path class="sx-tail" stroke="url(#${id})"/>
            ${target.slice(0, -1).map((_, k) => `<circle class="sx-tail-dot" r="${(1.4 + 1.6 * k / target.length).toFixed(2)}" fill="${color}" fill-opacity="${(0.15 + 0.6 * k / target.length).toFixed(2)}"/>`).join('')}
            <circle class="sx-halo" r="11" fill="${color}"/>
            <circle class="sx-head" r="5.5" fill="${color}"/>
            <text class="sx-label">${stEsc(sxShort(r.sector_name))}</text>`;
        layer.appendChild(g);
        return { r, g, grad, start, target, delay: animate ? i * 28 : 0,
                 path: g.querySelector('.sx-tail'), dots: g.querySelectorAll('.sx-tail-dot'),
                 halo: g.querySelector('.sx-halo'), head: g.querySelector('.sx-head'), label: g.querySelector('.sx-label') };
    });
    if (_sxFocusName) svg.classList.add('has-focus'); else svg.classList.remove('has-focus');

    const duration = animate ? 1100 : 0;
    const t0 = performance.now();
    const frame = now => {
        let running = false;
        for (const s of series) {
            const local = duration ? Math.min(1, Math.max(0, (now - t0 - s.delay) / duration)) : 1;
            if (local < 1) running = true;
            const k = sxEase(local);
            const pts = s.target.map((p, j) => [s.start[j][0] + (p[0] - s.start[j][0]) * k, s.start[j][1] + (p[1] - s.start[j][1]) * k]);
            _sxCur[s.r.sector_name] = pts;
            const px = pts.map(p => [X(p[0]), Y(p[1])]);
            const first = px[0], last = px[px.length - 1];
            s.path.setAttribute('d', sxPath(px));
            s.grad.setAttribute('x1', first[0]); s.grad.setAttribute('y1', first[1]);
            s.grad.setAttribute('x2', last[0] + 0.01); s.grad.setAttribute('y2', last[1] + 0.01);
            s.dots.forEach((d, j) => { d.setAttribute('cx', px[j][0]); d.setAttribute('cy', px[j][1]); });
            s.head.setAttribute('cx', last[0]); s.head.setAttribute('cy', last[1]);
            s.halo.setAttribute('cx', last[0]); s.halo.setAttribute('cy', last[1]);
            s.lastPx = last;
        }
        // Labels: second pass so every dot counts as an obstacle, not just earlier labels.
        const heads = series.map(s => s.lastPx);
        const placed = heads.map(h => [h[0] - 7, h[1] - 7, 14, 14]);
        const cands = [[9, -8, 'start'], [9, 15, 'start'], [-9, -8, 'end'], [-9, 15, 'end'], [9, 27, 'start'], [-9, -20, 'end']];
        for (const s of series) {
            const last = s.lastPx;
            const wLab = 6.6 * sxShort(s.r.sector_name).length + 8;
            let pick = null;
            for (const c of cands) {
                const bx = c[2] === 'start' ? last[0] + c[0] : last[0] + c[0] - wLab;
                const by = last[1] + c[1] - 11;
                const hit = placed.some(b => bx < b[0] + b[2] && bx + wLab > b[0] && by < b[1] + b[3] && by + 14 > b[1]
                    && !(b[2] === 14 && Math.abs(b[0] + 7 - last[0]) < 0.5 && Math.abs(b[1] + 7 - last[1]) < 0.5));
                if (!hit) { pick = c; placed.push([bx, by, wLab, 14]); break; }
            }
            // No free spot: hide the label in the crowd (it shows on hover/focus).
            s.label.classList.toggle('sx-label--crowded', !pick);
            pick = pick || cands[0];
            s.label.setAttribute('x', last[0] + pick[0]);
            s.label.setAttribute('y', last[1] + pick[1]);
            s.label.setAttribute('text-anchor', pick[2]);
        }
        if (running) _sxAnim = requestAnimationFrame(frame);
    };
    _sxAnim = requestAnimationFrame(frame);
}

/*
 * Hover on the map uses one set of delegated pointer listeners on the <svg>
 * instead of per-sector mouseenter/mouseleave. sxFocus() re-appends the hovered
 * group to draw it on top, and moving a node under the pointer suppresses its
 * mouseleave, which used to leave the tooltip stuck on screen.
 */
let _sxHoverName = null;

function sxBindRrgPointer(svg) {
    if (svg.dataset.bound) return;
    svg.dataset.bound = '1';
    const track = e => {
        const g = e.target.closest?.('.sx-series');
        const name = g ? g.dataset.name : null;
        if (name === _sxHoverName) return;
        if (!name) { sxHoverClear(); return; }
        const r = sxRotationOf(name);
        if (!r) { sxHoverClear(); return; }
        _sxHoverName = name;
        sxFocus(name);
        sxShowTip(r);
    };
    svg.addEventListener('pointerover', track);
    svg.addEventListener('pointermove', track);
    svg.addEventListener('pointerleave', sxHoverClear);
    svg.addEventListener('click', e => {
        const g = e.target.closest?.('.sx-series');
        if (g) expandSector(g.dataset.name);
    });
}

function sxHoverClear() {
    if (_sxHoverName === null && !document.getElementById('sx-rrg-tip')?.classList.contains('show')) return;
    _sxHoverName = null;
    sxFocus(null);
    sxHideTip();
}

function sxFocus(name) {
    _sxFocusName = name;
    const svg = document.getElementById('sx-rrg');
    if (!svg) return;
    svg.classList.toggle('has-focus', !!name);
    svg.querySelectorAll('.sx-series').forEach(g => g.classList.toggle('is-focus', g.dataset.name === name));
    // Bring the focused series to the front.
    if (name) {
        const g = [...svg.querySelectorAll('.sx-series')].find(el => el.dataset.name === name);
        if (g) g.parentNode.appendChild(g);
    }
}

function sxShowTip(r) {
    const tip = document.getElementById('sx-rrg-tip');
    const wrap = document.getElementById('sx-rrg-wrap');
    const svg = document.getElementById('sx-rrg');
    const head = [...svg.querySelectorAll('.sx-series')].find(g => g.dataset.name === r.sector_name)?.querySelector('.sx-head');
    if (!tip || !wrap || !head) return;
    const last = r.trail[r.trail.length - 1];
    const ret = sxReturnsOf(r.sector_name);
    const moved = r.previous_quadrant && r.previous_quadrant !== r.quadrant;
    tip.innerHTML = `
        <div class="sx-tip-title">${stEsc(r.sector_name)} ${sxQChip(r.quadrant)}</div>
        ${moved ? `<div class="sx-tip-row"><span>Moved from</span><b>${stEsc(r.previous_quadrant)}</b></div>` : ''}
        <div class="sx-tip-row"><span>RS-Ratio</span><b>${last.ratio.toFixed(2)}</b></div>
        <div class="sx-tip-row"><span>RS-Momentum</span><b>${last.momentum.toFixed(2)}</b></div>
        <div class="sx-tip-row"><span>Speed</span><b>${(r.heading?.speed ?? 0).toFixed(2)}</b></div>
        <div class="sx-tip-row"><span>1W / 1M</span><b>${sxPct(ret['1W'])} / ${sxPct(ret['1M'])}</b></div>`;
    const svgBox = svg.getBoundingClientRect();
    const scale = svgBox.width / (svg.viewBox.baseVal.width || svgBox.width);
    const hx = (+head.getAttribute('cx')) * scale, hy = (+head.getAttribute('cy')) * scale;
    const tw = 210, th = 140;
    const left = hx + 16 + tw > wrap.clientWidth ? hx - tw - 16 : hx + 16;
    const top = Math.min(Math.max(8, hy - th / 2), wrap.clientHeight - th - 8);
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${top}px`;
    tip.classList.add('show');
}

function sxHideTip() {
    document.getElementById('sx-rrg-tip')?.classList.remove('show');
}

// ── Detail drawer ──

async function expandSector(sectorName) {
    sxDrawerMsg('');
    _selectedSector = sectorName;
    document.querySelectorAll('#sectors-table .sx-board-row').forEach(r =>
        r.classList.toggle('is-selected', r.dataset.name === sectorName));

    const panel = document.getElementById('sector-stocks-panel');
    const listEl = document.getElementById('sector-stocks-list');
    const s = _sxSectors.find(x => x.sector_name === sectorName) || {};
    const rot = sxRotationOf(sectorName);
    const ret = sxReturnsOf(sectorName);

    document.getElementById('sector-stocks-title').textContent = sectorName;
    document.getElementById('sx-drawer-tags').innerHTML = [
        rot ? sxQChip(rot.quadrant, `${rot.quadrant} · ${_sxTf}`) : '',
        s.trend && s.trend !== '—' ? `<span class="sx-chip">${stEsc(s.trend)} trend</span>` : '',
        s.active_signals ? `<span class="sx-chip">${stEsc(s.active_signals)} active signals</span>` : '',
    ].join('');
    const pct = v => (v === null || v === undefined) ? '—' : `${Math.round(v * 100)}%`;
    document.getElementById('sx-drawer-stats').innerHTML = [
        ['Score', pct(s.combined_score)],
        ['Rel. strength', pct(s.relative_strength)],
        ['1 week', sxPct(ret['1W'])],
        ['1 month', sxPct(ret['1M'])],
    ].map(([k, v]) => `<div class="sx-stat"><span>${k}</span><b>${stEsc(v)}</b></div>`).join('');

    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    document.getElementById('sx-scrim').classList.add('open');
    listEl.innerHTML = '<div class="sx-empty"><span class="spinner"></span></div>';
    requestAnimationFrame(() => loadSectorChart(sectorName));

    try {
        const response = await fetch(`${API_BASE}/api/settings/sectors/${encodeURIComponent(sectorName)}/stocks`);
        const data = await response.json();
        if (_selectedSector !== sectorName) return;
        _sxStocks = data && Array.isArray(data.stocks) ? data : { stocks: Array.isArray(data) ? data : [] };
        sxRenderStocks();
    } catch (err) {
        listEl.innerHTML = `<div class="sx-empty">Could not load stocks: ${stEsc(err.message)}</div>`;
    }
}

let _sxStocks = null;          // last /sectors/{name}/stocks payload
let _sxStocksFnoOnly = false;  // "F&O only" filter in the sector panel

function sxSetStocksFilter(fnoOnly) {
    _sxStocksFnoOnly = !!fnoOnly;
    sxRenderStocks();
}

function sxRenderStocks() {
    const listEl = document.getElementById('sector-stocks-list');
    if (!listEl || !_sxStocks) return;
    const all = _sxStocks.stocks || [];
    if (!all.length) {
        listEl.innerHTML = '<div class="sx-empty">No constituents listed for this sector.</div>';
        return;
    }
    const fnoCount = all.filter(st => st.is_fno).length;
    const shown = _sxStocksFnoOnly ? all.filter(st => st.is_fno) : all;
    const asOf = _sxStocks.as_of
        ? `NSE list as of ${new Date(_sxStocks.as_of + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`
        : 'NSE list';
    const head = `<div class="sx-stocks-head">
        <span><b>${all.length}</b> stocks · <b>${fnoCount}</b> in F&amp;O · ${stEsc(asOf)}</span>
        <span class="sx-seg sx-seg--sm" role="tablist">
            <button type="button" class="${_sxStocksFnoOnly ? '' : 'active'}" onclick="sxSetStocksFilter(false)">All</button>
            <button type="button" class="${_sxStocksFnoOnly ? 'active' : ''}" onclick="sxSetStocksFilter(true)">F&amp;O only</button>
        </span>
    </div>`;
    const rows = shown.map(st => {
        const sig = st.has_signal
            ? `<span class="sx-sig">${st.signal_type === 'explosion' ? 'BREAKOUT' : 'VCP'} ${Math.round((st.signal_score || 0) * 100)}%</span>` : '';
        const occ = st.occurrence_number > 1 ? `<span class="sx-chip">${stEsc(ordinal(st.occurrence_number))} time</span>` : '';
        const fno = !st.in_dhan
            ? '<span class="sx-chip sx-chip--warn" title="This constituent was not found in the Dhan instrument list. Refresh Instruments in Settings.">Not on Dhan</span>'
            : st.is_fno
                ? `<span class="sx-chip sx-chip--fno">F&amp;O${st.lot_size > 1 ? ` · lot ${stEsc(st.lot_size)}` : ''}</span>`
                : '<span class="sx-chip sx-chip--muted" title="Index constituent without F&amp;O contracts (cash market only)">No F&amp;O</span>';
        return `<div class="sx-stock${st.is_fno ? '' : ' sx-stock--cash'}">
            <div style="min-width:0"><b>${stEsc(st.symbol)}</b><small>${stEsc(st.display_name || st.company || '')}</small></div>
            <div class="sx-stock-tags">${occ}${fno}${sig}</div>
        </div>`;
    }).join('');
    listEl.innerHTML = head + (rows || '<div class="sx-empty">No F&amp;O stocks in this index.</div>');
}

function closeSectorStocks() {
    sxDrawerMsg('');
    _selectedSector = null;
    const panel = document.getElementById('sector-stocks-panel');
    panel?.classList.remove('open');
    panel?.setAttribute('aria-hidden', 'true');
    document.getElementById('sx-scrim')?.classList.remove('open');
    document.querySelectorAll('#sectors-table .sx-board-row.is-selected').forEach(r => r.classList.remove('is-selected'));
}

document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && _selectedSector) closeSectorStocks();
});

// ── Refresh / Telegram ──

async function runSectorAnalysisFromTab() {
    const btn = document.getElementById('btn-refresh-sectors');
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Analyzing…';
    sxStatus('Analyzing sectors and themes…');
    try {
        const response = await fetch(`${API_BASE}/api/settings/scan/sectors`, { method: 'POST' });
        const data = await response.json();
        if (!response.ok) throw new Error(data?.detail || `HTTP ${response.status}`);
        await loadSectorsTab();
        sxStatus(`Refreshed ${data.sectors?.length ?? _sxSectors.length} sectors`, 'ok');
        if (_sectorTelegramOnRefresh) {
            sxStatus('Refreshed · sending Telegram…');
            try {
                const notify = await notifySectorReportToTelegram();
                sxStatus(`Refreshed + Telegram sent${notify?.telegram?.message_id ? ` (#${notify.telegram.message_id})` : ''}`, 'ok');
            } catch (err) {
                sxStatus(`Refreshed, Telegram failed: ${err.message}`, 'err');
            }
        }
    } catch (err) {
        console.error('Sector analysis failed:', err);
        sxStatus(`Refresh failed: ${err.message}`, 'err');
    } finally {
        btn.disabled = false;
        btn.innerHTML = original;
    }
}

async function sendSectorReportToTelegram() {
    if (!isAdminUser()) return;
    sxStatus('Sending Telegram report…');
    try {
        const notify = await notifySectorReportToTelegram();
        sxStatus(`Telegram sent${notify?.telegram?.message_id ? ` (#${notify.telegram.message_id})` : ''}`, 'ok');
    } catch (err) {
        sxStatus(`Telegram send failed: ${err.message}`, 'err');
    }
}

// ── Sector detail: "Open in Dhan" → TradingView on Dhan in a new tab ──

const SX_DHAN_TV_URL = 'https://tv.dhan.co/';

function sxDrawerMsg(text, kind) {
    const el = document.getElementById('sx-drawer-msg');
    if (!el) return;
    el.textContent = text || '';
    el.className = `sx-drawer-msg${kind ? ` sx-drawer-msg--${kind}` : ''}`;
    el.hidden = !text;
}

/** Open in a new tab; returns false if a pop-up blocker stopped it. */
function sxOpenTab(url) {
    // Not using the "noopener" feature: with it window.open() always returns null,
    // which would hide a blocked pop-up. Cutting the opener link gives the same isolation.
    const win = window.open(url, '_blank');
    if (!win) return false;
    try { win.opener = null; } catch (_) { /* cross-origin: already isolated */ }
    return true;
}

/**
 * tv.dhan.co has no documented link to a specific symbol, so copy the sector
 * name (to paste into its symbol search) and open it in a new tab.
 */
async function sxOpenInDhan() {
    const name = _selectedSector;
    if (!name) return;
    // Start the clipboard write while this tab still has focus, then open synchronously
    // inside the click so the browser treats the new tab as user-initiated.
    const copy = navigator.clipboard?.writeText(name).then(() => true, () => false) ?? Promise.resolve(false);
    const ok = sxOpenTab(SX_DHAN_TV_URL);
    const copied = await copy;
    if (!ok) {
        sxDrawerMsg('Your browser blocked the new tab. Allow pop-ups for this site, then try again.', 'err');
    } else {
        sxDrawerMsg(copied
            ? `Opened TradingView on Dhan. "${name}" is copied: paste it into the symbol search.`
            : `Opened TradingView on Dhan. Search for "${name}" there.`, 'ok');
    }
}

// ── IPOs tab: last 5 years of main-board IPOs vs their all-time high ──

const IPO_BAND_KEY = 'ipo-band-filter';
let _ipo = null;                 // /api/ipos payload
let _ipoYear = 'all';
let _ipoBand = (() => { try { return localStorage.getItem(IPO_BAND_KEY) || 'all'; } catch (_) { return 'all'; } })();
let _ipoSort = { key: 'listing_date', dir: -1 };
let _ipoPoll = 0;

const ipoPct = v => (v === null || v === undefined) ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(1)}%`;
const ipoCls = v => (v === null || v === undefined) ? '' : v >= 0 ? 'ipo-up' : 'ipo-down';
const ipoMoney = v => (v === null || v === undefined) ? '—' : `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const ipoDate = s => {
    if (!s) return '—';
    const d = new Date(`${s}T00:00:00`);
    return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};
const ipoInBand = (r, band) => band === 'all' || (band === 'at_ath' ? r.band === 'at_ath' : (r.band === 'at_ath' || r.band === 'near'));

async function loadIposTab() {
    const root = document.getElementById('content-ipos');
    try {
        const res = await fetch(`${API_BASE}/api/ipos`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        _ipo = await res.json();
    } catch (e) {
        _ipo = null;
        ipoStatus(`Could not load IPOs: ${e.message}`, 'err');
    }
    ipoRenderAll();
    root?.classList.remove('sx-in');
    void root?.offsetWidth;
    requestAnimationFrame(() => root?.classList.add('sx-in'));
    if (_ipo?.status?.running) ipoStartPolling();
}

function ipoStatus(text, kind) {
    const el = document.getElementById('ipo-status');
    if (!el) return;
    el.textContent = text || '';
    el.className = `sx-status${kind ? ` sx-status--${kind}` : ''}`;
}

function ipoRenderAll() {
    const asof = document.getElementById('ipo-asof');
    if (asof && _ipo?.available) {
        asof.textContent = `Main-board IPOs listed on NSE since ${ipoDate(_ipo.since)} · prices as of ${ipoDate(_ipo.as_of)}`
            + (_ipo.list_error ? ' · NSE list could not be refreshed, showing the previous one' : '');
    }
    ipoSyncBand();
    ipoRenderYears();
    ipoRender();
}

function ipoRows() { return _ipo?.ipos || []; }

function ipoRenderYears() {
    const box = document.getElementById('ipo-years');
    if (!box) return;
    const rows = ipoRows();
    if (!rows.length) { box.innerHTML = ''; return; }
    const years = [...new Set(rows.map(r => r.listing_date.slice(0, 4)))].sort().reverse();
    const tile = (key, label, list, hint) => {
        const at = list.filter(r => r.band === 'at_ath').length;
        const near = list.filter(r => r.band === 'at_ath' || r.band === 'near').length;
        return `<button type="button" class="ipo-year${_ipoYear === key ? ' is-active' : ''}" onclick="ipoSetYear('${key}')"
                aria-pressed="${_ipoYear === key}">
            <span class="ipo-year-label">${stEsc(label)}</span>
            <span class="ipo-year-count">${list.length}</span>
            <span class="ipo-year-hint">${stEsc(hint)}</span>
            <span class="ipo-year-stats"><i class="ipo-dot ipo-dot--at"></i>${at} at ATH <i class="ipo-dot ipo-dot--near"></i>${near} &lt;15%</span>
        </button>`;
    };
    const since = _ipo?.since ? `since ${ipoDate(_ipo.since)}` : 'since Nov 2021';
    box.innerHTML = tile('all', 'All years', rows, since)
        + years.map(y => {
            const list = rows.filter(r => r.listing_date.startsWith(y));
            const partial = _ipo?.since && y === _ipo.since.slice(0, 4) ? `from ${ipoDate(_ipo.since)}` : y === String(new Date().getFullYear()) ? 'year to date' : 'listed';
            return tile(y, y, list, partial);
        }).join('');
}

function ipoSetYear(y) {
    _ipoYear = y;
    ipoRenderYears();
    ipoRender();
}

function ipoSetBand(b) {
    _ipoBand = b;
    try { localStorage.setItem(IPO_BAND_KEY, b); } catch (_) { /* ignore */ }
    ipoSyncBand();
    ipoRender();
}

function ipoSyncBand() {
    const seg = document.getElementById('ipo-band');
    if (!seg) return;
    let active = null;
    seg.querySelectorAll('button').forEach(b => {
        const on = b.dataset.band === _ipoBand;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', String(on));
        if (on) active = b;
    });
    const ink = seg.querySelector('.sx-seg-ink');
    if (ink && active) {
        ink.style.width = `${active.offsetWidth}px`;
        ink.style.transform = `translateX(${active.offsetLeft}px)`;
    }
}

function ipoSortBy(key) {
    _ipoSort = _ipoSort.key === key ? { key, dir: -_ipoSort.dir } : { key, dir: key === 'symbol' ? 1 : -1 };
    ipoRender();
}

function ipoRender() {
    const box = document.getElementById('ipo-table');
    const count = document.getElementById('ipo-count');
    if (!box) return;
    const all = ipoRows();
    if (!all.length) {
        const running = _ipo?.status?.running;
        box.innerHTML = `<div class="sx-empty"><b>${running ? 'Building the IPO list…' : 'No IPO data yet'}</b>${running
            ? 'Loading price history for every IPO. The first build takes several minutes; later refreshes are quick.'
            : 'Press Refresh to download NSE\'s IPO list and work out each stock\'s all-time high from Dhan.'}</div>`;
        if (count) count.textContent = '';
        return;
    }
    const q = (document.getElementById('ipo-search')?.value || '').trim().toLowerCase();
    const fnoOnly = document.getElementById('ipo-fno')?.checked;
    let rows = all.filter(r => (_ipoYear === 'all' || r.listing_date.startsWith(_ipoYear))
        && ipoInBand(r, _ipoBand)
        && (!fnoOnly || r.is_fno)
        && (!q || r.symbol.toLowerCase().includes(q) || (r.company || '').toLowerCase().includes(q)
            || (r.dhan_symbol || '').toLowerCase().includes(q)));
    const { key, dir } = _ipoSort;
    rows = rows.slice().sort((a, b) => {
        const x = a[key], y = b[key];
        if (x === y) return 0;
        if (x === null || x === undefined) return 1;
        if (y === null || y === undefined) return -1;
        return (x > y ? 1 : -1) * dir;
    });
    if (count) count.textContent = `${rows.length} of ${all.length}`;
    const th = (k, label, cls = '') => `<button type="button" class="ipo-th ${cls}${key === k ? ' is-sorted' : ''}" onclick="ipoSortBy('${k}')">${label}${key === k ? (dir > 0 ? ' ↑' : ' ↓') : ''}</button>`;
    const head = `<div class="ipo-row ipo-head">${th('symbol', 'Stock')}${th('listing_date', 'Listed')}${th('issue_price', 'Issue', 'ipo-num ipo-hide-sm')}
        ${th('listing_gain_pct', 'Listing', 'ipo-num ipo-hide-sm')}${th('close', 'Close', 'ipo-num')}${th('since_issue_pct', 'Since IPO', 'ipo-num ipo-hide-sm')}
        ${th('ath', 'ATH', 'ipo-num ipo-hide-sm')}${th('from_ath_pct', 'From ATH', 'ipo-num')}</div>`;
    if (!rows.length) {
        box.innerHTML = head + '<div class="sx-empty"><b>No IPOs match</b>Try another year or a wider ATH filter.</div>';
        return;
    }
    const body = rows.map(r => {
        const off = r.from_ath_pct;
        const fill = off === null || off === undefined ? 0 : Math.max(0, Math.min(100, 100 + off));
        const bandCls = r.band === 'at_ath' ? 'ipo-band--at' : r.band === 'near' ? 'ipo-band--near' : 'ipo-band--below';
        const tags = [
            r.band === 'at_ath' ? '<span class="ipo-tag ipo-tag--at">At ATH</span>' : '',
            r.is_fno ? `<span class="sx-tag" title="Lot size ${stEsc(r.lot_size ?? '')}">F&amp;O</span>` : '',
            r.in_dhan ? '' : '<span class="ipo-tag ipo-tag--muted">Not on Dhan</span>',
        ].join('');
        const sym = r.dhan_symbol || r.symbol;
        return `<div class="ipo-row${r.in_dhan ? '' : ' is-missing'}" role="button" tabindex="0" data-sym="${stEsc(sym)}"
                onclick="ipoOpenInDhan(this.dataset.sym)" onkeydown="if(event.key==='Enter')ipoOpenInDhan(this.dataset.sym)"
                title="Open TradingView on Dhan (copies ${stEsc(sym)})">
            <div class="ipo-name"><b>${stEsc(sym)} ${tags}</b><small>${stEsc(r.company || r.display_name || '')}</small></div>
            <span class="ipo-date">${stEsc(ipoDate(r.listing_date))}</span>
            <span class="ipo-num ipo-hide-sm">${stEsc(ipoMoney(r.issue_price))}</span>
            <span class="ipo-num ipo-hide-sm ${ipoCls(r.listing_gain_pct)}">${stEsc(ipoPct(r.listing_gain_pct))}</span>
            <span class="ipo-num">${stEsc(ipoMoney(r.close))}</span>
            <span class="ipo-num ipo-hide-sm ${ipoCls(r.since_issue_pct)}">${stEsc(ipoPct(r.since_issue_pct))}</span>
            <span class="ipo-num ipo-hide-sm"><span>${stEsc(ipoMoney(r.ath))}</span><small>${stEsc(r.ath_date ? ipoDate(r.ath_date) : '')}</small></span>
            <span class="ipo-num ipo-ath ${bandCls}"><span>${stEsc(off === null || off === undefined ? '—' : `${Number(off).toFixed(1)}%`)}</span>
                <i class="ipo-meter"><i style="--w:${fill.toFixed(1)}%"></i></i></span>
        </div>`;
    }).join('');
    box.innerHTML = head + body;
}

async function ipoOpenInDhan(sym) {
    if (!sym) return;
    const copy = navigator.clipboard?.writeText(sym).then(() => true, () => false) ?? Promise.resolve(false);
    const ok = sxOpenTab(SX_DHAN_TV_URL);
    const copied = await copy;
    if (!ok) ipoStatus('Your browser blocked the new tab. Allow pop-ups for this site.', 'err');
    else ipoStatus(copied ? `Opened TradingView on Dhan · "${sym}" copied, paste it into the symbol search.` : `Opened TradingView on Dhan · search for "${sym}".`, 'ok');
}

async function ipoRefresh() {
    const btn = document.getElementById('btn-ipo-refresh');
    if (btn) btn.disabled = true;
    try {
        const res = await fetch(`${API_BASE}/api/ipos/refresh`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.detail || `HTTP ${res.status}`);
        ipoStatus(data.started ? 'Refreshing…' : (data.detail || 'A refresh is already running'));
        ipoStartPolling();
    } catch (e) {
        ipoStatus(`Refresh failed: ${e.message}`, 'err');
        if (btn) btn.disabled = false;
    }
}

function ipoStartPolling() {
    clearTimeout(_ipoPoll);
    const btn = document.getElementById('btn-ipo-refresh');
    if (btn) btn.disabled = true;
    const tick = async () => {
        let st = null;
        try { st = await (await fetch(`${API_BASE}/api/ipos/status`)).json(); } catch (_) { /* retry */ }
        if (st?.running) {
            ipoStatus(st.phase === 'prices' && st.total
                ? `Updating prices ${st.done}/${st.total}…`
                : 'Downloading the IPO list from NSE…');
            _ipoPoll = setTimeout(tick, 2000);
            return;
        }
        if (btn) btn.disabled = false;
        if (st?.error) { ipoStatus(`Refresh failed: ${st.error}`, 'err'); return; }
        const s = st?.summary;
        await loadIposTab();
        ipoStatus(s ? `Updated ${s.ipos} IPOs · ${s.at_ath} at ATH · ${s.near_ath} within 15%`
            + (s.price_failures ? ` · ${s.price_failures} price lookups failed` : '') : 'Updated', s?.price_failures ? '' : 'ok');
    };
    _ipoPoll = setTimeout(tick, 1200);
}

// ── Sectors tab: per-panel info popovers + full "How to read" guide ──
// Content is static (no user data), so it is inserted as trusted HTML.

const SX_HELP = {
    'q-Leading': {
        title: 'Leading',
        body: `<p><b>Beating Nifty 50, and the lead is still growing.</b> RS-Ratio &gt; 100 and RS-Momentum &gt; 100.</p>
            <p>This is where relative strength is concentrated right now. On the usual clockwise cycle, the next stop is <b>Weakening</b>: still ahead of Nifty, but losing momentum.</p>`,
    },
    'q-Improving': {
        title: 'Improving',
        body: `<p><b>Still behind Nifty 50, but catching up.</b> RS-Ratio &lt; 100 and RS-Momentum &gt; 100.</p>
            <p>Early recoveries. If the catch-up continues, these cross into <b>Leading</b>. Some turn back down into Lagging instead, so treat this as "worth watching", not "already strong".</p>`,
    },
    'q-Weakening': {
        title: 'Weakening',
        body: `<p><b>Still beating Nifty 50, but the lead is shrinking.</b> RS-Ratio &gt; 100 and RS-Momentum &lt; 100.</p>
            <p>Often the first warning that a leader is fading. Next stop on the cycle is usually <b>Lagging</b>, though a sector can re-accelerate back into Leading.</p>`,
    },
    'q-Lagging': {
        title: 'Lagging',
        body: `<p><b>Behind Nifty 50, and falling further behind.</b> RS-Ratio &lt; 100 and RS-Momentum &lt; 100.</p>
            <p>Relative strength has left these sectors. The first sign of a turn is a move up into <b>Improving</b>.</p>`,
    },
    agree: {
        title: 'Confirmed on Daily & Weekly',
        body: `<p>Sectors in the <b>same quadrant on both</b> timeframes, so you don't have to compare Daily and Weekly by hand. It always uses both, whichever way the map's toggle is set.</p>
            <ul>
                <li><b>Leading on both</b>: short- and longer-term strength agree, the firmest strength reading.</li>
                <li><b>Improving on both</b>: the catch-up shows on both timeframes.</li>
                <li><b>Weakening / Lagging on both</b>: weakness confirmed on both.</li>
                <li>Within each group, the strongest readings (furthest from the centre of the map) come first.</li>
            </ul>
            <p><b>Mixed readings</b> are sectors whose timeframes disagree, e.g. Daily Leading but Weekly Lagging: often a short-term move against the longer trend, or an early turn. Treat them as less certain.</p>`,
    },
    map: {
        title: 'Rotation map',
        body: `<p>Every Nifty sector index plotted against Nifty 50 (a Relative Rotation Graph).</p>
            <ul>
                <li><b>Horizontal: RS-Ratio.</b> Right of 100 = beating Nifty; left = trailing it.</li>
                <li><b>Vertical: RS-Momentum.</b> Above 100 = that relative strength is improving; below = deteriorating.</li>
                <li><b>Dot</b> = latest reading. <b>Tail</b> = the recent path, fading into the past (10 days on Daily, 8 weeks on Weekly).</li>
                <li>Distance from the centre = how strong the reading is. Dots near the centre lines can switch quadrant on a small move.</li>
            </ul>
            <p><b>Daily</b> shows short-term rotation; <b>Weekly</b> shows the bigger trend. Hover a dot for its numbers, click it for details. Crowded labels hide until you hover.</p>`,
    },
    flow: {
        title: 'Money flow',
        body: `<p>Which sectors moved most on the map on the <b>latest bar</b> of the selected timeframe.</p>
            <ul>
                <li><b>Rotating in</b>: relative strength rotating toward the sector (momentum and ratio rising). <b>Rotating out</b>: the opposite.</li>
                <li><b>Arrow</b> = direction of the move on the map (up-right is gaining on both axes).</li>
                <li><b>"Lagging → Improving"</b> means the sector changed quadrant on that bar.</li>
                <li><b>Bar</b> = size of the move compared with the biggest mover.</li>
            </ul>
            <p>"Money" here means relative performance against Nifty, not actual traded money: index data has no volume.</p>`,
    },
    heat: {
        title: 'Performance heatmap',
        body: `<p>Plain price returns of each sector index, so you can see <b>absolute</b> moves next to the <b>relative</b> picture on the map.</p>
            <ul>
                <li><b>1D / 1W / 1M / 3M</b> = last 1, 5, 21 and 63 trading days.</li>
                <li>Green = up, red = down. Colour strength is relative to the biggest move in that column.</li>
                <li>Sorted by 1-month return. Click a name for details.</li>
            </ul>
            <p>A sector can be <b>Leading</b> on the map and still be red here, if Nifty fell even more.</p>`,
    },
    board: {
        title: 'Momentum leaderboard',
        body: `<p>Sectors ranked by the dashboard's <b>momentum score</b> (0–100), the same score used by the scanners.</p>
            <ul>
                <li><b>Score</b> = 50% relative strength + 50% price action. Hover the ring for the breakdown.</li>
                <li><b>H D W M bars</b> = relative strength vs Nifty over hourly, daily, weekly and monthly lookbacks (weighted 20 / 30 / 40 / 10%).</li>
                <li><b>20E / 50E</b> = index above its 20 / 50-day EMA. <b>HH</b> = making higher highs.</li>
                <li><b>Trend</b> = Strong / Moderate / Weak / Bearish from the RS and price-action checks. It looks back, so it changes last.</li>
                <li><b>↗ Turning up</b> = trend still Weak/Bearish, but the rotation map shows it gaining on Nifty (Improving or Leading): an early turn to watch. <b>↘ Cooling</b> = trend Strong/Moderate, but losing ground (Weakening or Lagging). Shown only when Daily and Weekly agree. Hover the tag for the readings.</li>
                <li><b>Rotation</b> = the sector's quadrant on the selected timeframe. <b>Signals</b> = active scanner setups among its stocks.</li>
            </ul>
            <p>The score is a level ("how strong now"); the rotation map adds direction ("getting stronger or weaker").</p>`,
    },
};

let _sxPopFor = null;

function sxOpenInfo(btn) {
    const key = btn.dataset.help;
    const pop = document.getElementById('sx-pop');
    const help = SX_HELP[key];
    if (!pop || !help) return;
    if (_sxPopFor === btn) { sxCloseInfo(); return; }
    sxCloseInfo();
    _sxPopFor = btn;
    btn.setAttribute('aria-expanded', 'true');
    pop.innerHTML = `<div class="sx-pop-title">${help.title}</div><div class="sx-pop-body">${help.body}</div>
        <button type="button" class="sx-pop-more" onclick="sxCloseInfo(); sxOpenGuide();">Read the full guide →</button>`;
    pop.hidden = false;
    // Position under the button, kept inside the viewport.
    const b = btn.getBoundingClientRect();
    const w = Math.min(340, window.innerWidth - 24);
    pop.style.width = `${w}px`;
    let left = Math.min(Math.max(12, b.left + b.width / 2 - w / 2), window.innerWidth - w - 12);
    pop.style.left = `${left}px`;
    pop.style.top = '0px';
    const h = pop.offsetHeight;
    const below = b.bottom + 10;
    pop.style.top = `${below + h > window.innerHeight - 12 ? Math.max(12, b.top - h - 10) : below}px`;
    requestAnimationFrame(() => pop.classList.add('show'));
}

function sxCloseInfo() {
    const pop = document.getElementById('sx-pop');
    if (_sxPopFor) _sxPopFor.setAttribute('aria-expanded', 'false');
    _sxPopFor = null;
    if (!pop || pop.hidden) return;
    pop.classList.remove('show');
    pop.hidden = true;
}

function sxOpenGuide() {
    const g = document.getElementById('sx-guide');
    if (!g) return;
    sxCloseInfo();
    g.hidden = false;
    document.getElementById('sx-guide-scrim').classList.add('open');
    requestAnimationFrame(() => g.classList.add('open'));
    g.querySelector('.sx-guide-body').scrollTop = 0;
    g.querySelector('.sx-close')?.focus();
}

function sxCloseGuide() {
    const g = document.getElementById('sx-guide');
    if (!g || g.hidden) return;
    g.classList.remove('open');
    document.getElementById('sx-guide-scrim').classList.remove('open');
    setTimeout(() => { if (!g.classList.contains('open')) g.hidden = true; }, 350);
    document.getElementById('btn-sx-guide')?.focus();
}

document.addEventListener('click', e => {
    const info = e.target.closest?.('.sx-info');
    if (info) { e.stopPropagation(); sxOpenInfo(info); return; }
    if (_sxPopFor && !e.target.closest?.('#sx-pop')) sxCloseInfo();
});
document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (_sxPopFor) { sxCloseInfo(); e.stopImmediatePropagation(); return; }
    const g = document.getElementById('sx-guide');
    if (g && !g.hidden) { sxCloseGuide(); e.stopImmediatePropagation(); }
}, true);
window.addEventListener('resize', sxCloseInfo);
document.getElementById('content-sectors')?.addEventListener('scroll', sxCloseInfo, { passive: true });


let _scoreTooltipEl = null;

function showScoreTooltip(event, s) {
    hideScoreTooltip();

    const rs = Math.round((s.relative_strength || 0) * 100);
    const hrs = Math.round((s.hourly_rs || s.daily_rs || s.relative_strength || 0) * 100);
    const drs = Math.round((s.daily_rs || 0) * 100);
    const wrs = Math.round((s.weekly_rs || 0) * 100);
    const mrs = Math.round((s.monthly_rs || 0) * 100);
    const pa = Math.round((s.price_action_score || 0) * 100);
    const combined = Math.round((s.combined_score || 0) * 100);

    const check = v => v ? '✓' : '✗';
    const checkColor = v => v ? '#22c55e' : '#ef4444';

    const paChecks = [
        { label: 'Above 20 EMA', val: s.is_above_20ema },
        { label: 'Above 50 EMA', val: s.is_above_50ema },
        { label: 'Higher Highs (20d vs prior)', val: s.is_making_higher_highs },
        { label: 'Higher Lows (20d vs prior)', val: s.is_making_higher_lows },
        { label: 'EMA Aligned (20 > 50)', val: s.is_ema_aligned },
    ];
    const paCount = paChecks.filter(c => c.val).length;

    const tip = document.createElement('div');
    tip.className = 'score-tooltip';
    tip.innerHTML = `
        <div style="font-weight:700;font-size:0.65rem;margin-bottom:6px;color:var(--text-heading);border-bottom:1px solid var(--glass-border);padding-bottom:4px">
            Score Breakdown — ${combined}%
        </div>
        <div style="font-size:0.55rem;color:var(--text-secondary);margin-bottom:6px">
            <span style="color:var(--text-muted)">Formula:</span> 50% Relative Strength + 50% Price Action
        </div>
        <div style="display:flex;gap:12px;margin-bottom:8px">
            <div style="flex:1">
                <div style="font-weight:600;font-size:0.55rem;color:var(--text-heading);margin-bottom:4px">
                    Relative Strength: ${rs}%
                </div>
                <div style="font-size:0.5rem;color:var(--text-muted);margin-bottom:2px">
                    Sector return vs Nifty 50 return
                </div>
                <div style="font-size:0.5rem;display:flex;flex-direction:column;gap:2px">
                    <span>Hourly 75m (20% wt): <b style="color:${hrs >= 65 ? '#22c55e' : hrs >= 40 ? '#eab308' : '#ef4444'}">${hrs}%</b></span>
                    <span>Daily (30% wt): <b style="color:${drs >= 65 ? '#22c55e' : drs >= 40 ? '#eab308' : '#ef4444'}">${drs}%</b></span>
                    <span>Weekly (40% wt): <b style="color:${wrs >= 65 ? '#22c55e' : wrs >= 40 ? '#eab308' : '#ef4444'}">${wrs}%</b></span>
                    <span>Monthly (10% wt): <b style="color:${mrs >= 65 ? '#22c55e' : mrs >= 40 ? '#eab308' : '#ef4444'}">${mrs}%</b></span>
                </div>
            </div>
            <div style="flex:1">
                <div style="font-weight:600;font-size:0.55rem;color:var(--text-heading);margin-bottom:4px">
                    Price Action: ${pa}% <span style="color:var(--text-muted);font-weight:400">(${paCount}/5)</span>
                </div>
                <div style="font-size:0.5rem;display:flex;flex-direction:column;gap:2px">
                    ${paChecks.map(c => `<span><span style="color:${checkColor(c.val)}">${check(c.val)}</span> ${c.label}</span>`).join('')}
                </div>
            </div>
        </div>
    `;

    _positionTooltip(tip, event);
}

function hideScoreTooltip() {
    if (_scoreTooltipEl) {
        _scoreTooltipEl.remove();
        _scoreTooltipEl = null;
    }
}

function _positionTooltip(tip, event) {
    document.body.appendChild(tip);
    _scoreTooltipEl = tip;
    const rect = event.target.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - tipRect.width / 2;
    let top = rect.bottom + 8;
    if (left + tipRect.width > window.innerWidth - 10) left = window.innerWidth - tipRect.width - 10;
    if (left < 10) left = 10;
    if (top + tipRect.height > window.innerHeight - 10) top = rect.top - tipRect.height - 8;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
    tip.style.opacity = '1';
}

function getSignalDirection(signalType) {
    if (!signalType) return '';
    const t = String(signalType).toUpperCase();
    if (t.startsWith('CE')) return 'CE';
    if (t.startsWith('PE')) return 'PE';
    return signalType;
}

function isAdvDeclSignal(signalType) {
    return String(signalType || '').toUpperCase().includes('_AD');
}

function showFnoScoreTooltip(event, s) {
    hideScoreTooltip();

    const combined = Math.round((s.current_score || 0) * 100);
    const trend = Math.round((s.trend_score || 0) * 100);
    const consol = Math.round((s.consol_score || 0) * 100);
    const breakout = Math.round((s.breakout_score || 0) * 100);
    const dir = getSignalDirection(s.signal_type);
    const direction = dir === 'CE' ? 'Bullish (CE)' : 
                      dir === 'PE' ? 'Bearish (PE)' : 
                      s.signal_type === 'VCP' ? 'VCP Pattern' :
                      s.signal_type === 'Hybrid-VCP' ? 'Hybrid VCP' :
                      s.signal_type;
    const barColor = v => v >= 70 ? '#22c55e' : v >= 45 ? '#eab308' : '#ef4444';

    const bar = (label, val, weight) => `
        <div style="margin-bottom:6px">
            <div style="display:flex;justify-content:space-between;margin-bottom:2px">
                <span style="color:var(--text-secondary)">${label} <span style="color:var(--text-muted);font-size:0.45rem">(${weight}% wt)</span></span>
                <b style="color:${barColor(val)}">${val}%</b>
            </div>
            <div style="height:4px;border-radius:2px;background:var(--glass-border);overflow:hidden">
                <div style="height:100%;width:${val}%;border-radius:2px;background:${barColor(val)};transition:width 0.3s ease"></div>
            </div>
        </div>`;

    const hasSubs = s.trend_score != null && !isAdvDeclSignal(s.signal_type);

    const tip = document.createElement('div');
    tip.className = 'score-tooltip';
    tip.innerHTML = hasSubs ? `
        <div style="font-weight:700;font-size:0.65rem;margin-bottom:4px;color:var(--text-heading);border-bottom:1px solid var(--glass-border);padding-bottom:4px">
            ${s.symbol} — ${combined}% <span style="font-weight:400;font-size:0.5rem;color:var(--text-muted)">${direction}</span>
        </div>
        <div style="font-size:0.5rem;color:var(--text-muted);margin-bottom:8px">
            ${s.signal_type?.includes('VCP') ? 
                'Formula: Trend + Contraction + Volume + Position' : 
                'Formula: 35% Trend + 35% Consolidation + 30% Breakout Proximity'}
        </div>
        ${bar(s.signal_type?.includes('VCP') ? 'Trend Alignment' : 'Trend Strength', trend, 35)}
        <div style="font-size:0.45rem;color:var(--text-muted);margin-top:-4px;margin-bottom:6px">
            ${s.signal_type?.includes('VCP') ? 
                'Moving average alignment, price above key levels' : 
                'EMA alignment, higher highs/lows, slope'}
        </div>
        ${bar(s.signal_type?.includes('VCP') ? 'Contraction Quality' : 'Consolidation Quality', consol, 35)}
        <div style="font-size:0.45rem;color:var(--text-muted);margin-top:-4px;margin-bottom:6px">
            ${s.signal_type?.includes('VCP') ? 
                'Progressive tightening pattern, volume behavior' : 
                `Tight range at ${dir === 'CE' ? 'highs' : 'lows'}, volume dry-up`}
        </div>
        ${bar(s.signal_type?.includes('VCP') ? 'Volume Pattern' : 'Breakout Proximity', breakout, 30)}
        <div style="font-size:0.45rem;color:var(--text-muted);margin-top:-4px;margin-bottom:4px">
            ${s.signal_type?.includes('VCP') ? 
                'Volume dry-up during contraction, breakout surge potential' : 
                `Distance to consolidation ${dir === 'CE' ? 'ceiling' : 'floor'}`}
        </div>
        <div style="border-top:1px solid var(--glass-border);padding-top:4px;font-size:0.5rem;display:flex;justify-content:space-between">
            <span style="color:var(--text-muted)">Peak: ${Math.round((s.peak_score || 0) * 100)}%</span>
            <span style="color:var(--text-muted)">Detected: ${s.first_detected_date}</span>
        </div>
    ` : isAdvDeclSignal(s.signal_type) ? `
        <div style="font-weight:700;font-size:0.65rem;margin-bottom:4px;color:var(--text-heading)">
            ${s.symbol} — ${combined}% <span style="font-weight:400;font-size:0.5rem;color:var(--text-muted)">${direction}</span>
        </div>
        <div style="font-size:0.5rem;color:var(--text-muted)">
            Adv/Decl momentum setup: breadth + EMA/RSI/ADX/volume + OI boosts.
        </div>
    ` : `
        <div style="font-weight:700;font-size:0.65rem;margin-bottom:4px;color:var(--text-heading)">
            ${s.symbol} — ${combined}% <span style="font-weight:400;font-size:0.5rem;color:var(--text-muted)">${direction}</span>
        </div>
        <div style="font-size:0.5rem;color:var(--text-muted)">
            Run a fresh scan to populate sub-score breakdown.
        </div>
    `;

    _positionTooltip(tip, event);
}

async function loadSectorChart(sectorName) {
    const canvas = document.getElementById('sector-chart');
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = (rect.width - 12) * dpr;
    canvas.height = (rect.height - 12) * dpr;
    canvas.style.width = (rect.width - 12) + 'px';
    canvas.style.height = (rect.height - 12) + 'px';
    ctx.scale(dpr, dpr);

    const cw = rect.width - 12;
    const ch = rect.height - 12;

    ctx.clearRect(0, 0, cw, ch);
    const cs = getComputedStyle(document.documentElement);
    ctx.fillStyle = cs.getPropertyValue('--text-muted').trim();
    ctx.font = '9px sans-serif';
    ctx.fillText('Loading weekly chart...', 10, ch / 2);

    try {
        const response = await fetch(`${API_BASE}/api/settings/sectors/${encodeURIComponent(sectorName)}/chart`);
        const data = await response.json();

        if (!data.candles || !data.candles.length) {
            ctx.clearRect(0, 0, cw, ch);
            ctx.fillText('No chart data', 10, ch / 2);
            return;
        }

        drawWeeklyChart(ctx, cw, ch, data.candles, data.ema20, data.ema50);
    } catch (err) {
        ctx.clearRect(0, 0, cw, ch);
        ctx.fillText('Chart error', 10, ch / 2);
    }
}

function drawWeeklyChart(ctx, w, h, candles, ema20, ema50) {
    const cs = getComputedStyle(document.documentElement);
    const chartBg = cs.getPropertyValue('--chart-bg').trim();
    const chartGrid = cs.getPropertyValue('--chart-grid').trim();
    const chartLabel = cs.getPropertyValue('--chart-label').trim();
    const bullFill = chartBg;

    ctx.clearRect(0, 0, w, h);

    const volH = Math.round(h * 0.1);
    const pad = { top: 6, bottom: 12, left: 2, right: 32 };
    const priceH = h - pad.top - pad.bottom - volH - 4;
    const chartW = w - pad.left - pad.right;

    const recentStart = Math.floor(candles.length * 0.4);
    const recentCandles = candles.slice(recentStart);
    const minPrice = Math.min(...recentCandles.map(c => c.l));
    const maxPrice = Math.max(...recentCandles.map(c => c.h));
    const rawRange = maxPrice - minPrice || 1;
    const pRange = rawRange * 1.15;
    const maxVol = Math.max(...candles.map(c => c.v || 0)) || 1;

    const step = chartW / candles.length;
    const candleW = Math.max(2, step * 0.75);

    const midPrice = (minPrice + maxPrice) / 2;
    const scaledMin = midPrice - pRange / 2;
    const yP = (price) => {
        const y = pad.top + priceH - ((price - scaledMin) / pRange) * priceH;
        return Math.max(pad.top - 2, Math.min(pad.top + priceH + 2, y));
    };
    const xC = (i) => pad.left + i * step + step / 2;
    const volTop = pad.top + priceH + 4;

    ctx.fillStyle = chartBg;
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = chartGrid;
    ctx.lineWidth = 0.5;
    ctx.fillStyle = chartLabel;
    ctx.font = '7px sans-serif';
    ctx.textAlign = 'right';
    const gridSteps = 5;
    for (let i = 0; i <= gridSteps; i++) {
        const price = minPrice + (pRange / gridSteps) * i;
        const y = yP(price);
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(w - pad.right, y);
        ctx.stroke();
        ctx.fillText(price.toFixed(0), w - 3, y + 3);
    }

    for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        const x = xC(i);
        const vH = ((c.v || 0) / maxVol) * volH;
        const bullish = c.c >= c.o;
        ctx.fillStyle = bullish ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)';
        ctx.fillRect(x - candleW / 2, volTop + volH - vH, candleW, vH);
    }

    if (ema50 && ema50.length) {
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i < ema50.length; i++) {
            const x = xC(i);
            const y = yP(ema50[i]);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
    }

    if (ema20 && ema20.length) {
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i < ema20.length; i++) {
            const x = xC(i);
            const y = yP(ema20[i]);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
    }

    for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        const x = xC(i);
        const bullish = c.c >= c.o;
        const bodyTop = yP(Math.max(c.o, c.c));
        const bodyBot = yP(Math.min(c.o, c.c));
        const bodyH = Math.max(0.8, bodyBot - bodyTop);

        ctx.strokeStyle = bullish ? '#22c55e' : '#ef4444';
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        ctx.moveTo(x, yP(c.h));
        ctx.lineTo(x, yP(c.l));
        ctx.stroke();

        if (bullish) {
            ctx.fillStyle = bullFill;
            ctx.fillRect(x - candleW / 2, bodyTop, candleW, bodyH);
            ctx.strokeStyle = '#22c55e';
            ctx.lineWidth = 0.7;
            ctx.strokeRect(x - candleW / 2, bodyTop, candleW, bodyH);
        } else {
            ctx.fillStyle = '#ef4444';
            ctx.fillRect(x - candleW / 2, bodyTop, candleW, bodyH);
        }
    }

    ctx.fillStyle = chartLabel;
    ctx.font = '7px sans-serif';
    ctx.textAlign = 'center';
    const labelInterval = Math.max(1, Math.floor(candles.length / 6));
    for (let i = 0; i < candles.length; i += labelInterval) {
        const d = candles[i].t;
        const parts = d.split('-');
        const months = ['', 'Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const label = months[parseInt(parts[1])] + ' ' + parts[0].slice(2);
        ctx.fillText(label, xC(i), h - 1);
    }

    ctx.font = '7px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#f59e0b';
    ctx.fillText('\u2014 20 EMA', pad.left + 4, pad.top + 8);
    ctx.fillStyle = '#3b82f6';
    ctx.fillText('\u2014 50 EMA', pad.left + 50, pad.top + 8);

    const lastC = candles[candles.length - 1];
    ctx.fillStyle = lastC.c >= lastC.o ? '#22c55e' : '#ef4444';
    ctx.font = 'bold 8px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(lastC.c.toFixed(2), w - 3, yP(lastC.c) - 3);
}

// --- Signals ---

async function loadSignals(section) {
    const statusFilters = getSelectedPills(`${section}-status-filter`);
    const scoreFilters = getSelectedPills(`${section}-score-filter`);
    const containerId = `${section}-signals-table`;

    try {
        const response = await fetch(`${API_BASE}/api/signals/?section=${section}`);
        let signals = await response.json();

        // Apply status filters
        if (statusFilters.length) {
            signals = signals.filter(s => statusFilters.includes(s.status));
        }

        // Apply score filters
        if (scoreFilters.length) {
            signals = signals.filter(s => {
                const scorePercent = (s.current_score * 100);
                return scoreFilters.some(threshold => {
                    const minScore = parseInt(threshold);
                    return scorePercent >= minScore;
                });
            });
        }

        if (!signals.length) {
            const label = statusFilters.length ? statusFilters.join(', ') : 'any';
            document.getElementById(containerId).innerHTML = `
                <div class="p-10 text-center" style="color:var(--text-muted)">
                    <p class="text-sm mb-1">No ${label} signals</p>
                    <p class="text-xs">Try a different status filter or run a scan.</p>
                </div>`;
            return;
        }

        const secIds = signals.map(s => s.security_id);
        let cmpMap = {};
        try {
            const cmpRes = await fetch(`${API_BASE}/api/signals/cmp`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({security_ids: secIds}),
            });
            if (cmpRes.ok) {
                cmpMap = await cmpRes.json();
            } else {
                console.warn('CMP data unavailable (market closed or API issue)');
            }
        } catch (e) { 
            console.warn('Failed to fetch CMP data:', e.message);
        }

        const rows = signals.map(s => {
            const scoreClass = s.current_score >= 0.8 ? 'score-high' :
                               s.current_score >= 0.6 ? 'score-medium' : 'score-low';
            const occBadge = s.occurrence_number > 1
                ? `<span class="occurrence-${Math.min(s.occurrence_number, 3)} text-2xs px-1.5 py-0.5 rounded-full ml-1.5">${ordinal(s.occurrence_number)} time</span>`
                : '';
            
            // F&O indicator badge with lot size tooltip
            const fnoBadge = s.is_fno 
                ? `<span class="text-2xs px-1.5 py-0.5 rounded-full ml-1" style="background:rgba(168,85,247,0.15);color:#a78bfa;border:1px solid rgba(168,85,247,0.3)" title="F&O Available - Lot Size: ${s.lot_size || 'N/A'}">F&O</span>`
                : '';
            
            const statusClass = `status-${s.status}`;
            const cmp = cmpMap[s.security_id];
            const cmpDisplay = cmp ? cmp.toFixed(2) : (s.close_price_at_detection ? s.close_price_at_detection.toFixed(2) : '-');
            const pctChange = (cmp && s.close_price_at_detection)
                ? ((cmp - s.close_price_at_detection) / s.close_price_at_detection * 100).toFixed(1)
                : null;
            const pctClass = pctChange > 0 ? 'text-profit' : pctChange < 0 ? 'text-loss' : '';
            const pctDisplay = pctChange !== null ? `<span class="${pctClass}" style="font-size:0.5rem">${pctChange > 0 ? '+' : ''}${pctChange}%</span>` : '';

            // Tooltip data for score breakdown
            const tipData = JSON.stringify({
                symbol: s.symbol, 
                signal_type: s.signal_type || 'VCP', 
                current_score: s.current_score,
                peak_score: s.peak_score, 
                trend_score: s.trend_score, 
                consol_score: s.consol_score,
                breakout_score: s.breakout_score, 
                first_detected_date: s.first_detected_date,
            }).replace(/"/g, '&quot;');

            return `<tr class="cursor-pointer" onclick="viewSignalDetail(${s.id})">
                <td class="font-medium" style="color:var(--text-primary)">${s.symbol}${occBadge}${fnoBadge}</td>
                <td>${s.sector || '-'}</td>
                <td><span class="${scoreClass} text-2xs px-1.5 py-0.5 rounded-full score-tooltip-trigger"
                    onmouseenter="showFnoScoreTooltip(event, ${tipData})"
                    onmouseleave="hideScoreTooltip()"
                    >${(s.current_score * 100).toFixed(0)}%</span></td>
                <td>${s.close_price_at_detection || '-'}</td>
                <td>${cmpDisplay} ${pctDisplay}</td>
                <td>${s.first_detected_date}</td>
                <td>${daysSince(s.first_detected_date)}d</td>
                <td><span class="${statusClass} text-2xs px-1.5 py-0.5 rounded-full">${s.status}</span></td>
                <td>
                    ${s.status === 'active' ? `<button onclick="event.stopPropagation(); dismissSignal(${s.id})" class="text-2xs hover:text-red-400" style="color:var(--text-muted)">Dismiss</button>` : ''}
                </td>
            </tr>`;
        }).join('');

        document.getElementById(containerId).innerHTML = `
            <table class="data-table">
                <thead><tr>
                    <th>Symbol</th><th>Sector</th><th>Score</th>
                    <th>Entry Price</th><th>CMP</th><th>Detected</th><th>Days</th><th>Status</th><th></th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table>`;
        applySortable(containerId);
        
        // Update last refreshed time for swing trades
        if (section === 'swing') {
            const lastUpdatedEl = document.getElementById('swing-last-updated');
            if (lastUpdatedEl) {
                const now = new Date();
                const totalSignals = signals.length;
                const displayedSignals = rows.length;
                lastUpdatedEl.textContent = `${displayedSignals} of ${totalSignals} signals • Updated: ${now.toLocaleTimeString()}`;
            }
        }
    } catch (err) {
        console.error('Error loading signals:', err);
    }
}

async function dismissSignal(id) {
    if (!confirm('Dismiss this signal?')) return;
    await fetch(`${API_BASE}/api/signals/${id}/dismiss`, { method: 'POST' });
    const activeTab = document.querySelector('.nav-item.active')?.id?.replace('tab-', '');
    if (activeTab === 'swing') loadSignals('swing');
    if (activeTab === 'fno') loadFnoSignals();
}

async function reactivateSignal(id) {
    await fetch(`${API_BASE}/api/signals/${id}/reactivate`, { method: 'POST' });
    const activeTab = document.querySelector('.nav-item.active')?.id?.replace('tab-', '');
    if (activeTab === 'swing') loadSignals('swing');
    if (activeTab === 'fno') loadFnoSignals();
}

let _currentAnalysisSignalId = null;
let _advisoryAutoRefresh = null;

let _lastAnalysisExpiries = null;
let _lastAnalysisExpiry = null;

let _expiryScoresCache = {};
let _expiryScoreSignalId = null;

async function viewSignalDetail(id, expiry) {
    _currentAnalysisSignalId = id;
    _lastAnalysisExpiry = expiry || null;
    const panel = document.getElementById('option-analysis-panel');
    const loading = document.getElementById('analysis-loading');
    const error = document.getElementById('analysis-error');
    const content = document.getElementById('analysis-content');
    const title = document.getElementById('analysis-title');

    // Clear cache when opening a different stock
    if (_expiryScoreSignalId !== id) {
        _expiryScoresCache = {};
        _expiryScoreSignalId = id;
    }

    panel.classList.remove('hidden');
    loading.classList.remove('hidden');
    error.classList.add('hidden');
    content.classList.add('hidden');

    try {
        let url = `${API_BASE}/api/signals/${id}/option-analysis`;
        if (expiry) url += `?expiry=${expiry}`;
        const res = await fetch(url);
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            if (err.available_expiries) _lastAnalysisExpiries = err.available_expiries;
            throw new Error(err.detail || `Analysis failed (${res.status})`);
        }
        const data = await res.json();
        _lastAnalysisExpiries = data.available_expiries;
        _lastAnalysisExpiry = data.expiry;

        // Seed current expiry's conviction from analysis data we already have
        if (data.recommendation && data.recommendation.conviction) {
            _expiryScoresCache[data.expiry] = {
                conviction: data.recommendation.conviction.toLowerCase(),
                reason: data.recommendation.conviction_reason || '',
                best_score: data.recommendation.score || 0,
                best_spread: data.recommendation.spread_pct || 0,
            };
        }

        loading.classList.add('hidden');
        content.classList.remove('hidden');
        title.textContent = `${data.signal.symbol} — ${data.side} Option Analysis`;
        renderAnalysisPanel(data);

        // Fetch remaining expiry scores in background (only on first load)
        if (!expiry) {
            _fetchExpiryScores(id);
        }
    } catch (e) {
        loading.classList.add('hidden');
        error.classList.remove('hidden');
        let errorHtml = `<p class="text-xs" style="color:#f87171;margin-bottom:12px">${e.message}</p>`;
        if (_lastAnalysisExpiries && _lastAnalysisExpiries.length) {
            const pills = _lastAnalysisExpiries.map(ex => {
                const cached = _expiryScoresCache[ex.date];
                let dotHtml = '';
                if (cached && cached.conviction !== 'none') {
                    const c = cached.conviction === 'high' ? '#22c55e' : cached.conviction === 'medium' ? '#eab308' : '#ef4444';
                    dotHtml = `<span class="expiry-dot" style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${c};margin-left:4px;vertical-align:middle" title="${cached.reason || ''}"></span>`;
                }
                return `<button class="filter-pill" data-expiry-pill="${ex.date}" onclick="switchExpiry('${ex.date}')"
                    style="font-size:0.55rem;padding:3px 8px">${ex.date.slice(5)} (${ex.dte}d)${dotHtml}</button>`;
            }).join('');
            errorHtml += `<div style="margin-top:10px">
                <p style="font-size:0.6rem;color:var(--text-secondary);margin-bottom:6px">Try a different expiry:</p>
                <div class="filter-pills" style="flex-wrap:wrap;gap:4px;justify-content:center">${pills}</div>
            </div>`;
        }
        document.getElementById('analysis-error').innerHTML = errorHtml;
    }
}

async function _fetchExpiryScores(signalId) {
    // Show loading spinners on pills that don't have dots yet
    document.querySelectorAll('[data-expiry-pill]').forEach(btn => {
        if (!btn.querySelector('.expiry-dot')) {
            const spinner = document.createElement('span');
            spinner.className = 'expiry-dot-loading';
            spinner.style.cssText = 'display:inline-block;width:6px;height:6px;border-radius:50%;border:1px solid rgba(255,255,255,0.3);border-top-color:rgba(255,255,255,0.8);margin-left:4px;vertical-align:middle;animation:expiry-spin 0.8s linear infinite';
            btn.appendChild(spinner);
        }
    });

    try {
        const resp = await fetch(`${API_BASE}/api/signals/${signalId}/expiry-scores`);
        if (!resp.ok) return;
        const data = await resp.json();
        const scores = data.scores || {};
        // Merge with existing cache (don't overwrite current expiry seeded from analysis)
        for (const [k, v] of Object.entries(scores)) {
            _expiryScoresCache[k] = v;
        }
        _applyExpiryDots();
    } catch (e) {
        // Remove spinners on failure
        document.querySelectorAll('.expiry-dot-loading').forEach(s => s.remove());
    }
}

function _applyExpiryDots() {
    document.querySelectorAll('[data-expiry-pill]').forEach(btn => {
        const expDate = btn.getAttribute('data-expiry-pill');
        const scoreData = _expiryScoresCache[expDate];

        // Remove any existing dot or spinner
        btn.querySelectorAll('.expiry-dot, .expiry-dot-loading').forEach(el => el.remove());

        if (!scoreData || scoreData.conviction === 'none') return;

        const dotColor = scoreData.conviction === 'high' ? '#22c55e' : scoreData.conviction === 'medium' ? '#eab308' : '#ef4444';
        const dot = document.createElement('span');
        dot.className = 'expiry-dot';
        dot.style.cssText = `display:inline-block;width:6px;height:6px;border-radius:50%;background:${dotColor};margin-left:4px;vertical-align:middle;`;
        dot.title = scoreData.reason || '';
        btn.appendChild(dot);
    });
}

function switchExpiry(expiry) {
    if (_currentAnalysisSignalId) {
        viewSignalDetail(_currentAnalysisSignalId, expiry);
    }
}

function closeAnalysisPanel() {
    if (_advisoryAutoRefresh) {
        clearInterval(_advisoryAutoRefresh);
        _advisoryAutoRefresh = null;
    }
    document.getElementById('option-analysis-panel').classList.add('hidden');
    _currentAnalysisSignalId = null;
}

function renderAnalysisPanel(data) {
    _tradeAnalysisData = data;
    const r = data.recommendation;
    const s = data.signal;
    const fmt = n => new Intl.NumberFormat('en-IN').format(n);
    const fmtR = n => new Intl.NumberFormat('en-IN').format(Math.round(n));
    const pct = n => n != null ? n.toFixed(2) : '-';
    const dirLabel = data.side === 'CE' ? 'Bullish' : 'Bearish';
    const dirColor = data.side === 'CE' ? '#4ade80' : '#f87171';

    const greekCards = [
        { label: 'Delta', value: pct(r.delta), desc: `₹${fmtR(Math.abs(r.delta || 0) * data.lot_size)} per ₹1 move`, color: '#a5b4fc' },
        { label: 'Gamma', value: r.gamma ? r.gamma.toFixed(4) : '-', desc: 'Rate of delta change', color: '#c4b5fd' },
        { label: 'Theta', value: pct(r.theta), desc: `₹${fmtR(r.theta_daily_cost)}/day decay`, color: '#fdba74' },
        { label: 'Vega', value: pct(r.vega), desc: `₹${fmtR(Math.abs(r.vega || 0) * data.lot_size)} per 1% IV`, color: '#67e8f9' },
    ];

    const strikeRows = data.strikes.map(st => {
        const isRec = st.strike === r.strike;
        const isAtm = st.strike === data.atm_strike;
        const rowBg = isRec ? 'background:rgba(99,102,241,0.15);' : isAtm ? 'background:rgba(234,179,8,0.08);' : '';
        const badge = isRec ? '<span style="color:#a5b4fc;font-size:0.6rem;margin-left:4px;font-weight:700">★ REC</span>' :
                      isAtm ? '<span style="color:#fbbf24;font-size:0.6rem;margin-left:4px">ATM</span>' : '';
        const deltaColor = Math.abs(st.delta || 0) >= 0.4 && Math.abs(st.delta || 0) <= 0.6 ? '#4ade80' : 'var(--text-secondary)';
        return `<tr style="${rowBg}cursor:default">
            <td style="font-weight:${isRec ? '700' : '500'};color:var(--text-primary)">${st.strike}${badge}</td>
            <td style="color:var(--text-primary)">${st.premium}</td>
            <td style="color:var(--text-primary)">${fmtR(st.lot_cost)}</td>
            <td style="color:${deltaColor};font-weight:600">${st.delta != null ? st.delta.toFixed(3) : '-'}</td>
            <td style="color:var(--text-secondary)">${st.theta != null ? st.theta.toFixed(2) : '-'}</td>
            <td style="color:var(--text-secondary)">${st.iv != null ? st.iv.toFixed(1) + '%' : '-'}</td>
            <td style="color:var(--text-secondary)">${fmt(st.oi)}</td>
            <td style="color:var(--text-secondary)">${fmt(st.volume)}</td>
            <td style="color:var(--text-secondary)">${st.spread_pct.toFixed(1)}%</td>
        </tr>`;
    }).join('');

    const expiryPills = (data.available_expiries || []).map(e => {
        const isActive = e.date === data.expiry;
        const label = `${e.date.slice(5)} (${e.dte}d)`;
        const cached = _expiryScoresCache[e.date];
        let dotHtml = '';
        if (cached && cached.conviction !== 'none') {
            const c = cached.conviction === 'high' ? '#22c55e' : cached.conviction === 'medium' ? '#eab308' : '#ef4444';
            dotHtml = `<span class="expiry-dot" style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${c};margin-left:4px;vertical-align:middle" title="${cached.reason || ''}"></span>`;
        }
        return `<button class="filter-pill${isActive ? ' active' : ''}" data-expiry-pill="${e.date}" onclick="switchExpiry('${e.date}')"
            style="font-size:0.55rem;padding:3px 8px">${label}${dotHtml}</button>`;
    }).join('');

    const warnings = (data.liquidity_warnings || []).map(w => {
        const icon = w.level === 'high' ? '🔴' : w.level === 'medium' ? '🟡' : '💡';
        const bg = w.level === 'high' ? 'rgba(239,68,68,0.1)' : w.level === 'medium' ? 'rgba(234,179,8,0.1)' : 'rgba(99,102,241,0.08)';
        const color = w.level === 'high' ? '#fca5a5' : w.level === 'medium' ? '#fde68a' : '#c7d2fe';
        return `<div style="padding:6px 10px;border-radius:6px;background:${bg};font-size:0.6rem;color:${color};display:flex;align-items:center;gap:6px">
            <span>${icon}</span>${w.message}
        </div>`;
    }).join('');

    document.getElementById('analysis-content').innerHTML = `
        <!-- Expiry Selector -->
        <div style="margin-bottom:12px">
            <div style="font-size:0.6rem;color:var(--text-secondary);margin-bottom:5px">Expiry</div>
            <div class="filter-pills" style="flex-wrap:wrap;gap:4px">${expiryPills}</div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
            <div class="glass-card-sm" style="padding:14px">
                <div style="font-size:0.65rem;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px">Spot Price</div>
                <div style="font-size:1.3rem;font-weight:700;color:var(--text-heading)">${data.spot_price.toFixed(2)}</div>
                <div style="font-size:0.6rem;color:var(--text-secondary);margin-top:2px">Detected at: ${s.detected_at || '-'}</div>
            </div>
            <div class="glass-card-sm" style="padding:14px">
                <div style="font-size:0.65rem;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px">Direction</div>
                <div style="font-size:1.3rem;font-weight:700;color:${dirColor}">${dirLabel} ${data.side}</div>
                <div style="font-size:0.6rem;color:var(--text-secondary);margin-top:2px">Signal score: ${Math.round(s.score * 100)}%</div>
            </div>
        </div>

        ${warnings ? `<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px">${warnings}</div>` : ''}

        <!-- Conviction Banner -->
        <div style="padding:10px 14px;border-radius:8px;margin-bottom:14px;display:flex;align-items:center;gap:10px;background:${r.conviction === 'High' ? 'rgba(34,197,94,0.1)' : r.conviction === 'Medium' ? 'rgba(234,179,8,0.1)' : 'rgba(239,68,68,0.1)'}">
            <span style="font-size:1rem">${r.conviction === 'High' ? '🟢' : r.conviction === 'Medium' ? '🟡' : '🔴'}</span>
            <div>
                <div style="font-size:0.7rem;font-weight:700;color:${r.conviction === 'High' ? '#4ade80' : r.conviction === 'Medium' ? '#fbbf24' : '#f87171'}">${r.conviction} Conviction</div>
                <div style="font-size:0.55rem;color:var(--text-secondary)">${r.conviction_reason}</div>
            </div>
        </div>

        <!-- Recommended Strike -->
        <div class="glass-card-sm" style="padding:16px;margin-bottom:16px;border-left:3px solid #818cf8">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
                <div>
                    <div style="font-size:0.8rem;font-weight:700;color:var(--text-heading)">★ Recommended: ${r.strike} ${data.side}</div>
                    <div style="font-size:0.6rem;color:var(--text-secondary);margin-top:3px">
                        ${r.moneyness > 0 ? r.moneyness.toFixed(1) + '% OTM' : r.moneyness < -1 ? Math.abs(r.moneyness).toFixed(1) + '% ITM' : 'ATM'}
                        &nbsp;·&nbsp; Expiry: ${data.expiry} (${data.dte}d) &nbsp;·&nbsp; IV: ${r.iv ? r.iv.toFixed(1) + '%' : '-'}
                    </div>
                </div>
                <div style="text-align:right">
                    <div style="font-size:1.1rem;font-weight:700;color:var(--text-heading)">₹${fmtR(r.lot_cost)}</div>
                    <div style="font-size:0.6rem;color:var(--text-secondary)">${data.lot_size} × ₹${r.premium}</div>
                </div>
            </div>

            <!-- Buy Range -->
            <div style="padding:8px 12px;border-radius:8px;background:rgba(99,102,241,0.08);margin-bottom:12px;display:flex;align-items:center;justify-content:space-between">
                <div>
                    <div style="font-size:0.55rem;color:#c7d2fe;text-transform:uppercase;letter-spacing:0.05em">Buy Range</div>
                    <div style="font-size:0.85rem;font-weight:700;color:#a5b4fc">${r.buy_range}</div>
                </div>
                <div style="font-size:0.55rem;color:var(--text-secondary);text-align:right;max-width:55%">
                    Place limit order in this range. Don't chase if premium runs above ₹${r.buy_range_high}
                </div>
            </div>

            <!-- Target / SL / Hold -->
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:10px">
                <div style="text-align:center;padding:10px 8px;border-radius:8px;background:rgba(34,197,94,0.1)">
                    <div style="font-size:0.6rem;color:#86efac;margin-bottom:3px">Target (Stock)</div>
                    <div style="font-size:0.85rem;font-weight:700;color:#4ade80">${r.target_stock_price}</div>
                    <div style="font-size:0.55rem;color:#86efac;margin-top:3px">Premium → ₹${r.target_premium}</div>
                </div>
                <div style="text-align:center;padding:10px 8px;border-radius:8px;background:rgba(239,68,68,0.1)">
                    <div style="font-size:0.6rem;color:#fca5a5;margin-bottom:3px">Stop Loss (Stock)</div>
                    <div style="font-size:0.85rem;font-weight:700;color:#f87171">${r.sl_stock_price}</div>
                    <div style="font-size:0.55rem;color:#fca5a5;margin-top:3px">Premium → ₹${r.sl_premium}</div>
                </div>
                <div style="text-align:center;padding:10px 8px;border-radius:8px;background:rgba(99,102,241,0.1)">
                    <div style="font-size:0.6rem;color:#c7d2fe;margin-bottom:3px">Hold Duration</div>
                    <div style="font-size:0.85rem;font-weight:700;color:#a5b4fc">${r.hold_days} days</div>
                    <div style="font-size:0.55rem;color:#c7d2fe;margin-top:3px">DTE: ${data.dte}d</div>
                </div>
            </div>

            <!-- SL Reason -->
            <div style="padding:6px 10px;border-radius:6px;background:rgba(239,68,68,0.06);font-size:0.55rem;color:#fca5a5;margin-bottom:10px">
                <span style="font-weight:600">SL basis:</span> ${r.sl_reason || 'Technical support level'}
            </div>

            <!-- Partial Booking -->
            ${r.partial_book_at ? `
            <div style="padding:6px 10px;border-radius:6px;background:rgba(234,179,8,0.08);font-size:0.55rem;color:#fde68a;margin-bottom:10px">
                <span style="font-weight:600">📊 Partial profit:</span> Book 50% at stock ₹${r.partial_book_at} (premium ~₹${r.partial_book_premium}), trail SL to cost for rest
            </div>` : ''}

            <!-- P&L Summary -->
            ${r.lot_size_warning ? `
            <div style="padding:8px 10px;border-radius:6px;background:rgba(234,179,8,0.12);font-size:0.55rem;color:#fde68a;margin-bottom:10px;border:1px solid rgba(234,179,8,0.25)">
                <strong>Lot size not loaded</strong> (F&O lot in DB is 1). Run <strong>Refresh Instruments</strong> so Max P&L/Loss use the correct NSE lot. Below: per-lot using qty × ${data.lot_size}; per-unit premium is ₹${r.max_profit_per_unit != null ? r.max_profit_per_unit.toFixed(2) : '-'} / ₹${r.max_loss_per_unit != null ? r.max_loss_per_unit.toFixed(2) : '-'}.
            </div>` : ''}
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;border-top:1px solid var(--glass-border);padding-top:10px">
                <div style="text-align:center">
                    <div style="font-size:0.6rem;color:var(--text-secondary);margin-bottom:2px">Max Profit</div>
                    <div style="font-size:0.8rem;font-weight:700;color:#4ade80">₹${fmtR(r.max_profit)}</div>
                    <div style="font-size:0.45rem;color:var(--text-secondary);margin-top:2px">1 lot (${data.lot_size} qty)</div>
                </div>
                <div style="text-align:center">
                    <div style="font-size:0.6rem;color:var(--text-secondary);margin-bottom:2px">Max Loss</div>
                    <div style="font-size:0.8rem;font-weight:700;color:#f87171">₹${fmtR(r.max_loss)}</div>
                    <div style="font-size:0.45rem;color:var(--text-secondary);margin-top:2px">1 lot (${data.lot_size} qty)</div>
                </div>
                <div style="text-align:center">
                    <div style="font-size:0.6rem;color:var(--text-secondary);margin-bottom:2px">Risk:Reward</div>
                    <div style="font-size:0.8rem;font-weight:700;color:${r.risk_reward >= 2 ? '#4ade80' : r.risk_reward >= 1.5 ? '#fbbf24' : '#f87171'}">1:${r.risk_reward}</div>
                </div>
            </div>
        </div>

        <!-- Place Trade / Active Position -->
        ${data.active_trade ? `
        <div class="glass-card-sm" style="padding:16px;margin-bottom:16px;border-left:3px solid #22c55e" id="trade-section">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
                <div style="font-size:0.8rem;font-weight:700;color:#4ade80">Position Open</div>
                <div style="display:flex;align-items:center;gap:8px">
                    <div style="font-size:0.5rem;color:var(--text-secondary)">Since ${data.active_trade.entry_date}</div>
                    <button onclick="_cancelTrade(${data.active_trade.id}, ${s.id})"
                        style="padding:3px 8px;border-radius:4px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);color:#f87171;font-size:0.5rem;cursor:pointer">
                        Cancel Trade
                    </button>
                </div>
            </div>
            <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px">
                <div style="text-align:center;padding:8px;border-radius:6px;background:var(--glass-bg)">
                    <div style="font-size:0.45rem;color:var(--text-secondary)">Strike</div>
                    <div style="font-size:0.75rem;font-weight:700;color:var(--text-heading)">${data.active_trade.strike} ${data.active_trade.side}</div>
                </div>
                <div style="text-align:center;padding:8px;border-radius:6px;background:var(--glass-bg)">
                    <div style="font-size:0.45rem;color:var(--text-secondary)">Entry</div>
                    <div style="font-size:0.75rem;font-weight:700;color:var(--text-heading)">₹${data.active_trade.entry_premium}</div>
                </div>
                <div style="text-align:center;padding:8px;border-radius:6px;background:rgba(239,68,68,0.06)">
                    <div style="font-size:0.45rem;color:#fca5a5">SL</div>
                    <div style="font-size:0.75rem;font-weight:700;color:#f87171">₹${data.active_trade.sl_price}</div>
                </div>
                <div style="text-align:center;padding:8px;border-radius:6px;background:rgba(34,197,94,0.06)">
                    <div style="font-size:0.45rem;color:#86efac">Target</div>
                    <div style="font-size:0.75rem;font-weight:700;color:#4ade80">₹${data.active_trade.target_price}</div>
                </div>
            </div>
        </div>
        ` : `
        <div class="glass-card-sm" style="padding:16px;margin-bottom:16px;border-left:3px solid #22c55e" id="trade-section">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
                <div style="font-size:0.8rem;font-weight:700;color:var(--text-heading)">Execute Trade</div>
                <div style="font-size:0.5rem;color:var(--text-secondary)">LIMIT Buy + SL + Target</div>
            </div>

            <div id="trade-form-area">
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:10px">
                    <div>
                        <label style="font-size:0.5rem;color:var(--text-secondary);display:block;margin-bottom:3px">Lots</label>
                        <div style="display:flex;align-items:center;gap:4px">
                            <button onclick="_adjustLots(-1)" style="width:24px;height:24px;border-radius:4px;background:var(--glass-bg);border:1px solid var(--glass-border);color:var(--text-primary);font-size:0.7rem;cursor:pointer;display:flex;align-items:center;justify-content:center">−</button>
                            <input type="number" id="trade-lots" value="1" min="1" max="50" oninput="_updateTotalCost()"
                                style="width:40px;text-align:center;padding:4px;border-radius:4px;border:1px solid var(--glass-border);background:var(--glass-bg);color:var(--text-primary);font-size:0.75rem;font-weight:700" />
                            <button onclick="_adjustLots(1)" style="width:24px;height:24px;border-radius:4px;background:var(--glass-bg);border:1px solid var(--glass-border);color:var(--text-primary);font-size:0.7rem;cursor:pointer;display:flex;align-items:center;justify-content:center">+</button>
                        </div>
                    </div>
                    <div>
                        <label style="font-size:0.5rem;color:var(--text-secondary);display:block;margin-bottom:3px">Limit Price</label>
                        <input type="number" step="0.05" id="trade-limit-price" value="${r.premium}" oninput="_updateTotalCost()"
                            style="width:100%;padding:4px 6px;border-radius:4px;border:1px solid var(--glass-border);background:var(--glass-bg);color:var(--text-primary);font-size:0.75rem" />
                    </div>
                    <div>
                        <label style="font-size:0.5rem;color:var(--text-secondary);display:block;margin-bottom:3px">Total Cost</label>
                        <div id="trade-total-cost" style="font-size:0.85rem;font-weight:700;color:var(--text-heading);padding-top:4px">₹${fmtR(r.lot_cost)}</div>
                    </div>
                </div>

                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">
                    <div style="padding:6px 8px;border-radius:6px;background:rgba(239,68,68,0.06)">
                        <div style="font-size:0.5rem;color:#fca5a5">SL Premium (GTT)</div>
                        <div style="font-size:0.7rem;font-weight:600;color:#f87171">₹${r.sl_premium}</div>
                        <div style="font-size:0.45rem;color:var(--text-secondary)">Triggers auto SELL</div>
                    </div>
                    <div style="padding:6px 8px;border-radius:6px;background:rgba(34,197,94,0.06)">
                        <div style="font-size:0.5rem;color:#86efac">Target Premium (GTT)</div>
                        <div style="font-size:0.7rem;font-weight:600;color:#4ade80">₹${r.target_premium}</div>
                        <div style="font-size:0.45rem;color:var(--text-secondary)">Triggers auto SELL</div>
                    </div>
                </div>

                <button id="trade-buy-btn" onclick="_confirmTrade(${s.id}, '${r.option_security_id || ''}', ${r.strike}, '${data.side}', '${data.expiry}', ${data.lot_size}, ${r.sl_premium}, ${r.target_premium})"
                    ${isAdminUser() ? '' : 'disabled'}
                    style="width:100%;padding:10px;border-radius:8px;background:linear-gradient(135deg,#22c55e,#16a34a);color:#fff;font-weight:800;font-size:0.75rem;border:none;cursor:${isAdminUser() ? 'pointer' : 'not-allowed'};opacity:${isAdminUser() ? '1' : '0.55'};letter-spacing:0.03em;transition:all 0.15s"
                    onmouseover="this.style.transform='scale(1.01)'" onmouseout="this.style.transform='scale(1)'">
                    BUY ${r.strike} ${data.side} — ₹${fmtR(r.lot_cost)}
                </button>
                <div style="font-size:0.45rem;color:var(--text-secondary);text-align:center;margin-top:4px">
                    ${isAdminUser() ? 'Limit order • SL & Target auto-placed as GTT • AMO if market closed' : 'Readonly mode: order placement disabled'}
                </div>
            </div>
            <div id="trade-result-area" style="display:none"></div>
        </div>
        `}

        <!-- Technicals -->
        ${data.technicals ? `
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px">
            <div class="glass-card-sm" style="padding:8px;text-align:center">
                <div style="font-size:0.5rem;color:var(--text-secondary)">ATR (14)</div>
                <div style="font-size:0.75rem;font-weight:700;color:var(--text-heading)">${data.technicals.atr}</div>
            </div>
            <div class="glass-card-sm" style="padding:8px;text-align:center">
                <div style="font-size:0.5rem;color:var(--text-secondary)">Support</div>
                <div style="font-size:0.75rem;font-weight:700;color:#4ade80">${data.technicals.support}</div>
            </div>
            <div class="glass-card-sm" style="padding:8px;text-align:center">
                <div style="font-size:0.5rem;color:var(--text-secondary)">Resistance</div>
                <div style="font-size:0.75rem;font-weight:700;color:#f87171">${data.technicals.resistance}</div>
            </div>
            <div class="glass-card-sm" style="padding:8px;text-align:center">
                <div style="font-size:0.5rem;color:var(--text-secondary)">20d Range</div>
                <div style="font-size:0.65rem;font-weight:600;color:var(--text-heading)">${data.technicals.swing_low} – ${data.technicals.swing_high}</div>
            </div>
        </div>` : ''}

        <!-- Greeks -->
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px">
            ${greekCards.map(g => `
                <div class="glass-card-sm" style="padding:12px;text-align:center">
                    <div style="font-size:0.6rem;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px">${g.label}</div>
                    <div style="font-size:1rem;font-weight:700;color:${g.color}">${g.value}</div>
                    <div style="font-size:0.55rem;color:var(--text-secondary);margin-top:4px">${g.desc}</div>
                </div>
            `).join('')}
        </div>

        <!-- Live Advisory -->
        <div class="glass-card-sm" style="padding:16px;margin-bottom:16px;border-left:3px solid #fbbf24">
            <div style="font-size:0.8rem;font-weight:700;color:var(--text-heading);margin-bottom:10px">⚡ Live Advisory</div>
            ${data.active_trade ? `
                <div style="padding:8px 10px;border-radius:6px;background:rgba(34,197,94,0.08);margin-bottom:10px;display:flex;align-items:center;justify-content:space-between">
                    <div>
                        <div style="font-size:0.55rem;color:#86efac">Active Position</div>
                        <div style="font-size:0.7rem;font-weight:700;color:#4ade80">${data.active_trade.strike} ${data.active_trade.side} × ${data.active_trade.lots} lot(s) @ ₹${data.active_trade.entry_premium}</div>
                        <div style="font-size:0.45rem;color:var(--text-secondary)">Entered ${data.active_trade.entry_date} · SL: ₹${data.active_trade.sl_price} · Target: ₹${data.active_trade.target_price}</div>
                    </div>
                </div>
            ` : `
                <div style="font-size:0.55rem;color:var(--text-secondary);margin-bottom:10px">Already entered this trade? Get real-time HOLD / EXIT / BOOK PROFIT advice</div>
            `}
            <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap" id="live-advisory-inputs">
                <div style="flex:1;min-width:80px">
                    <label style="font-size:0.55rem;color:var(--text-secondary);display:block;margin-bottom:3px">Your Entry Premium</label>
                    <input type="number" step="0.05" id="entry-premium-input"
                        value="${data.active_trade ? data.active_trade.entry_premium : ''}"
                        placeholder="e.g. ${r.premium}"
                        style="width:100%;padding:6px 8px;border-radius:6px;border:1px solid var(--glass-border);background:var(--glass-bg);color:var(--text-primary);font-size:0.75rem;outline:none" />
                </div>
                <button onclick="fetchLiveAdvisory(${s.id}, ${data.active_trade ? data.active_trade.strike : r.strike}, '${data.active_trade ? data.active_trade.side : data.side}', '${data.active_trade ? data.active_trade.expiry : data.expiry}')"
                    style="padding:6px 14px;border-radius:6px;background:linear-gradient(135deg,#f59e0b,#d97706);color:#000;font-weight:700;font-size:0.65rem;border:none;cursor:pointer;white-space:nowrap">
                    Check Now
                </button>
            </div>
            <div id="live-advisory-result" style="margin-top:12px"></div>
        </div>

        <!-- Strike Chain Table -->
        <div style="margin-bottom:12px">
            <div style="font-size:0.75rem;font-weight:600;color:var(--text-heading);margin-bottom:8px">
                Strike Chain <span style="font-size:0.6rem;color:var(--text-secondary);font-weight:400">(±12% from spot)</span>
            </div>
            <div style="overflow-x:auto">
                <table class="data-table" style="font-size:0.6rem">
                    <thead><tr>
                        <th>Strike</th><th>Premium</th><th>Lot Cost</th>
                        <th>Delta</th><th>Theta</th><th>IV</th>
                        <th>OI</th><th>Volume</th><th>Spread</th>
                    </tr></thead>
                    <tbody>${strikeRows}</tbody>
                </table>
            </div>
        </div>
    `;

    // Auto-trigger live advisory if there's an active trade
    if (data.active_trade) {
        setTimeout(() => {
            fetchLiveAdvisory(
                data.signal.id,
                data.active_trade.strike,
                data.active_trade.side,
                data.active_trade.expiry
            );
        }, 300);
    }
}

// --- Live Advisory ---

async function fetchLiveAdvisory(signalId, strike, side, expiry) {
    const input = document.getElementById('entry-premium-input');
    const resultDiv = document.getElementById('live-advisory-result');
    const entryPremium = parseFloat(input?.value);

    if (!entryPremium || entryPremium <= 0) {
        resultDiv.innerHTML = '<div style="color:#fca5a5;font-size:0.6rem">Enter your entry premium above</div>';
        return;
    }

    resultDiv.innerHTML = '<div style="color:var(--text-secondary);font-size:0.6rem">Fetching live data...</div>';

    try {
        const params = new URLSearchParams({ entry_premium: entryPremium, strike, side, expiry });
        const resp = await fetch(`${API_BASE}/api/signals/${signalId}/live-advisory?${params}`);
        if (!resp.ok) throw new Error(await resp.text());
        const d = await resp.json();

        if (d.market_closed) {
            resultDiv.innerHTML = `
                <div style="padding:10px;border-radius:8px;background:rgba(99,102,241,0.08);text-align:center">
                    <div style="font-size:0.7rem;font-weight:600;color:#a5b4fc;margin-bottom:4px">Market Closed</div>
                    <div style="font-size:0.55rem;color:var(--text-secondary)">${d.message}</div>
                    <div style="font-size:0.5rem;color:var(--text-secondary);margin-top:6px">Position: ${d.strike} ${d.side} · Entry: ₹${d.entry_premium} · DTE: ${d.dte}d</div>
                    <div style="font-size:0.5rem;color:var(--text-secondary);margin-top:6px">Use <strong>Exit Now</strong> during market hours to close position + cancel GTTs in one click</div>
                </div>`;
            return;
        }

        const pnlColor = d.pnl_pct >= 0 ? '#4ade80' : '#f87171';
        const pnlSign = d.pnl_pct >= 0 ? '+' : '';
        const urgencyBg = d.urgency === 'high' ? 'rgba(239,68,68,0.15)' : d.urgency === 'medium' ? 'rgba(234,179,8,0.12)' : 'rgba(34,197,94,0.08)';
        const urgencyBorder = d.urgency === 'high' ? '#f87171' : d.urgency === 'medium' ? '#fbbf24' : '#4ade80';
        const actionIcon = d.action.includes('EXIT') ? '🔴' : d.action.includes('BOOK') ? '🟡' : '🟢';
        const fmt = n => new Intl.NumberFormat('en-IN').format(Math.round(n));

        resultDiv.innerHTML = `
            <!-- Action Banner -->
            <div style="padding:12px;border-radius:8px;background:${urgencyBg};border-left:3px solid ${urgencyBorder};margin-bottom:10px">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
                    <span style="font-size:1.1rem">${actionIcon}</span>
                    <span style="font-size:0.85rem;font-weight:800;color:${urgencyBorder}">${d.action}</span>
                </div>
                ${d.reasons.map(r => `<div style="font-size:0.6rem;color:var(--text-primary);padding:2px 0;padding-left:28px">• ${r}</div>`).join('')}
            </div>

            <!-- Live Numbers -->
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:10px">
                <div style="text-align:center;padding:8px;border-radius:8px;background:var(--glass-bg)">
                    <div style="font-size:0.5rem;color:var(--text-secondary)">Current Premium</div>
                    <div style="font-size:0.85rem;font-weight:700;color:var(--text-heading)">₹${d.current_premium}</div>
                </div>
                <div style="text-align:center;padding:8px;border-radius:8px;background:var(--glass-bg)">
                    <div style="font-size:0.5rem;color:var(--text-secondary)">P&L / Lot</div>
                    <div style="font-size:0.85rem;font-weight:700;color:${pnlColor}">${pnlSign}₹${fmt(d.pnl_per_lot)}</div>
                </div>
                <div style="text-align:center;padding:8px;border-radius:8px;background:var(--glass-bg)">
                    <div style="font-size:0.5rem;color:var(--text-secondary)">Return</div>
                    <div style="font-size:0.85rem;font-weight:700;color:${pnlColor}">${pnlSign}${d.pnl_pct}%</div>
                </div>
            </div>

            <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:10px">
                <div style="text-align:center;padding:6px;border-radius:6px;background:var(--glass-bg)">
                    <div style="font-size:0.45rem;color:var(--text-secondary)">Spot</div>
                    <div style="font-size:0.7rem;font-weight:600;color:var(--text-heading)">${d.spot_price}</div>
                </div>
                <div style="text-align:center;padding:6px;border-radius:6px;background:var(--glass-bg)">
                    <div style="font-size:0.45rem;color:var(--text-secondary)">Bid / Ask</div>
                    <div style="font-size:0.65rem;font-weight:600;color:var(--text-heading)">${d.greeks.delta ? d.market.bid + ' / ' + d.market.ask : '-'}</div>
                </div>
                <div style="text-align:center;padding:6px;border-radius:6px;background:var(--glass-bg)">
                    <div style="font-size:0.45rem;color:var(--text-secondary)">Trail SL</div>
                    <div style="font-size:0.7rem;font-weight:600;color:#f87171">₹${d.trail_sl_premium}</div>
                </div>
                <div style="text-align:center;padding:6px;border-radius:6px;background:var(--glass-bg)">
                    <div style="font-size:0.45rem;color:var(--text-secondary)">DTE</div>
                    <div style="font-size:0.7rem;font-weight:600;color:${d.dte <= 3 ? '#f87171' : d.dte <= 7 ? '#fbbf24' : 'var(--text-heading)'}">${d.dte}d</div>
                </div>
            </div>

            <!-- Theta Warning -->
            ${d.theta_daily_pct > 3 ? `
            <div style="padding:5px 10px;border-radius:6px;background:rgba(251,191,36,0.08);font-size:0.55rem;color:#fde68a;margin-bottom:8px">
                ⏳ Theta burning <strong>${d.theta_daily_pct}%</strong> of your entry per day (₹${Math.abs(d.greeks.theta).toFixed(2)}/lot/day)
            </div>` : ''}

            <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:6px;flex-wrap:wrap">
                ${_tradeAnalysisData?.active_trade ? `
                <button onclick="_exitTradeNow(${_tradeAnalysisData.active_trade.id}, ${signalId})" id="exit-now-btn"
                    style="padding:5px 12px;border-radius:6px;background:rgba(239,68,68,0.15);border:1px solid #f87171;color:#f87171;font-size:0.55rem;cursor:pointer;font-weight:700">
                    Exit Now (Market Sell)
                </button>` : ''}
                <button onclick="fetchLiveAdvisory(${signalId}, ${strike}, '${side}', '${expiry}')"
                    style="padding:5px 12px;border-radius:6px;background:var(--glass-bg);border:1px solid var(--glass-border);color:var(--text-secondary);font-size:0.55rem;cursor:pointer">
                    ↻ Refresh
                </button>
                <button onclick="toggleAutoRefresh(${signalId}, ${strike}, '${side}', '${expiry}')" id="auto-refresh-btn"
                    style="padding:5px 12px;border-radius:6px;background:${_advisoryAutoRefresh ? 'rgba(239,68,68,0.2)' : 'rgba(34,197,94,0.15)'};border:1px solid ${_advisoryAutoRefresh ? '#f87171' : '#4ade80'};color:${_advisoryAutoRefresh ? '#f87171' : '#4ade80'};font-size:0.55rem;cursor:pointer">
                    ${_advisoryAutoRefresh ? '■ Stop Auto' : '▶ Auto Refresh 30s'}
                </button>
            </div>
        `;
    } catch (err) {
        resultDiv.innerHTML = `<div style="color:#fca5a5;font-size:0.6rem">Error: ${err.message}</div>`;
    }
}

function toggleAutoRefresh(signalId, strike, side, expiry) {
    if (_advisoryAutoRefresh) {
        clearInterval(_advisoryAutoRefresh);
        _advisoryAutoRefresh = null;
        const btn = document.getElementById('auto-refresh-btn');
        if (btn) {
            btn.style.background = 'rgba(34,197,94,0.15)';
            btn.style.borderColor = '#4ade80';
            btn.style.color = '#4ade80';
            btn.textContent = '▶ Auto Refresh 30s';
        }
    } else {
        fetchLiveAdvisory(signalId, strike, side, expiry);
        _advisoryAutoRefresh = setInterval(() => fetchLiveAdvisory(signalId, strike, side, expiry), 30000);
        const btn = document.getElementById('auto-refresh-btn');
        if (btn) {
            btn.style.background = 'rgba(239,68,68,0.2)';
            btn.style.borderColor = '#f87171';
            btn.style.color = '#f87171';
            btn.textContent = '■ Stop Auto';
        }
    }
}

// --- Trade Execution ---

let _tradeAnalysisData = null;

function _adjustLots(delta) {
    const input = document.getElementById('trade-lots');
    if (!input) return;
    let val = parseInt(input.value) + delta;
    val = Math.max(1, Math.min(50, val));
    input.value = val;
    _updateTotalCost();
}

function _updateTotalCost() {
    const lotsInput = document.getElementById('trade-lots');
    const priceInput = document.getElementById('trade-limit-price');
    const costDiv = document.getElementById('trade-total-cost');
    const btn = document.getElementById('trade-buy-btn');
    if (!lotsInput || !priceInput || !costDiv) return;

    const lots = parseInt(lotsInput.value) || 1;
    const price = parseFloat(priceInput.value) || 0;
    const lotSize = _tradeAnalysisData?.lot_size || 1;
    const total = Math.round(price * lotSize * lots);
    const fmt = n => new Intl.NumberFormat('en-IN').format(n);
    costDiv.textContent = `₹${fmt(total)}`;

    if (btn && _tradeAnalysisData) {
        const r = _tradeAnalysisData.recommendation;
        btn.textContent = `BUY ${lots} lot${lots > 1 ? 's' : ''} × ${r.strike} ${_tradeAnalysisData.side} — ₹${fmt(total)}`;
    }
}

function _confirmTrade(signalId, optionSecId, strike, side, expiry, lotSize, slPremium, targetPremium) {
    if (!isAdminUser()) {
        alert('Readonly user cannot place orders.');
        return;
    }
    if (!optionSecId) {
        alert('Option security ID not available. Try refreshing the analysis.');
        return;
    }

    const lots = parseInt(document.getElementById('trade-lots')?.value) || 1;
    const limitPrice = parseFloat(document.getElementById('trade-limit-price')?.value) || 0;
    if (limitPrice <= 0) {
        alert('Enter a valid limit price');
        return;
    }

    const quantity = lots * lotSize;
    const totalCost = Math.round(limitPrice * quantity);
    const fmt = n => new Intl.NumberFormat('en-IN').format(n);

    const confirmed = confirm(
        `CONFIRM TRADE\n\n` +
        `Buy ${lots} lot(s) of ${strike} ${side}\n` +
        `Quantity: ${quantity}\n` +
        `Limit Price: ₹${limitPrice}\n` +
        `Total Cost: ₹${fmt(totalCost)}\n\n` +
        `SL GTT: ₹${slPremium} (auto exit)\n` +
        `Target GTT: ₹${targetPremium} (auto exit)\n\n` +
        `Proceed?`
    );

    if (!confirmed) return;
    _executeTrade(signalId, optionSecId, strike, side, expiry, lots, lotSize, limitPrice, slPremium, targetPremium);
}

async function _executeTrade(signalId, optionSecId, strike, side, expiry, lots, lotSize, limitPrice, slPremium, targetPremium) {
    if (!isAdminUser()) return;
    const btn = document.getElementById('trade-buy-btn');
    const resultArea = document.getElementById('trade-result-area');
    const formArea = document.getElementById('trade-form-area');
    if (btn) {
        btn.disabled = true;
        btn.style.opacity = '0.6';
        btn.textContent = 'Placing orders...';
    }

    try {
        const resp = await fetch(`${API_BASE}/api/signals/place-trade`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                signal_id: signalId,
                option_security_id: optionSecId,
                strike: strike,
                side: side,
                expiry: expiry,
                lots: lots,
                lot_size: lotSize,
                limit_price: limitPrice,
                sl_trigger_price: slPremium,
                target_price: targetPremium,
            }),
        });

        const data = await resp.json();

        if (!resp.ok) {
            const errMsg = data.errors?.join(', ') || data.detail || 'Order failed';
            if (btn) {
                btn.disabled = false;
                btn.style.opacity = '1';
                btn.textContent = 'Retry';
            }
            if (resultArea) {
                resultArea.style.display = 'block';
                resultArea.innerHTML = `<div style="padding:10px;border-radius:8px;background:rgba(239,68,68,0.1);margin-top:8px">
                    <div style="font-size:0.7rem;font-weight:700;color:#f87171;margin-bottom:4px">Order Failed</div>
                    <div style="font-size:0.55rem;color:#fca5a5">${errMsg}</div>
                </div>`;
            }
            return;
        }

        // Success
        if (formArea) formArea.style.display = 'none';
        if (resultArea) {
            resultArea.style.display = 'block';
            const warnings = (data.errors || []).map(e =>
                `<div style="font-size:0.5rem;color:#fde68a;padding:2px 0">⚠ ${e}</div>`
            ).join('');

            resultArea.innerHTML = `
                <div style="padding:12px;border-radius:8px;background:rgba(34,197,94,0.1);text-align:center">
                    <div style="font-size:1.2rem;margin-bottom:6px">✅</div>
                    <div style="font-size:0.75rem;font-weight:700;color:#4ade80;margin-bottom:4px">${data.message || 'Trade Placed!'}</div>
                    ${data.is_amo ? '<div style="font-size:0.55rem;color:#fbbf24;margin-bottom:6px">📌 After Market Order — will execute at market open</div>' : ''}
                    <div style="font-size:0.55rem;color:var(--text-secondary);margin-bottom:8px">
                        Buy Order: ${data.buy?.orderId || '?'} (${data.buy?.orderStatus || '?'})
                    </div>
                    <div style="padding:6px;border-radius:6px;background:rgba(239,68,68,0.06);margin-bottom:6px">
                        <div style="font-size:0.45rem;color:#fca5a5">Target + SL (OCO GTT)</div>
                        <div style="font-size:0.6rem;font-weight:600;color:#f87171">${
                            data.protection?.state === 'protected' ? data.protection.order_id
                            : data.protection?.state === 'awaiting_fill' ? 'Placed automatically after fill'
                            : 'Manual needed'
                        }</div>
                    </div>
                    ${warnings}
                </div>
            `;
        }
    } catch (err) {
        if (btn) {
            btn.disabled = false;
            btn.style.opacity = '1';
            btn.textContent = 'Retry';
        }
        if (resultArea) {
            resultArea.style.display = 'block';
            resultArea.innerHTML = `<div style="padding:8px;border-radius:6px;background:rgba(239,68,68,0.1);font-size:0.6rem;color:#f87171">Network error: ${err.message}</div>`;
        }
    }
}

async function _exitTradeNow(tradeId, signalId) {
    if (!isAdminUser()) {
        alert('Readonly user cannot exit orders.');
        return;
    }
    const trade = _tradeAnalysisData?.active_trade;
    if (!trade) return;

    const confirmed = confirm(
        `EXIT NOW\n\n` +
        `Market SELL ${trade.strike} ${trade.side} × ${trade.lots} lot(s)\n` +
        `Entry: ₹${trade.entry_premium}\n\n` +
        `This will:\n` +
        `• Place MARKET SELL order\n` +
        `• Cancel SL GTT order\n` +
        `• Cancel Target GTT order\n\n` +
        `Proceed?`
    );
    if (!confirmed) return;

    const btn = document.getElementById('exit-now-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Exiting...'; btn.style.opacity = '0.6'; }

    try {
        const resp = await fetch(`${API_BASE}/api/signals/trades/${tradeId}/exit-now`, { method: 'POST' });
        const data = await resp.json();

        if (!resp.ok) {
            const errMsg = data.errors?.join(', ') || data.detail || 'Exit failed';
            alert('Exit failed: ' + errMsg);
            if (btn) { btn.disabled = false; btn.textContent = 'Exit Now (Market Sell)'; btn.style.opacity = '1'; }
            return;
        }

        const resultDiv = document.getElementById('live-advisory-result');
        if (resultDiv) {
            resultDiv.innerHTML = `
                <div style="padding:12px;border-radius:8px;background:rgba(34,197,94,0.1);text-align:center;margin-top:8px">
                    <div style="font-size:1rem;margin-bottom:4px">✅</div>
                    <div style="font-size:0.7rem;font-weight:700;color:#4ade80">${data.message}</div>
                    <div style="font-size:0.55rem;color:var(--text-secondary);margin-top:4px">Sell Order: ${data.sell?.orderId || '?'}</div>
                    ${data.errors?.length ? data.errors.map(e => `<div style="font-size:0.5rem;color:#fde68a;margin-top:2px">⚠ ${e}</div>`).join('') : ''}
                </div>`;
        }

        // Refresh the panel after a moment
        setTimeout(() => viewSignalDetail(signalId), 2000);
    } catch (err) {
        alert('Network error: ' + err.message);
        if (btn) { btn.disabled = false; btn.textContent = 'Exit Now (Market Sell)'; btn.style.opacity = '1'; }
    }
}

async function _cancelTrade(tradeId, signalId) {
    if (!isAdminUser()) {
        alert('Readonly user cannot cancel/update trade state.');
        return;
    }
    if (!confirm('Cancel this trade? This only updates the dashboard — make sure you already cancelled orders on Dhan.')) return;

    try {
        const resp = await fetch(`${API_BASE}/api/signals/trades/${tradeId}/close?reason=cancelled`, { method: 'POST' });
        if (!resp.ok) throw new Error('Failed to cancel');
        viewSignalDetail(signalId);
    } catch (err) {
        alert('Error: ' + err.message);
    }
}

// --- F&O Directional Scanner ---

let fnoScanMode = 'auto'; // 'auto' or 'custom'
let fnoSubTab = 'core';

function toggleFnoScanMode() {
    const btn = document.getElementById('btn-fno-mode');
    const panel = document.getElementById('fno-custom-panel');
    
    if (fnoScanMode === 'auto') {
        fnoScanMode = 'custom';
        btn.textContent = 'Custom Mode';
        btn.classList.remove('btn-secondary');
        btn.classList.add('btn-primary');
        panel.classList.remove('hidden');
        loadSectorOptions();
    } else {
        fnoScanMode = 'auto';
        btn.textContent = 'Auto Mode';
        btn.classList.remove('btn-primary');
        btn.classList.add('btn-secondary');
        panel.classList.add('hidden');
    }
}

function switchFnoSubTab(mode, btn) {
    fnoSubTab = mode;
    const corePanel = document.getElementById('fno-core-panel');
    const adPanel = document.getElementById('fno-advdecl-panel');
    if (corePanel) corePanel.classList.toggle('hidden', mode !== 'core');
    if (adPanel) adPanel.classList.toggle('hidden', mode !== 'advdecl');

    const pills = document.querySelectorAll('#fno-subtab .filter-pill');
    pills.forEach(p => p.classList.toggle('active', p.dataset.value === mode));
}

// --- Index Trading ---

let _indexMode = 'intraday';
let _indexSubTab = 'nifty';
let _trackingTimer = null;
let _indexManualSetup = null;
let _indexManualMonitorTimer = null;

function switchIndexSubTab(mode, btn) {
    _indexSubTab = mode === 'sensex' ? 'sensex' : 'nifty';
    const niftyPanel = document.getElementById('index-panel-nifty');
    const sensexPanel = document.getElementById('index-panel-sensex');
    if (niftyPanel) niftyPanel.classList.toggle('hidden', _indexSubTab !== 'nifty');
    if (sensexPanel) sensexPanel.classList.toggle('hidden', _indexSubTab !== 'sensex');

    const pills = document.querySelectorAll('#index-subtab .filter-pill');
    pills.forEach(p => p.classList.toggle('active', p.dataset.value === _indexSubTab));
    refreshIndexManualDesk();
}

function _setIndexManualStatus(msg, isError = false) {
    const el = document.getElementById('index-manual-status');
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = isError ? '#ef4444' : 'var(--text-muted)';
}

function _activeIndexKey() {
    return _indexSubTab === 'sensex' ? 'sensex' : 'nifty';
}

function scrollToIndexOpenPositions() {
    const el = document.getElementById('index-manual-open');
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function _indexDeskPlanKey(side) {
    const s = side === 'pe' ? 'pe' : 'ce';
    return `index-desk-plan:${_activeIndexKey()}:${s}`;
}

function saveIndexDeskPlan(side) {
    const s = side === 'pe' ? 'pe' : 'ce';
    const fields = {
        strike: document.getElementById(`index-${s}-strike`)?.value || '',
        lots: document.getElementById(`index-${s}-lots`)?.value || '',
        sl: document.getElementById(`index-${s}-sl`)?.value || '',
        t1: document.getElementById(`index-${s}-t1`)?.value || '',
        t1Lots: document.getElementById(`index-${s}-t1-lots`)?.value || '',
        t2: document.getElementById(`index-${s}-t2`)?.value || '',
        t2Lots: document.getElementById(`index-${s}-t2-lots`)?.value || '',
    };
    localStorage.setItem(_indexDeskPlanKey(s), JSON.stringify(fields));
    _setIndexManualStatus(`${s.toUpperCase()} plan saved`);
}

function updateIndexManualAmount(sideKey) {
    const side = sideKey === 'pe' ? 'pe' : 'ce';
    const amountEl = document.getElementById(`index-${side}-amount`);
    const lotsEl = document.getElementById(`index-${side}-lots`);
    const slEl = document.getElementById(`index-${side}-sl`);
    const t1El = document.getElementById(`index-${side}-t1`);
    const t2El = document.getElementById(`index-${side}-t2`);
    const t1LotsEl = document.getElementById(`index-${side}-t1-lots`);
    const t2LotsEl = document.getElementById(`index-${side}-t2-lots`);
    if (!amountEl || !lotsEl || !slEl || !t1El || !t2El || !t1LotsEl || !t2LotsEl) return;

    const setup = _indexManualSetup || {};
    const sideData = setup[side] || {};
    const cmpRaw = Number(sideData.ltp || 0);
    const cmp = cmpRaw > 0 ? Number(cmpRaw.toFixed(2)) : 0;
    const sl = Number(slEl.value || 0);
    const t1 = Number(t1El.value || 0);
    const t2 = Number(t2El.value || 0);
    const t1Lots = Math.max(0, Number(t1LotsEl.value || 0));
    const t2Lots = Math.max(0, Number(t2LotsEl.value || 0));
    const fallbackLot = _activeIndexKey() === 'sensex' ? 20 : 65;
    const lotSize = Number(setup.lot_size || fallbackLot);
    const lots = Math.max(1, Number(lotsEl.value || 1));
    const qty = lotSize > 0 ? lotSize * lots : 0;
    const amount = cmp > 0 && qty > 0 ? cmp * qty : null;
    const slGap = cmp > 0 && sl > 0 ? (cmp - sl) : null;
    const riskAmount = slGap != null && qty > 0 ? (slGap * qty) : null;
    const t1Qty = lotSize > 0 ? t1Lots * lotSize : 0;
    const t2Qty = lotSize > 0 ? t2Lots * lotSize : 0;
    const t1Profit = (cmp > 0 && t1 > 0 && t1Qty > 0) ? (t1 - cmp) * t1Qty : null;
    const t2Profit = (cmp > 0 && t2 > 0 && t2Qty > 0) ? (t2 - cmp) * t2Qty : null;
    const probableProfit = ((t1Profit || 0) + (t2Profit || 0));

    const fmt = n => new Intl.NumberFormat('en-IN').format(Math.round(Number(n || 0)));
    const fmt2 = n => Number(n || 0).toFixed(2);
    const profitLabel = v => v == null ? '-' : `₹${fmt(v)}`;
    amountEl.textContent = amount != null
        ? `CMP: ₹${fmt2(cmp)} · Lot Size: ${lotSize} · Qty: ${qty} · T1 Qty: ${t1Qty} · T2 Qty: ${t2Qty} · SL Gap: ₹${slGap != null ? fmt2(slGap) : '-'} · Amount Required: ₹${fmt(amount)}${riskAmount != null ? ` · Risk @ SL: ₹${fmt(riskAmount)}` : ''} · T1 Profit: ${profitLabel(t1Profit)} · T2 Profit: ${profitLabel(t2Profit)} · Total Probable Profit: ${profitLabel((t1Profit != null || t2Profit != null) ? probableProfit : null)}`
        : 'CMP: - · Qty: - · Amount Required: -';
}

async function refreshIndexManualDesk() {
    await Promise.all([loadIndexManualSetup(), loadIndexManualOpenTrades()]);
    startIndexManualMonitor();
}

async function loadIndexManualSetup() {
    const indexKey = _activeIndexKey();
    try {
        const resp = await fetch(`${API_BASE}/api/index-trading/manual/setup?index=${indexKey}`);
        const data = await resp.json();
        if (!resp.ok) throw new Error(data?.detail || 'Failed to load execution desk');
        _indexManualSetup = data;

        const ceStrike = document.getElementById('index-ce-strike');
        const peStrike = document.getElementById('index-pe-strike');
        const ceSl = document.getElementById('index-ce-sl');
        const peSl = document.getElementById('index-pe-sl');
        const ceT1 = document.getElementById('index-ce-t1');
        const ceT2 = document.getElementById('index-ce-t2');
        const ceT1Lots = document.getElementById('index-ce-t1-lots');
        const ceT2Lots = document.getElementById('index-ce-t2-lots');
        const peT1 = document.getElementById('index-pe-t1');
        const peT2 = document.getElementById('index-pe-t2');
        const peT1Lots = document.getElementById('index-pe-t1-lots');
        const peT2Lots = document.getElementById('index-pe-t2-lots');
        const ceLots = document.getElementById('index-ce-lots');
        const peLots = document.getElementById('index-pe-lots');
        if (ceStrike && data?.ce?.strike) ceStrike.value = String(Math.round(Number(data.ce.strike)));
        if (peStrike && data?.pe?.strike) peStrike.value = String(Math.round(Number(data.pe.strike)));
        // Auto-fill SL as premium value (not percentage): default 20% below CMP.
        if (ceSl && data?.ce?.ltp != null) ceSl.value = String(Math.max(0.05, Number((Number(data.ce.ltp) * 0.8).toFixed(2))));
        if (peSl && data?.pe?.ltp != null) peSl.value = String(Math.max(0.05, Number((Number(data.pe.ltp) * 0.8).toFixed(2))));
        if (ceT1 && data?.ce?.ltp != null) ceT1.value = Number((Number(data.ce.ltp) * 1.05).toFixed(2));
        if (ceT2 && data?.ce?.ltp != null) ceT2.value = Number((Number(data.ce.ltp) * 1.10).toFixed(2));
        if (peT1 && data?.pe?.ltp != null) peT1.value = Number((Number(data.pe.ltp) * 1.05).toFixed(2));
        if (peT2 && data?.pe?.ltp != null) peT2.value = Number((Number(data.pe.ltp) * 1.10).toFixed(2));
        const ceLotsVal = Math.max(1, Number(ceLots?.value || 1));
        const peLotsVal = Math.max(1, Number(peLots?.value || 1));
        const ceHalf = Math.floor(ceLotsVal / 2);
        const peHalf = Math.floor(peLotsVal / 2);
        if (ceT1Lots) ceT1Lots.value = String(ceHalf);
        if (ceT2Lots) ceT2Lots.value = String(Math.max(0, ceLotsVal - ceHalf));
        if (peT1Lots) peT1Lots.value = String(peHalf);
        if (peT2Lots) peT2Lots.value = String(Math.max(0, peLotsVal - peHalf));

        // Load saved manual plan overrides if present.
        try {
            const ceSaved = JSON.parse(localStorage.getItem(_indexDeskPlanKey('ce')) || 'null');
            const peSaved = JSON.parse(localStorage.getItem(_indexDeskPlanKey('pe')) || 'null');
            if (ceSaved) {
                if (ceStrike && ceSaved.strike) ceStrike.value = ceSaved.strike;
                if (ceLots && ceSaved.lots) ceLots.value = ceSaved.lots;
                if (ceSl && ceSaved.sl) ceSl.value = ceSaved.sl;
                if (ceT1 && ceSaved.t1) ceT1.value = ceSaved.t1;
                if (ceT2 && ceSaved.t2) ceT2.value = ceSaved.t2;
                if (ceT1Lots && ceSaved.t1Lots) ceT1Lots.value = ceSaved.t1Lots;
                if (ceT2Lots && ceSaved.t2Lots) ceT2Lots.value = ceSaved.t2Lots;
            }
            if (peSaved) {
                if (peStrike && peSaved.strike) peStrike.value = peSaved.strike;
                if (peLots && peSaved.lots) peLots.value = peSaved.lots;
                if (peSl && peSaved.sl) peSl.value = peSaved.sl;
                if (peT1 && peSaved.t1) peT1.value = peSaved.t1;
                if (peT2 && peSaved.t2) peT2.value = peSaved.t2;
                if (peT1Lots && peSaved.t1Lots) peT1Lots.value = peSaved.t1Lots;
                if (peT2Lots && peSaved.t2Lots) peT2Lots.value = peSaved.t2Lots;
            }
        } catch (_) {
            // ignore localStorage parse errors
        }
        updateIndexManualAmount('ce');
        updateIndexManualAmount('pe');

        const mktTag = data.market_open ? 'Live' : 'Closed';
        _setIndexManualStatus(`${data.index} Spot ₹${Number(data.spot || 0).toFixed(1)} · Exp ${data.expiry} · ${mktTag}`);
    } catch (e) {
        _setIndexManualStatus(`Desk load failed: ${e.message}`, true);
    }
}

async function loadIndexManualOpenTrades() {
    const indexKey = _activeIndexKey();
    const holder = document.getElementById('index-manual-open');
    if (!holder) return;
    try {
        const resp = await fetch(`${API_BASE}/api/index-trading/manual/open?index=${indexKey}`);
        const data = await resp.json();
        if (!resp.ok) throw new Error(data?.detail || 'Failed to load open positions');
        const rows = data.rows || [];
        if (!rows.length) {
            holder.innerHTML = `<div class="text-2xs text-center p-2" style="color:var(--text-muted)">No open manual positions</div>`;
            return;
        }
        const fmt = n => new Intl.NumberFormat('en-IN').format(Math.round(Number(n || 0)));
        holder.innerHTML = `
            <table class="data-table" style="font-size:0.58rem">
                <thead>
                    <tr>
                        <th>Leg</th>
                        <th>Entry</th>
                        <th>Live</th>
                        <th>MTM</th>
                        <th>SL</th>
                        <th>T1</th>
                        <th>T2</th>
                        <th>Update Plan</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows.map(r => {
                        const live = r.live_ltp != null ? Number(r.live_ltp) : null;
                        const entry = r.entry_price != null ? Number(r.entry_price) : null;
                        const qty = r.quantity != null ? Number(r.quantity) : 0;
                        const mtm = (live != null && entry != null && qty) ? (live - entry) * qty : null;
                        const mtmColor = mtm == null ? 'var(--text-muted)' : (mtm >= 0 ? '#22c55e' : '#ef4444');
                        return `
                        <tr>
                            <td>${r.strike || '-'} ${r.side || ''} · ${(r.remaining_lots ?? r.lots ?? 1)}L left</td>
                            <td>₹${fmt(r.entry_price)}</td>
                            <td>${r.live_ltp != null ? `₹${fmt(r.live_ltp)}` : '-'}</td>
                            <td style="color:${mtmColor};font-weight:600">${mtm == null ? '-' : `₹${fmt(mtm)}`}</td>
                            <td><input id="manual-sl-${r.trade_id}" class="themed-input rounded px-1 py-0.5 text-2xs" type="number" min="1" value="${r.sl_price || ''}" style="width:72px"></td>
                            <td style="display:flex;gap:4px;align-items:center">
                                <input id="manual-t1-${r.trade_id}" class="themed-input rounded px-1 py-0.5 text-2xs" type="number" min="0.05" value="${r.t1_price ?? ''}" style="width:68px">
                                <input id="manual-t1l-${r.trade_id}" class="themed-input rounded px-1 py-0.5 text-2xs" type="number" min="0" value="${r.t1_lots ?? 0}" style="width:42px" title="T1 lots">
                            </td>
                            <td style="display:flex;gap:4px;align-items:center">
                                <input id="manual-t2-${r.trade_id}" class="themed-input rounded px-1 py-0.5 text-2xs" type="number" min="0.05" value="${r.t2_price ?? ''}" style="width:68px">
                                <input id="manual-t2l-${r.trade_id}" class="themed-input rounded px-1 py-0.5 text-2xs" type="number" min="0" value="${r.t2_lots ?? 0}" style="width:42px" title="T2 lots">
                            </td>
                            <td style="display:flex;gap:4px;align-items:center">
                                ${isAdminUser()
                                    ? `<button onclick="modifyIndexManualPlan(${r.trade_id})" class="btn-secondary px-2 py-0.5 rounded text-2xs">Save</button>`
                                    : `<span class="text-2xs" style="color:var(--text-muted)">Readonly</span>`}
                            </td>
                        </tr>
                    `;
                    }).join('')}
                </tbody>
            </table>
        `;
    } catch (e) {
        holder.innerHTML = `<div class="text-2xs text-center p-2" style="color:#ef4444">Open positions load failed: ${e.message}</div>`;
    }
}

async function placeIndexManualTrade(side) {
    if (!isAdminUser()) {
        _setIndexManualStatus('Readonly user cannot place orders', true);
        return;
    }
    const sideKey = side === 'PE' ? 'pe' : 'ce';
    const strikeEl = document.getElementById(`index-${sideKey}-strike`);
    const lotsEl = document.getElementById(`index-${sideKey}-lots`);
    const slEl = document.getElementById(`index-${sideKey}-sl`);
    const t1El = document.getElementById(`index-${sideKey}-t1`);
    const t2El = document.getElementById(`index-${sideKey}-t2`);
    const t1LotsEl = document.getElementById(`index-${sideKey}-t1-lots`);
    const t2LotsEl = document.getElementById(`index-${sideKey}-t2-lots`);
    const btn = document.getElementById(`btn-index-${sideKey}-buy`);
    if (!strikeEl || !lotsEl || !slEl || !t1El || !t2El || !t1LotsEl || !t2LotsEl) return;

    const strike = Number(strikeEl.value || 0);
    const lots = Number(lotsEl.value || 1);
    const slValue = Number(slEl.value || 0);
    const t1Price = Number(t1El.value || 0);
    const t2Price = Number(t2El.value || 0);
    const t1Lots = Number(t1LotsEl.value || 0);
    const t2Lots = Number(t2LotsEl.value || 0);
    if (!strike || strike <= 0) {
        _setIndexManualStatus('Enter a valid strike', true);
        return;
    }
    if (!lots || lots < 1) {
        _setIndexManualStatus('Lots must be at least 1', true);
        return;
    }
    if (!slValue || slValue <= 0) {
        _setIndexManualStatus('Enter a valid SL premium value', true);
        return;
    }
    if (t1Price > 0 && t2Price > 0 && t2Price <= t1Price) {
        _setIndexManualStatus('T2 should be greater than T1', true);
        return;
    }
    if ((t1Lots + t2Lots) > lots) {
        _setIndexManualStatus('T1 + T2 lots cannot exceed total lots', true);
        return;
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Placing...'; btn.style.opacity = '0.7'; }
    _setIndexManualStatus(`Placing ${side} order...`);
    try {
        const payload = {
            index: _activeIndexKey(),
            side,
            strike,
            lots,
            sl_price: slValue,
            t1_price: t1Price || null,
            t1_lots: t1Lots || 0,
            t2_price: t2Price || null,
            t2_lots: t2Lots || 0,
            expiry: _indexManualSetup?.expiry || null,
        };
        const resp = await fetch(`${API_BASE}/api/index-trading/manual/place`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data?.detail || 'Order placement failed');
        const warn = (data.warnings || []).join(' · ');
        _setIndexManualStatus(
            `Executed ${side} ${data.strike} @ ₹${data.entry_price} · SL ₹${data.sl_price}` + (warn ? ` · ⚠ ${warn}` : ''),
            !data.ok,
        );
        await loadIndexManualOpenTrades();
        await loadIndexSignals(_indexMode); // Moves into upper tracking section
        startTradeTracking();
    } catch (e) {
        _setIndexManualStatus(`Order failed: ${e.message}`, true);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = side === 'PE' ? 'Buy PE @ CMP + Auto SL' : 'Buy CE @ CMP + Auto SL';
            btn.style.opacity = '1';
        }
    }
}

async function modifyIndexManualPlan(tradeId) {
    if (!isAdminUser()) {
        _setIndexManualStatus('Readonly user cannot modify live plans', true);
        return;
    }
    const slInput = document.getElementById(`manual-sl-${tradeId}`);
    const t1Input = document.getElementById(`manual-t1-${tradeId}`);
    const t2Input = document.getElementById(`manual-t2-${tradeId}`);
    const t1LotsInput = document.getElementById(`manual-t1l-${tradeId}`);
    const t2LotsInput = document.getElementById(`manual-t2l-${tradeId}`);
    if (!slInput || !t1Input || !t2Input || !t1LotsInput || !t2LotsInput) return;

    const sl = Number(slInput.value || 0);
    const t1 = Number(t1Input.value || 0);
    const t2 = Number(t2Input.value || 0);
    const t1Lots = Number(t1LotsInput.value || 0);
    const t2Lots = Number(t2LotsInput.value || 0);
    if (!sl || sl <= 0) {
        _setIndexManualStatus('Enter valid SL premium value', true);
        return;
    }
    if (t1 > 0 && t2 > 0 && t2 <= t1) {
        _setIndexManualStatus('T2 should be greater than T1', true);
        return;
    }

    _setIndexManualStatus(`Updating SL/T1/T2 for trade ${tradeId}...`);
    try {
        const resp = await fetch(`${API_BASE}/api/index-trading/manual/trades/${tradeId}/targets`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sl_price: sl,
                t1_price: t1 || null,
                t2_price: t2 || null,
                t1_lots: t1Lots || 0,
                t2_lots: t2Lots || 0
            }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data?.detail || 'Plan update failed');
        _setIndexManualStatus(`Updated: SL ₹${data.sl_price} · T1 ${data.t1_price || '-'} · T2 ${data.t2_price || '-'}`);
        await loadIndexManualOpenTrades();
        await loadIndexSignals(_indexMode);
    } catch (e) {
        _setIndexManualStatus(`Plan update failed: ${e.message}`, true);
    }
}

function startIndexManualMonitor() {
    if (_indexManualMonitorTimer) return;
    _indexManualMonitorTimer = setInterval(async () => {
        try {
            // T1/T2 exits run server-side (scheduler "order_safety" job); just refresh the view.
            await loadIndexManualOpenTrades();
            await loadIndexSignals(_indexMode);
        } catch (_) {
            // ignore transient monitor errors
        }
    }, 15000);
}

async function loadIndexSignals(mode = _indexMode) {
    _indexMode = mode;
    const status = document.getElementById('index-scan-status');
    if (status) status.textContent = 'Loading index signals...';

    try {
        const resp = await fetch(`${API_BASE}/api/index-trading/signals?mode=${mode}`);
        const data = await resp.json();
        window._lastIndexSignalsData = data;
        renderIndexSignals(data, mode);
        refreshIndexManualDesk();

        if (status) {
            const ts = data.as_of ? new Date(data.as_of).toLocaleTimeString() : '';
            const count = (data.signals || []).length;
            const skipText = data.summary?.skip_reason_counts && Object.keys(data.summary.skip_reason_counts).length
                ? ` · Skips: ${JSON.stringify(data.summary.skip_reason_counts)}`
                : '';
            status.textContent = count
                ? `Last scan: ${ts || 'n/a'} · ${mode === 'positional' ? 'Positional' : 'Intraday'} signals: ${count}${skipText}`
                : (data.summary?.error ? `Index scan error: ${data.summary.error}` : `No ${mode} index signals yet${skipText}`);
        }
    } catch (e) {
        if (status) status.textContent = `Index load failed: ${e.message}`;
    }
}

async function runIndexScan(mode = _indexMode) {
    if (!isAdminUser()) {
        const status = document.getElementById('index-scan-status');
        if (status) status.textContent = 'Readonly user cannot run scans';
        return;
    }
    _indexMode = mode;
    const btn = document.getElementById('btn-index-scan');
    const btnPos = document.getElementById('btn-index-scan-positional');
    const status = document.getElementById('index-scan-status');
    if (btn) { btn.disabled = true; btn.textContent = 'Scanning...'; btn.style.opacity = '0.7'; }
    if (btnPos) { btnPos.disabled = true; btnPos.textContent = 'Scanning...'; btnPos.style.opacity = '0.7'; }
    if (status) status.textContent = `Running ${mode} index scan...`;

    try {
        const resp = await fetch(`${API_BASE}/api/index-trading/scan/run?mode=${mode}`, { method: 'POST' });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data?.detail || 'Scan failed');
        window._lastIndexSignalsData = data;
        renderIndexSignals(data, mode);
        if (status) {
            const skips = data.summary?.skip_reason_counts;
            const skipText = skips && Object.keys(skips).length
                ? ` · Skips: ${JSON.stringify(skips)}`
                : '';
            status.textContent = `Scan complete · ${mode} signals: ${(data.signals || []).length}${skipText}`;
        }
    } catch (e) {
        if (status) status.textContent = `Index scan failed: ${e.message}`;
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Scan Intraday'; btn.style.opacity = '1'; }
        if (btnPos) { btnPos.disabled = false; btnPos.textContent = 'Scan Positional'; btnPos.style.opacity = '1'; }
    }
}

function renderIndexSignals(data, mode = _indexMode) {
    const niftyTable = document.getElementById('index-nifty-table');
    const sensexTable = document.getElementById('index-sensex-table');
    if (!niftyTable || !sensexTable) return;

    const signals = data.signals || [];
    const fmt = n => new Intl.NumberFormat('en-IN').format(n);
    const baseBuyRangePct = 0.03;
    const liveAnchorRangePct = 0.025;
    const maxEntryDriftPct = 0.18;
    const exitRangePct = 0.1;
    const hasNumber = value => value !== null && value !== undefined && !Number.isNaN(Number(value));

    const formatPrice = value => {
        if (!hasNumber(value)) return '-';
        return `₹${fmt(Math.round(Number(value)))}`;
    };

    const formatRange = (center, pct) => {
        if (!hasNumber(center)) return '-';
        const base = Number(center);
        const low = Math.max(0.05, base * (1 - pct));
        const high = base * (1 + pct);
        return `₹${fmt(Math.round(low))}-₹${fmt(Math.round(high))}`;
    };

    const formatExplicitRange = (low, high) => {
        if (!hasNumber(low) || !hasNumber(high)) return '-';
        const minVal = Math.min(Number(low), Number(high));
        const maxVal = Math.max(Number(low), Number(high));
        return `₹${fmt(Math.round(minVal))}-₹${fmt(Math.round(maxVal))}`;
    };

    const formatLotValue = value => {
        if (!hasNumber(value)) return '-';
        return `₹${fmt(Math.round(Number(value)))}`;
    };

    const formatExpiry = exp => {
        if (!exp) return '-';
        const today = new Date();
        const d = new Date(exp);
        const diff = Math.ceil((d - today) / (1000 * 60 * 60 * 24));
        return `${exp.slice(5)} (${diff >= 0 ? diff : 0}d)`;
    };

    const renderTable = (rows, label) => {
        if (!rows.length) {
            return `<div class="p-6 text-center text-2xs" style="color:var(--text-muted)">No ${label} setups right now</div>`;
        }
        const body = rows.map(r => {
            const click = r.signal_id ? `onclick="viewSignalDetail(${r.signal_id})"` : '';
            const strikeLabel = `${r.strike || '-'} ${r.direction || ''}`.trim();
            const liveLtp = hasNumber(r.live_option_ltp) ? Number(r.live_option_ltp) : null;
            const basePremium = hasNumber(r.premium) ? Number(r.premium) : liveLtp;
            let entryLow = hasNumber(r.entry_premium_low) ? Number(r.entry_premium_low) : (hasNumber(basePremium) ? Number(basePremium) * (1 - baseBuyRangePct) : null);
            let entryHigh = hasNumber(r.entry_premium_high) ? Number(r.entry_premium_high) : (hasNumber(basePremium) ? Number(basePremium) * (1 + baseBuyRangePct) : null);
            let entryWasRecentered = false;

            // Keep scanner's planned entry zone when still relevant.
            // If market has drifted too far away, recenter around live premium.
            if (hasNumber(liveLtp) && hasNumber(entryLow) && hasNumber(entryHigh)) {
                const entryMid = (entryLow + entryHigh) / 2;
                const driftPct = entryMid > 0 ? Math.abs(liveLtp - entryMid) / entryMid : 0;
                if (driftPct >= maxEntryDriftPct) {
                    entryLow = Number(liveLtp) * (1 - liveAnchorRangePct);
                    entryHigh = Number(liveLtp) * (1 + liveAnchorRangePct);
                    entryWasRecentered = true;
                }
            }
            const exitLow = hasNumber(r.exit_premium_low) ? Number(r.exit_premium_low) : (hasNumber(r.premium_target) ? Number(r.premium_target) * (1 - exitRangePct) : null);
            const exitHigh = hasNumber(r.exit_premium_high) ? Number(r.exit_premium_high) : (hasNumber(r.premium_target) ? Number(r.premium_target) * (1 + exitRangePct) : null);
            const buyRange = hasNumber(entryLow) && hasNumber(entryHigh)
                ? formatExplicitRange(entryLow, entryHigh)
                : formatRange(r.premium, baseBuyRangePct);
            const exitRange = hasNumber(exitLow) && hasNumber(exitHigh)
                ? formatExplicitRange(exitLow, exitHigh)
                : formatRange(r.premium_target, exitRangePct);
            const lotSize = hasNumber(r.lot_size) ? Number(r.lot_size) : null;
            const totalAmount = hasNumber(entryHigh) && hasNumber(lotSize) ? entryHigh * lotSize : null;
            const minProfit = hasNumber(exitLow) && hasNumber(entryHigh) && hasNumber(lotSize)
                ? Math.max(0, (exitLow - entryHigh) * lotSize)
                : null;
            const maxLoss = hasNumber(r.premium_sl) && hasNumber(entryHigh) && hasNumber(lotSize)
                ? Math.max(0, (entryHigh - Number(r.premium_sl)) * lotSize)
                : null;
            const isTracked = r.is_tracked || false;
            const trackStatus = r.track_status || 'NONE';
            const trackReason = r.track_status_reason || '';
            let entryStateText = '-';
            let entryStateColor = '#6b7280';
            let entryStateBg = 'rgba(107,114,128,0.1)';
            if (hasNumber(liveLtp) && hasNumber(entryLow) && hasNumber(entryHigh)) {
                if (liveLtp >= entryLow && liveLtp <= entryHigh) {
                    entryStateText = 'IN RANGE';
                    entryStateColor = '#22c55e';
                    entryStateBg = 'rgba(34,197,94,0.12)';
                } else if (liveLtp > entryHigh) {
                    entryStateText = 'WAIT FOR RANGE';
                    entryStateColor = '#f59e0b';
                    entryStateBg = 'rgba(245,158,11,0.12)';
                } else if (liveLtp < entryLow) {
                    entryStateText = 'BELOW RANGE';
                    entryStateColor = '#60a5fa';
                    entryStateBg = 'rgba(96,165,250,0.12)';
                }
            }
            if (entryWasRecentered && hasNumber(liveLtp)) {
                entryStateText = 'LIVE-ALIGNED';
                entryStateColor = '#a855f7';
                entryStateBg = 'rgba(168,85,247,0.12)';
            }
            const statusColor = trackStatus === 'HOLD' ? '#3b82f6' : trackStatus === 'EARLY-EXIT' ? '#f97316' : trackStatus === 'SL-HIT' ? '#ef4444' : trackStatus === 'TARGET-HIT' ? '#22c55e' : '#6b7280';
            const statusBg = trackStatus === 'HOLD' ? 'rgba(59,130,246,0.1)' : trackStatus === 'EARLY-EXIT' ? 'rgba(249,115,22,0.1)' : trackStatus === 'SL-HIT' ? 'rgba(239,68,68,0.1)' : trackStatus === 'TARGET-HIT' ? 'rgba(34,197,94,0.1)' : 'rgba(107,114,128,0.1)';
            return `
                <tr class="cursor-pointer" ${click}>
                    <td>${r.index || '-'}</td>
                    <td>${strikeLabel}</td>
                    <td>${formatExpiry(r.expiry)}</td>
                    <td>${hasNumber(liveLtp) ? formatPrice(liveLtp) : '-'}</td>
                    <td>${buyRange}</td>
                    <td>
                        <span class="text-2xs px-2 py-0.5 rounded font-medium" style="background:${entryStateBg};color:${entryStateColor}">${entryStateText}</span>
                    </td>
                    <td>${exitRange}</td>
                    <td>${formatPrice(r.premium_sl)}</td>
                    <td>${formatLotValue(totalAmount)}</td>
                    <td>${formatLotValue(minProfit)}</td>
                    <td>${formatLotValue(maxLoss)}</td>
                    <td>
                        ${isAdminUser()
                            ? `<button onclick="toggleTradeTracking(${r.signal_id || 0}, ${!isTracked}, ${JSON.stringify(r).replace(/"/g, '&quot;')})" 
                                class="text-2xs px-2 py-1 rounded" 
                                style="background:${isTracked ? 'rgba(34,197,94,0.1)' : 'rgba(107,114,128,0.1)'};color:${isTracked ? '#22c55e' : '#6b7280'};border:1px solid ${isTracked ? '#22c55e' : '#6b7280'}">
                            ${isTracked ? 'Tracking ✕' : 'Track'}
                        </button>`
                            : `<span class="text-2xs" style="color:var(--text-muted)">Readonly</span>`}
                    </td>
                    <td title="${trackReason}">
                        <div style="display:flex;flex-direction:column;gap:2px">
                            <span class="text-2xs px-2 py-0.5 rounded font-medium" 
                                  style="background:${statusBg};color:${statusColor}">
                                ${trackStatus === 'NONE' ? '-' : trackStatus}
                            </span>
                            ${trackReason && trackStatus !== 'NONE' ? `<span style="font-size:0.5rem;color:var(--text-muted);max-width:240px;white-space:normal;word-break:break-word;line-height:1.25">${trackReason}</span>` : ''}
                        </div>
                    </td>
                </tr>
            `;
        }).join('');

        return `
            <table class="data-table" style="font-size:0.6rem">
                <thead>
                    <tr>
                        <th>Script</th>
                        <th>Strike</th>
                        <th>Expiry</th>
                        <th>Live LTP</th>
                        <th>Premium Buy Range</th>
                        <th>Entry Zone</th>
                        <th>Premium Exit Range</th>
                        <th>Premium SL</th>
                        <th>Total Amount / Lot</th>
                        <th>Min Profit / Lot</th>
                        <th>Max Loss / Lot</th>
                        <th>Action</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody>${body}</tbody>
            </table>
        `;
    };

    const isSensex = name => /sensex/i.test(name || '');
    const isNifty = name => /nifty/i.test(name || '');
    const niftyRows = signals.filter(s => isNifty(s.index));
    const sensexRows = signals.filter(s => isSensex(s.index));
    const otherRows = signals.filter(s => !isNifty(s.index) && !isSensex(s.index));

    niftyTable.innerHTML = renderTable(niftyRows.concat(otherRows), 'Nifty');
    sensexTable.innerHTML = renderTable(sensexRows, 'Sensex');
    applySortable('index-nifty-table');
    applySortable('index-sensex-table');
    switchIndexSubTab(_indexSubTab);
    
    // Start tracking if any trades are being tracked
    const hasTracked = signals.some(s => s.is_tracked);
    if (hasTracked && !_trackingTimer) {
        startTradeTracking();
    }
}

async function toggleTradeTracking(signalId, enable, signalData) {
    if (!isAdminUser()) return;
    if (!signalId) return;
    
    let payload = { enable };
    if (enable && signalData) {
        // Pass trade parameters so backend can track properly
        const r = typeof signalData === 'string' ? JSON.parse(signalData) : signalData;
        payload = {
            enable,
            entry_price: r.entry_premium_high || r.premium || null,
            target_price: r.exit_premium_high || r.premium_target || null,
            sl_price: r.premium_sl || null,
            option_security_id: r.option_security_id || null,
            expiry: r.expiry || null,
            direction: r.direction || null,
            spot: r.spot || null,
            support: r.sl_price || null,       // sl_price here is spot support level
            resistance: r.target_price || null, // target_price here is spot resistance level
            oi: r.oi || null,
            volume: r.volume || null,
        };
    }
    
    try {
        const resp = await fetch(`${API_BASE}/api/index-trading/track/${signalId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!resp.ok) throw new Error('Failed to update tracking');
        
        // Reload signals to show updated status
        loadIndexSignals(_indexMode);
        
        if (enable) {
            startTradeTracking();
        }
    } catch (e) {
        console.error('Error toggling tracking:', e);
    }
}

function startTradeTracking() {
    if (_trackingTimer) return; // Already running
    
    _trackingTimer = setInterval(async () => {
        try {
            const resp = await fetch(`${API_BASE}/api/index-trading/update-tracking`, { method: 'POST' });
            if (resp.ok) {
                loadIndexSignals(_indexMode); // Refresh to show status updates
                checkStopTracking(); // Stop if no more active trades
            }
        } catch (e) {
            console.error('Error updating tracking:', e);
        }
    }, 2 * 60 * 1000); // 2 minutes
}

function checkStopTracking() {
    // This will be called after loadIndexSignals, so we can check the current data
    // For now, we'll let the timer run - it will be lightweight if no trades are tracked
}

function stopTradeTracking() {
    if (_trackingTimer) {
        clearInterval(_trackingTimer);
        _trackingTimer = null;
    }
}

// --- Value Investing ---

async function refreshValueInvesting() {
    const btn = document.getElementById('btn-value-refresh');
    const status = document.getElementById('value-scan-status');
    if (btn) { btn.disabled = true; btn.textContent = 'Refreshing...'; btn.style.opacity = '0.7'; }
    if (status) { status.textContent = 'Fetching Tapetide fundamentals...'; status.style.color = '#6366f1'; }

    try {
        const resp = await fetch(`${API_BASE}/api/value-investing/refresh`, { method: 'POST' });
        const text = await resp.text();
        let data = {};
        try { data = JSON.parse(text); } catch (_) { }
        if (!resp.ok || data?.ok === false) throw new Error(data?.message || text || 'Refresh failed');
        if (status) {
            status.textContent = `Updated ${data.stored || 0} candidates (scanned ${data.scanned || 0})`;
            status.style.color = '#22c55e';
        }
        loadValueInvesting();
    } catch (e) {
        if (status) {
            status.textContent = `Refresh failed: ${e.message}`;
            status.style.color = '#ef4444';
        }
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Refresh Fundamentals'; btn.style.opacity = '1'; }
    }
}

let _valueRows = [];
let _valueSortKey = 'score';
let _valueSortDir = 'desc';

async function loadValueInvesting() {
    const table = document.getElementById('value-table');
    const status = document.getElementById('value-scan-status');
    if (status && !status.textContent) status.textContent = 'Loading value candidates...';

    try {
        const resp = await fetch(`${API_BASE}/api/value-investing/stocks`);
        const rows = await resp.json();
        _valueRows = Array.isArray(rows) ? rows : [];
        renderValueTable(_valueRows, table);
        if (status && rows.length) {
            status.textContent = `Loaded ${rows.length} candidates`;
            status.style.color = '#22c55e';
        }
    } catch (e) {
        if (table) table.innerHTML = `<div class="p-6 text-center text-2xs" style="color:var(--text-muted)">Failed to load value candidates</div>`;
        if (status) {
            status.textContent = `Load failed: ${e.message}`;
            status.style.color = '#ef4444';
        }
    }
}

function renderValueTable(rows, table) {
    if (!table) return;
    if (!rows || !rows.length) {
        table.innerHTML = `<div class="p-6 text-center text-2xs" style="color:var(--text-muted)">No value candidates yet</div>`;
        return;
    }

    const fmt = n => n == null ? '-' : new Intl.NumberFormat('en-IN').format(Math.round(n));
    const pct = n => n != null && n !== 0 ? `${n.toFixed(1)}%` : '-';
    const num = n => n != null && n !== 0 ? n.toFixed(1) : '-';
    const sortIcon = key => _valueSortKey === key ? (_valueSortDir === 'asc' ? ' ↑' : ' ↓') : '';

    const sortedRows = [...rows].sort((a, b) => compareValueRows(a, b, _valueSortKey, _valueSortDir));

    const body = sortedRows.map(r => {
        const fv = r.fair_value || {};
        const range = fv.fair_value_low && fv.fair_value_high
            ? `₹${fv.fair_value_low} - ₹${fv.fair_value_high}`
            : '-';
        const upside = fv.upside_pct != null ? `${fv.upside_pct.toFixed(1)}%` : '-';
        const badge = fv.undervalued ? '<span class="text-2xs px-1 py-0.5 rounded" style="background:rgba(34,197,94,0.12);color:#22c55e">Undervalued</span>' : '';
        const dcf = r.mini_dcf || {};
        const dcfRange = dcf.dcf_low && dcf.dcf_high ? `₹${dcf.dcf_low} - ₹${dcf.dcf_high}` : '-';
        const dcfUpside = dcf.upside_pct != null ? `${dcf.upside_pct.toFixed(1)}%` : '-';
        const dcfBadge = dcf.undervalued ? '<span class="text-2xs px-1 py-0.5 rounded" style="background:rgba(59,130,246,0.12);color:#60a5fa">Undervalued</span>' : '';
        const ltp = r.ltp != null ? `₹${Number(r.ltp).toFixed(2)}` : '-';
        const ltpSrc = r.ltp_source ? ` <span class="text-2xs" style="color:var(--text-muted)">(${r.ltp_source})</span>` : '';
        return `
        <tr class="cursor-pointer" onclick="openValueDetail(${r.id})">
            <td class="font-medium">${r.symbol || '-'}</td>
            <td>${r.display_name || '-'}</td>
            <td>${r.sector || '-'}</td>
            <td>${r.score != null ? Math.round(r.score * 100) + '%' : '-'}</td>
            <td>${fmt(r.market_cap)}</td>
            <td>${ltp}${ltpSrc}</td>
            <td>${num(r.pe)}</td>
            <td>${num(r.roce)}</td>
            <td>${num(r.roe)}</td>
            <td>${num(r.debt_to_eq)}</td>
            <td>${pct(r.promoter_holding)}</td>
            <td>${range} ${badge}</td>
            <td>${upside}</td>
            <td>${dcfRange} ${dcfBadge}</td>
            <td>${dcfUpside}</td>
        </tr>
    `}).join('');

    table.innerHTML = `
        <table class="data-table" style="font-size:0.6rem">
            <thead>
                <tr>
                    <th onclick="sortValueTable('symbol')">Symbol${sortIcon('symbol')}</th>
                    <th onclick="sortValueTable('name')">Name${sortIcon('name')}</th>
                    <th onclick="sortValueTable('sector')">Sector${sortIcon('sector')}</th>
                    <th onclick="sortValueTable('score')">Score${sortIcon('score')}</th>
                    <th onclick="sortValueTable('market_cap')">Mcap (Cr)${sortIcon('market_cap')}</th>
                    <th onclick="sortValueTable('ltp')">LTP${sortIcon('ltp')}</th>
                    <th onclick="sortValueTable('pe')">PE${sortIcon('pe')}</th>
                    <th onclick="sortValueTable('roce')">ROCE${sortIcon('roce')}</th>
                    <th onclick="sortValueTable('roe')">ROE${sortIcon('roe')}</th>
                    <th onclick="sortValueTable('debt_to_eq')">Debt/Eq${sortIcon('debt_to_eq')}</th>
                    <th onclick="sortValueTable('promoter_holding')">Promoter${sortIcon('promoter_holding')}</th>
                    <th onclick="sortValueTable('fair_value')">Fair Value${sortIcon('fair_value')}</th>
                    <th onclick="sortValueTable('upside')">Upside${sortIcon('upside')}</th>
                    <th onclick="sortValueTable('dcf')">Mini DCF${sortIcon('dcf')}</th>
                    <th onclick="sortValueTable('dcf_upside')">DCF Upside${sortIcon('dcf_upside')}</th>
                </tr>
            </thead>
            <tbody>${body}</tbody>
        </table>
    `;
}

function sortValueTable(key) {
    if (_valueSortKey === key) {
        _valueSortDir = _valueSortDir === 'asc' ? 'desc' : 'asc';
    } else {
        _valueSortKey = key;
        _valueSortDir = ['symbol', 'name', 'sector'].includes(key) ? 'asc' : 'desc';
    }
    const table = document.getElementById('value-table');
    renderValueTable(_valueRows, table);
}

function compareValueRows(a, b, key, dir) {
    const numVal = v => {
        if (v == null || Number.isNaN(v)) {
            return dir === 'asc' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
        }
        return Number(v);
    };
    const strVal = v => (v || '').toString().toLowerCase();

    let va;
    let vb;

    switch (key) {
        case 'symbol':
            va = strVal(a.symbol);
            vb = strVal(b.symbol);
            return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
        case 'name':
            va = strVal(a.display_name);
            vb = strVal(b.display_name);
            return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
        case 'sector':
            va = strVal(a.sector);
            vb = strVal(b.sector);
            return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
        case 'fair_value': {
            const ua = a.fair_value?.undervalued ? 1 : 0;
            const ub = b.fair_value?.undervalued ? 1 : 0;
            if (ua !== ub) {
                return dir === 'asc' ? ua - ub : ub - ua;
            }
            va = numVal(a.fair_value?.fair_value_low);
            vb = numVal(b.fair_value?.fair_value_low);
            break;
        }
        case 'upside':
            va = numVal(a.fair_value?.upside_pct);
            vb = numVal(b.fair_value?.upside_pct);
            break;
        case 'dcf':
            va = numVal(a.mini_dcf?.dcf_low);
            vb = numVal(b.mini_dcf?.dcf_low);
            break;
        case 'dcf_upside':
            va = numVal(a.mini_dcf?.upside_pct);
            vb = numVal(b.mini_dcf?.upside_pct);
            break;
        default:
            va = numVal(a[key]);
            vb = numVal(b[key]);
    }

    return dir === 'asc' ? va - vb : vb - va;
}

async function openValueDetail(candidateId) {
    const panel = document.getElementById('value-detail-panel');
    const content = document.getElementById('value-detail-content');
    const loading = document.getElementById('value-detail-loading');
    const errorBox = document.getElementById('value-detail-error');
    const errorMsg = document.getElementById('value-detail-error-msg');

    if (panel) panel.classList.remove('hidden');
    if (content) content.classList.add('hidden');
    if (errorBox) errorBox.classList.add('hidden');
    if (loading) loading.classList.remove('hidden');

    try {
        const resp = await fetch(`${API_BASE}/api/value-investing/stocks/${candidateId}`);
        const text = await resp.text();
        let data = {};
        try { data = JSON.parse(text); } catch (_) { }
        if (!resp.ok) throw new Error(data?.detail || data?.message || text || 'Failed to load details');
        renderValueDetail(data);
    } catch (e) {
        if (errorMsg) errorMsg.textContent = `Failed to load: ${e.message}`;
        if (errorBox) errorBox.classList.remove('hidden');
    } finally {
        if (loading) loading.classList.add('hidden');
    }
}

function closeValueDetail() {
    const panel = document.getElementById('value-detail-panel');
    if (panel) panel.classList.add('hidden');
}

function renderValueDetail(data) {
    const content = document.getElementById('value-detail-content');
    const title = document.getElementById('value-detail-title');
    if (!content) return;

    const c = data.candidate || {};
    const flags = data.moat_flags || [];
    const reasons = data.undervalued_reasons || [];
    const tap = data.sources?.tapetide || {};
    const profile = tap.profile || {};
    const fundamentals = profile.fundamentals || {};
    const growth = profile.growth_metrics || {};
    const ratios = tap.ratios || {};
    const pl = tap.profit_loss || {};
    const fair = data.fair_value || {};
    const dcf = data.mini_dcf || {};
    const timeFair = data.time_to_fair || {};
    const ltpLabel = c.ltp != null ? `₹${Number(c.ltp).toFixed(2)}` : '-';
    const ltpSource = c.ltp_source ? ` (${c.ltp_source})` : '';

    if (title) title.textContent = `${c.symbol || ''} • Value Insight`;

    const metric = (label, value, suffix = '') => `
        <div class="flex items-center justify-between text-2xs py-1" style="border-bottom:1px solid var(--glass-border)">
            <span style="color:var(--text-muted)">${label}</span>
            <span style="color:var(--text-heading)">${value != null && value !== '' ? value : '-'}${suffix}</span>
        </div>`;

    const fmt = n => n != null ? new Intl.NumberFormat('en-IN').format(Math.round(n)) : '-';
    const pct = n => n != null ? `${Number(n).toFixed(1)}%` : '-';
    const num = n => n != null ? Number(n).toFixed(2) : '-';

    const moatHtml = flags.length
        ? flags.map(f => `<span class="text-2xs px-1.5 py-0.5 rounded-full" style="background:rgba(34,197,94,0.12);color:#22c55e">${f}</span>`).join(' ')
        : `<span class="text-2xs" style="color:var(--text-muted)">No moat flags yet</span>`;

    const ratioMetrics = ratios.metrics || {};
    const plMetrics = pl.metrics || {};

    content.innerHTML = `
        <div class="mb-3">
            <div class="flex flex-wrap gap-2 mb-2">${moatHtml}</div>
            <div class="grid grid-cols-2 gap-2 text-2xs">
                <div class="glass-card-sm p-2">
                    <div class="text-2xs font-semibold mb-1" style="color:var(--text-heading)">Score Breakdown</div>
                    ${metric('Overall', c.score != null ? Math.round(c.score * 100) + '%' : '-') }
                    ${metric('Valuation', c.valuation_score != null ? Math.round(c.valuation_score * 100) + '%' : '-') }
                    ${metric('Quality', c.quality_score != null ? Math.round(c.quality_score * 100) + '%' : '-') }
                    ${metric('Growth', c.growth_score != null ? Math.round(c.growth_score * 100) + '%' : '-') }
                    ${metric('Ownership', c.ownership_score != null ? Math.round(c.ownership_score * 100) + '%' : '-') }
                </div>
                <div class="glass-card-sm p-2">
                    <div class="text-2xs font-semibold mb-1" style="color:var(--text-heading)">Key Metrics</div>
                    ${metric('Market Cap (Cr)', fmt(c.market_cap))}
                    ${metric('LTP', `${ltpLabel}${ltpSource}`)}
                    ${metric('PE / PB', `${num(c.pe)} / ${num(c.pb)}`)}
                    ${metric('ROCE / ROE', `${num(c.roce)}% / ${num(c.roe)}%`)}
                    ${metric('Debt/Equity', num(c.debt_to_eq))}
                    ${metric('Operating Margin', num(c.operating_margin) + '%')}
                    ${metric('Revenue Growth', num(c.revenue_growth) + '%')}
                    ${metric('EPS Growth', num(c.eps_growth) + '%')}
                    ${metric('Promoter Holding', pct(c.promoter_holding))}
                    ${metric('Fair Value Range', fair.fair_value_low && fair.fair_value_high ? `₹${fair.fair_value_low} - ₹${fair.fair_value_high}` : '-')}
                    ${metric('Upside', fair.upside_pct != null ? fair.upside_pct.toFixed(1) + '%' : '-')}
                    ${metric('Mini DCF Range', dcf.dcf_low && dcf.dcf_high ? `₹${dcf.dcf_low} - ₹${dcf.dcf_high}` : '-')}
                    ${metric('DCF Upside', dcf.upside_pct != null ? dcf.upside_pct.toFixed(1) + '%' : '-')}
                </div>
            </div>
        </div>

        <div class="glass-card-sm p-2 mb-3">
            <div class="text-2xs font-semibold mb-1" style="color:var(--text-heading)">Valuation Formula</div>
            <div class="text-2xs" style="color:var(--text-muted)">
                <div style="margin-bottom:6px">
                    <strong>Fair Value (PE Range)</strong><br/>
                    EPS = LTP ÷ PE (when EPS not available)<br/>
                    Fair Value Low = EPS × PE Low<br/>
                    Fair Value High = EPS × PE High<br/>
                    ${fair.pe_low && fair.pe_high ? `PE Band = ${fair.pe_low} – ${fair.pe_high}` : ''}<br/>
                    ${c.ltp != null && c.pe != null ? `LTP ₹${Number(c.ltp).toFixed(2)} / PE ${Number(c.pe).toFixed(2)} → EPS ${c.ltp && c.pe ? (Number(c.ltp) / Number(c.pe)).toFixed(2) : '-'}` : ''}
                </div>
                <div>
                    <strong>Mini DCF</strong><br/>
                    EPS grows for 5 years (growth band ${dcf.growth_low || '-'}%–${dcf.growth_high || '-'}%)<br/>
                    Discount rate = 12%<br/>
                    Terminal value = Year‑5 EPS × 12 (terminal multiple)<br/>
                    ${dcf.dcf_low && dcf.dcf_high ? `DCF Range = ₹${dcf.dcf_low} – ₹${dcf.dcf_high}` : ''}
                </div>
            </div>
        </div>

        <div class="glass-card-sm p-2 mb-3">
            <div class="text-2xs font-semibold mb-1" style="color:var(--text-heading)">Estimated Time to Fair Value</div>
            <div class="text-2xs" style="color:var(--text-muted)">
                Best probable: <strong>${timeFair.best_years != null ? `${timeFair.best_years.toFixed(1)} yrs` : '-'}</strong><br/>
                ${timeFair.estimates ? `EPS growth: ${timeFair.estimates.eps_growth ?? '-'} yrs · Fixed: ${timeFair.estimates.fixed ?? '-'} yrs · DCF mid: ${timeFair.estimates.dcf_mid ?? '-'} yrs` : ''}
            </div>
        </div>

        <div class="glass-card-sm p-2 mb-3">
            <div class="text-2xs font-semibold mb-1" style="color:var(--text-heading)">Tapetide Fundamentals</div>
            <div class="text-2xs mb-2" style="color:var(--text-muted)">${profile.company?.about || 'No company summary available.'}</div>
            <div class="grid grid-cols-2 gap-2 text-2xs">
                <div>
                    ${metric('ROCE', num(fundamentals.roce) + '%')}
                    ${metric('ROE', num(fundamentals.roe) + '%')}
                    ${metric('Debt/Equity', num(fundamentals.debt_to_equity))}
                    ${metric('Dividend Yield', num(fundamentals.dividend_yield) + '%')}
                </div>
                <div>
                    ${metric('Revenue (Yr)', fmt(fundamentals.yearly_revenue))}
                    ${metric('Net Income', fmt(fundamentals.net_income))}
                    ${metric('Revenue Growth 1Y', num(fundamentals.revenue_growth_1y) + '%')}
                    ${metric('YoY Profit Growth', num(fundamentals.yoy_quarterly_profit_growth) + '%')}
                </div>
            </div>
            <div class="text-2xs mt-2" style="color:var(--text-muted)">Latest ratios (${ratios.latest_period || 'n/a'})</div>
            <div class="grid grid-cols-2 gap-2 text-2xs">
                <div>${metric('ROCE %', num(ratioMetrics['ROCE %']))}</div>
                <div>${metric('ROE %', num(ratioMetrics['ROE %']))}</div>
                <div>${metric('OPM %', num(ratioMetrics['OPM %']))}</div>
                <div>${metric('Net Profit %', num(ratioMetrics['Net Profit %']))}</div>
            </div>
        </div>

        <div class="glass-card-sm p-2 mb-3">
            <div class="text-2xs font-semibold mb-1" style="color:var(--text-heading)">Why It Looks Undervalued</div>
            <ul class="text-2xs" style="color:var(--text-muted);padding-left:14px;list-style:disc">
                ${(reasons.length ? reasons : ['No specific undervaluation cues available']).map(r => `<li>${r}</li>`).join('')}
            </ul>
        </div>

        <div class="glass-card-sm p-2 mb-3">
            <div class="text-2xs font-semibold mb-1" style="color:var(--text-heading)">Multi-source Signals</div>
            <div class="text-2xs" style="color:var(--text-muted)">Tickertape scorecard + Moneycontrol mini statements</div>
            <div class="grid grid-cols-2 gap-2 text-2xs mt-2">
                <div>
                    <div class="text-2xs font-semibold mb-1" style="color:var(--text-heading)">Tickertape</div>
                    <div style="color:var(--text-muted)">${tapetideSectionSummary(data.sources?.tickertape)}</div>
                </div>
                <div>
                    <div class="text-2xs font-semibold mb-1" style="color:var(--text-heading)">Moneycontrol</div>
                    <div style="color:var(--text-muted)">${tapetideSectionSummary(data.sources?.moneycontrol)}</div>
                </div>
            </div>
        </div>
    `;

    content.classList.remove('hidden');
}

function tapetideSectionSummary(section) {
    if (!section || section.error) return 'Not available';
    if (section.scorecard) return `${section.scorecard.length} scorecard rows`;
    if (section.overview || section.ratios) return 'Overview + ratios loaded';
    return 'Available';
}

async function loadSectorOptions() {
    try {
        const response = await fetch(`${API_BASE}/api/settings/sectors/all`);
        const sectors = await response.json();
        
        const ceSelect = document.getElementById('fno-ce-sectors');
        const peSelect = document.getElementById('fno-pe-sectors');
        
        // Clear existing options
        ceSelect.innerHTML = '';
        peSelect.innerHTML = '';
        
        // Add sector options sorted by score
        sectors.forEach(sector => {
            const option = document.createElement('option');
            option.value = sector.sector_name;
            option.textContent = `${sector.sector_name} (${sector.combined_score}%)`;
            
            // Add to both selects
            ceSelect.appendChild(option.cloneNode(true));
            peSelect.appendChild(option);
        });
        
    } catch (err) {
        console.error('Error loading sector options:', err);
    }
}

function getSelectedCustomSectors() {
    const ceSelect = document.getElementById('fno-ce-sectors');
    const peSelect = document.getElementById('fno-pe-sectors');
    
    const ceSectors = Array.from(ceSelect.selectedOptions).map(opt => opt.value);
    const peSectors = Array.from(peSelect.selectedOptions).map(opt => opt.value);
    
    return { ceSectors, peSectors };
}

function groupSignals(signals) {
    const bySecId = {};
    for (const s of signals) {
        if (!bySecId[s.security_id]) bySecId[s.security_id] = [];
        bySecId[s.security_id].push(s);
    }
    const groups = [];
    for (const secId of Object.keys(bySecId)) {
        const all = bySecId[secId].sort((a, b) => b.id - a.id);
        const latest = all[0];
        groups.push({ ...latest, _history: all.length > 1 ? all.slice(1) : null, _totalOccurrences: all.length });
    }
    groups.sort((a, b) => b.current_score - a.current_score);
    return groups;
}

async function loadFnoSignals() {
    const dirFilters = getSelectedPills('fno-dir-filter');
    const statusFilters = getSelectedPills('fno-status-filter');
    const scoreFilters = getSelectedPills('fno-score-filter');
    const minScore = scoreFilters.length ? Math.max(...scoreFilters.map(Number)) / 100 : 0;

    try {
        const response = await fetch(`${API_BASE}/api/signals/?section=fno`);
        let signals = await response.json();

        if (statusFilters.length) {
            signals = signals.filter(s => statusFilters.includes(s.status));
        }
        if (minScore > 0) {
            signals = signals.filter(s => s.current_score >= minScore);
        }

        const showCE = !dirFilters.length || dirFilters.includes('CE');
        const showPE = !dirFilters.length || dirFilters.includes('PE');

        const advSignals = signals.filter(s => isAdvDeclSignal(s.signal_type));
        const coreSignals = signals.filter(s => !isAdvDeclSignal(s.signal_type));

        const ceSignals = showCE ? coreSignals.filter(s => getSignalDirection(s.signal_type) === 'CE') : [];
        const peSignals = showPE ? coreSignals.filter(s => getSignalDirection(s.signal_type) === 'PE') : [];
        const manualCE = showCE ? coreSignals.filter(s => s.signal_type === 'manual') : [];
        const otherSignals = !dirFilters.length
            ? coreSignals.filter(s => !['CE', 'PE', 'manual'].includes(getSignalDirection(s.signal_type)))
            : [];

        const advCe = showCE ? advSignals.filter(s => getSignalDirection(s.signal_type) === 'CE') : [];
        const advPe = showPE ? advSignals.filter(s => getSignalDirection(s.signal_type) === 'PE') : [];

        const allCe = groupSignals([...ceSignals, ...manualCE, ...otherSignals]);
        const allPe = groupSignals([...peSignals]);
        const allAdvCe = groupSignals([...advCe]);
        const allAdvPe = groupSignals([...advPe]);

        const secIds = [...new Set(signals.map(s => s.security_id))];
        let cmpMap = {};
        if (secIds.length) {
            try {
                const cmpRes = await fetch(`${API_BASE}/api/signals/cmp`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({security_ids: secIds}),
                });
                cmpMap = await cmpRes.json();
            } catch (e) { }
        }

        renderFnoTable('fno-ce-table', allCe, cmpMap, 'CE');
        renderFnoTable('fno-pe-table', allPe, cmpMap, 'PE');
        renderFnoTable('fno-ad-ce-table', allAdvCe, cmpMap, 'CE', 'No CE Adv/Decl setups found');
        renderFnoTable('fno-ad-pe-table', allAdvPe, cmpMap, 'PE', 'No PE Adv/Decl setups found');
    } catch (err) {
        console.error('Error loading F&O signals:', err);
    }
}

function _fnoStatusBadge(s) {
    if (s.status === 'invalidated')
        return `<span class="text-2xs px-1 py-0.5 rounded" style="background:rgba(239,68,68,0.12);color:#ef4444" title="${s.invalidation_reason || ''}">✖</span>`;
    if (s.status === 'dismissed')
        return `<span class="text-2xs px-1 py-0.5 rounded" style="background:rgba(148,163,184,0.1);color:var(--text-muted)">dismissed</span>`;
    return '';
}

function _fnoActionBtns(s) {
    const isTracking = s.status === 'tracking';
    let btns = '';
    if (s.status === 'active' || s.status === 'tracking') {
        btns += `<button onclick="event.stopPropagation(); toggleTrack(${s.id})" class="text-2xs ${isTracking ? 'text-brand-500 font-bold' : 'hover:text-brand-500'}" style="${isTracking ? '' : 'color:var(--text-muted)'}" title="${isTracking ? 'Untrack' : 'Track'}">${isTracking ? '★' : '☆'}</button>`;
        btns += `<button onclick="event.stopPropagation(); dismissSignal(${s.id})" class="text-2xs hover:text-red-400 ml-1" style="color:var(--text-muted)" title="Dismiss">✕</button>`;
    }
    if (s.status === 'dismissed' || s.status === 'invalidated')
        btns += `<button onclick="event.stopPropagation(); reactivateSignal(${s.id})" class="text-2xs text-brand-500 hover:text-brand-400 font-medium" title="Reactivate">↩</button>`;
    return btns;
}

function toggleHistoryRows(secId) {
    const rows = document.querySelectorAll(`.history-row[data-parent="${secId}"]`);
    const chevron = document.querySelector(`.expand-chevron[data-sec="${secId}"]`);
    const visible = rows[0] && !rows[0].classList.contains('hidden');
    rows.forEach(r => r.classList.toggle('hidden', visible));
    if (chevron) chevron.classList.toggle('expanded', !visible);
}

function renderFnoTable(containerId, groups, cmpMap, direction, emptyMessage) {
    const emptyMsg = emptyMessage || (direction === 'CE' ? 'No CE setups found' : 'No PE setups found');

    if (!groups.length) {
        document.getElementById(containerId).innerHTML = `<div class="p-4 text-center text-2xs" style="color:var(--text-muted)">${emptyMsg}</div>`;
        return;
    }

    const rows = groups.map(s => {
        const scoreClass = s.current_score >= 0.7 ? 'score-high' :
                           s.current_score >= 0.5 ? 'score-medium' : 'score-low';
        const cmp = cmpMap[s.security_id];
        const cmpDisplay = cmp ? cmp.toFixed(2) : '-';
        const pctChange = (cmp && s.close_price_at_detection)
            ? ((cmp - s.close_price_at_detection) / s.close_price_at_detection * 100).toFixed(1)
            : null;
        const pctClass = pctChange > 0 ? 'text-profit' : pctChange < 0 ? 'text-loss' : '';
        const pctDisplay = pctChange !== null ? `<span class="${pctClass}" style="font-size:0.45rem">${pctChange > 0 ? '+' : ''}${pctChange}%</span>` : '';
        const isTracking = s.status === 'tracking';

        const typeBadge = s.signal_type === 'manual'
            ? `<span class="text-2xs px-1 py-0.5 rounded" style="background:var(--badge-manual-bg);color:var(--text-muted)">manual</span>`
            : isAdvDeclSignal(s.signal_type)
                ? `<span class="text-2xs px-1 py-0.5 rounded" style="background:rgba(14,116,144,0.15);color:#67e8f9">ADV/DECL</span>`
                : '';

        const hasHistory = s._history && s._history.length > 0;
        const occBadge = s._totalOccurrences > 1
            ? `<span class="occurrence-${Math.min(s._totalOccurrences, 3)} text-2xs px-1 py-0.5 rounded-full ml-1">${ordinal(s._totalOccurrences)}</span>`
            : '';
        const expandBtn = hasHistory
            ? `<span class="expand-chevron" data-sec="${s.security_id}" onclick="event.stopPropagation(); toggleHistoryRows('${s.security_id}')" title="${s._history.length} previous occurrence(s)">▶</span>`
            : '';

        const tipData = JSON.stringify({
            symbol: s.symbol, signal_type: s.signal_type, current_score: s.current_score,
            peak_score: s.peak_score, trend_score: s.trend_score, consol_score: s.consol_score,
            breakout_score: s.breakout_score, first_detected_date: s.first_detected_date,
        }).replace(/"/g, '&quot;');

        let html = `<tr class="cursor-pointer fno-primary-row" style="${isTracking ? 'background:var(--tracking-bg)' : ''}" onclick="viewSignalDetail(${s.id})">
            <td class="font-medium" style="color:var(--text-primary)">${expandBtn}${s.symbol}${occBadge} ${typeBadge} ${_fnoStatusBadge(s)}</td>
            <td style="color:var(--text-secondary)">${s.sector || '-'}</td>
            <td><span class="${scoreClass} text-2xs px-1 py-0.5 rounded-full score-tooltip-trigger"
                onmouseenter="showFnoScoreTooltip(event, ${tipData})"
                onmouseleave="hideScoreTooltip()"
                >${(s.current_score * 100).toFixed(0)}%</span></td>
            <td>${s.close_price_at_detection ? s.close_price_at_detection.toFixed(2) : '-'}</td>
            <td>${cmpDisplay} ${pctDisplay}</td>
            <td>${daysSince(s.first_detected_date)}d</td>
            <td>${_fnoActionBtns(s)}</td>
        </tr>`;

        if (hasHistory) {
            for (const h of s._history) {
                const hScore = h.current_score >= 0.7 ? 'score-high' : h.current_score >= 0.5 ? 'score-medium' : 'score-low';
                const hPct = (cmp && h.close_price_at_detection)
                    ? ((cmp - h.close_price_at_detection) / h.close_price_at_detection * 100).toFixed(1)
                    : null;
                const hPctClass = hPct > 0 ? 'text-profit' : hPct < 0 ? 'text-loss' : '';
                const hPctDisplay = hPct !== null ? `<span class="${hPctClass}" style="font-size:0.45rem">${hPct > 0 ? '+' : ''}${hPct}%</span>` : '';
                const hTipData = JSON.stringify({
                    symbol: h.symbol, signal_type: h.signal_type, current_score: h.current_score,
                    peak_score: h.peak_score, trend_score: h.trend_score, consol_score: h.consol_score,
                    breakout_score: h.breakout_score, first_detected_date: h.first_detected_date,
                }).replace(/"/g, '&quot;');

                html += `<tr class="history-row hidden" data-parent="${s.security_id}" onclick="viewSignalDetail(${h.id})">
                    <td style="padding-left:24px;color:var(--text-muted);font-size:0.5rem">
                        <span style="color:var(--text-muted);margin-right:3px">↳</span>${ordinal(h.occurrence_number)} ${_fnoStatusBadge(h)}
                    </td>
                    <td></td>
                    <td><span class="${hScore} text-2xs px-1 py-0.5 rounded-full score-tooltip-trigger"
                        onmouseenter="showFnoScoreTooltip(event, ${hTipData})"
                        onmouseleave="hideScoreTooltip()"
                        >${(h.current_score * 100).toFixed(0)}%</span></td>
                    <td style="font-size:0.5rem">${h.close_price_at_detection ? h.close_price_at_detection.toFixed(2) : '-'}</td>
                    <td style="font-size:0.5rem">${cmpDisplay} ${hPctDisplay}</td>
                    <td style="font-size:0.5rem">${daysSince(h.first_detected_date)}d</td>
                    <td>${_fnoActionBtns(h)}</td>
                </tr>`;
            }
        }
        return html;
    }).join('');

    document.getElementById(containerId).innerHTML = `
        <table class="data-table">
            <thead><tr>
                <th>Symbol</th><th>Sector</th><th>Score</th>
                <th>Entry Price</th><th>CMP</th><th>Days</th><th></th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table>`;
    applySortable(containerId);
}

async function toggleTrack(signalId) {
    try {
        await fetch(`${API_BASE}/api/signals/${signalId}/track`, { method: 'POST' });
        loadFnoSignals();
    } catch (e) {
        console.error('Track toggle failed:', e);
    }
}

async function runFnoScan() {
    return runFnoScanCore();
}

async function runFnoScanCore() {
    const btn = document.getElementById('btn-fno-scan-core');
    const statusEl = document.getElementById('fno-scan-status');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Scanning...';
    statusEl.textContent = 'Revalidating existing signals, then discovering new setups... This may take a few minutes.';
    statusEl.style.color = '#6366f1';

    try {
        let url = `${API_BASE}/api/settings/scan/run?section=fno&setup=core`;
        let requestOptions = { method: 'POST' };
        
        // If custom mode, send custom sectors
        if (fnoScanMode === 'custom') {
            const { ceSectors, peSectors } = getSelectedCustomSectors();
            
            if (ceSectors.length === 0 && peSectors.length === 0) {
                statusEl.textContent = 'Please select at least one sector for CE or PE';
                statusEl.style.color = '#ef4444';
                btn.disabled = false;
                btn.innerHTML = 'Scan F&O';
                return;
            }
            
            url = `${API_BASE}/api/settings/scan/run/custom`;
            requestOptions = {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    section: 'fno',
                    ce_sectors: ceSectors,
                    pe_sectors: peSectors
                })
            };
            
            statusEl.textContent = `Custom scan: CE sectors: ${ceSectors.join(', ')} | PE sectors: ${peSectors.join(', ')}`;
        }
        
        const response = await fetch(url, requestOptions);
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const responseText = await response.text();
        let data;
        try {
            data = JSON.parse(responseText);
        } catch (jsonError) {
            console.error('Failed to parse JSON response:', responseText);
            throw new Error(`Invalid JSON response: ${responseText.substring(0, 100)}...`);
        }
        const s = data.summary || {};
        const rv = s.revalidation || {};
        let parts = [];
        if (rv.revalidated) {
            parts.push(`Revalidated: ${rv.revalidated}`);
            if (rv.invalidated) parts.push(`Broken: ${rv.invalidated}`);
            if (rv.updated) parts.push(`Updated: ${rv.updated}`);
        }
        if (s.scanned) {
            parts.push(`New scan: ${s.scanned} stocks`);
            parts.push(`CE: ${s.ce_signals || 0}`);
            parts.push(`PE: ${s.pe_signals || 0}`);
        }
        const msg = parts.length ? parts.join(' | ') : (data.message || 'Scan complete');
        statusEl.textContent = msg;
        statusEl.style.color = '#22c55e';
        loadFnoSignals();
    } catch (err) {
        statusEl.textContent = `Scan failed: ${err.message}`;
        statusEl.style.color = '#ef4444';
    } finally {
        btn.disabled = false;
        btn.innerHTML = 'Scan Core';
    }
}

async function runFnoScanAdvDecl() {
    const btn = document.getElementById('btn-fno-scan-adv');
    const statusEl = document.getElementById('fno-advdecl-status');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Scanning...';
    if (statusEl) {
        statusEl.textContent = 'Computing breadth + momentum filters...';
        statusEl.style.color = '#6366f1';
    }

    try {
        const url = `${API_BASE}/api/settings/scan/run?section=fno&setup=advdecl`;
        const response = await fetch(url, { method: 'POST' });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        const responseText = await response.text();
        let data;
        try {
            data = JSON.parse(responseText);
        } catch (jsonError) {
            console.error('Failed to parse JSON response:', responseText);
            throw new Error(`Invalid JSON response: ${responseText.substring(0, 100)}...`);
        }

        const adv = data.summary?.advdecl_intraday || {};
        const ratio = adv.ad_ratio != null ? adv.ad_ratio : '-';
        const bias = adv.bias || 'neutral';
        const msg = `A/D ${ratio} (${adv.advancers || 0} / ${adv.decliners || 0}) • Bias ${bias.toUpperCase()} • Signals ${adv.signals || 0} • Scanned ${adv.scanned || 0}`;
        if (statusEl) {
            statusEl.textContent = msg;
            statusEl.style.color = adv.signals ? '#22c55e' : '#eab308';
        }
        loadFnoSignals();
    } catch (err) {
        if (statusEl) {
            statusEl.textContent = `Scan failed: ${err.message}`;
            statusEl.style.color = '#ef4444';
        }
    } finally {
        btn.disabled = false;
        btn.innerHTML = 'Scan Adv/Decl';
    }
}

let _schedulerPollTimer = null;
let _lastKnownScanTime = null;

async function loadSchedulerStatus() {
    try {
        const res = await fetch(`${API_BASE}/api/settings/scheduler/status`);
        const data = await res.json();
        const el = document.getElementById('fno-scheduler-status');
        if (!el) return;

        if (!data.running) {
            el.innerHTML = `<span style="width:6px;height:6px;border-radius:50%;background:#6b7280;display:inline-block"></span>
                <span style="color:var(--text-muted)">Auto-scan paused</span>
                <button onclick="toggleScheduler(true)" class="text-brand-500 hover:underline ml-1">Resume</button>`;
            if (_schedulerPollTimer) clearTimeout(_schedulerPollTimer);
            _schedulerPollTimer = setTimeout(loadSchedulerStatus, 15000);
            return;
        }

        const jobs = data.jobs || [];
        let nextRun = null;
        for (const j of jobs) {
            if (j.next_run) {
                const t = new Date(j.next_run);
                if (!nextRun || t < nextRun) nextRun = t;
            }
        }

        const nextStr = nextRun ? nextRun.toLocaleTimeString('en-IN', {hour: '2-digit', minute: '2-digit', hour12: true}) : '-';
        const lastStr = data.last_scan_time
            ? new Date(data.last_scan_time).toLocaleTimeString('en-IN', {hour: '2-digit', minute: '2-digit', hour12: true})
            : '-';

        let lastResult = '';
        if (data.last_scan_result && !data.last_scan_result.error) {
            const rv = data.last_scan_result.revalidation;
            if (rv && rv.invalidated) lastResult = ` (${rv.invalidated} invalidated)`;
        }

        el.innerHTML = `<span style="width:6px;height:6px;border-radius:50%;background:#22c55e;display:inline-block;animation:pulse 2s infinite"></span>
            <span>Auto-scan on &middot; Next: ${nextStr} &middot; Last: ${lastStr}${lastResult}</span>
            <button onclick="toggleScheduler(false)" style="color:var(--text-muted)" class="hover:text-red-400 ml-1" title="Pause auto-scan">\u23f8</button>`;

        if (data.last_scan_time && data.last_scan_time !== _lastKnownScanTime) {
            if (_lastKnownScanTime !== null) {
                const activeTab = document.querySelector('.nav-item.active')?.id?.replace('tab-', '');
                if (activeTab === 'fno') loadFnoSignals();
            }
            _lastKnownScanTime = data.last_scan_time;
        }

    } catch (e) {
        console.error('Scheduler status error:', e);
    }

    if (_schedulerPollTimer) clearTimeout(_schedulerPollTimer);
    _schedulerPollTimer = setTimeout(loadSchedulerStatus, 60000);
}

async function toggleScheduler(resume) {
    try {
        const endpoint = resume ? 'resume' : 'pause';
        await fetch(`${API_BASE}/api/settings/scheduler/${endpoint}`, { method: 'POST' });
        loadSchedulerStatus();
    } catch (e) {
        console.error('Scheduler toggle error:', e);
    }
}

function openFnoAddModal() {
    document.getElementById('fno-add-modal').classList.remove('hidden');
    document.getElementById('fno-add-search').value = '';
    document.getElementById('fno-add-results').innerHTML = '';
    document.getElementById('fno-add-search').focus();
}

function closeFnoAddModal() {
    document.getElementById('fno-add-modal').classList.add('hidden');
}

let fnoSearchTimeout;
function debounceSearchFno(query) {
    clearTimeout(fnoSearchTimeout);
    fnoSearchTimeout = setTimeout(() => searchFnoInstruments(query), 300);
}

async function searchFnoInstruments(query) {
    if (!query || query.length < 2) {
        document.getElementById('fno-add-results').innerHTML = '';
        return;
    }
    try {
        const response = await fetch(`${API_BASE}/api/settings/instruments/search?q=${encodeURIComponent(query)}`);
        const results = await response.json();
        const fnoResults = results.filter(r => r.is_fno);

        if (!fnoResults.length) {
            document.getElementById('fno-add-results').innerHTML = `<p class="text-2xs py-2" style="color:var(--text-muted)">No F&O stocks found.</p>`;
            return;
        }

        const rows = fnoResults.map(r => `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 4px;border-bottom:1px solid var(--border-light);cursor:pointer;border-radius:4px"
                 onmouseover="this.style.background='var(--bg-surface-hover)'" onmouseout="this.style.background=''"
                 onclick="addFnoStock('${r.security_id}', '${r.symbol}')">
                <div>
                    <span class="text-xs font-medium" style="color:var(--text-primary)">${r.symbol}</span>
                    <span class="text-2xs ml-1" style="color:var(--text-muted)">${r.display_name || ''}</span>
                </div>
                <span class="text-2xs text-brand-500 font-medium">+ Add</span>
            </div>`).join('');

        document.getElementById('fno-add-results').innerHTML = rows;
    } catch (err) {
        console.error('F&O search error:', err);
    }
}

async function addFnoStock(securityId, symbol) {
    const resultsEl = document.getElementById('fno-add-results');
    resultsEl.innerHTML = `<div class="py-2 text-center"><span class="spinner"></span> <span class="text-2xs" style="color:var(--text-muted)">Analyzing...</span></div>`;

    try {
        const response = await fetch(`${API_BASE}/api/signals/manual-add`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({security_id: securityId, symbol: symbol}),
        });
        const data = await response.json();

        closeFnoAddModal();
        loadFnoSignals();

        const statusEl = document.getElementById('fno-scan-status');
        const analysis = data.analysis;
        if (analysis) {
            const dir = analysis.direction || '?';
            const score = (analysis.score * 100).toFixed(0);
            statusEl.textContent = `Added ${symbol}: ${dir} setup, Score ${score}%`;
            statusEl.style.color = '#22c55e';
        } else {
            statusEl.textContent = `Added ${symbol} (manual, no clear directional setup detected)`;
            statusEl.style.color = '#eab308';
        }
    } catch (err) {
        resultsEl.innerHTML = `<p class="text-2xs text-red-400 py-2">Failed to add: ${err.message}</p>`;
    }
}

// --- Trades ---

async function loadTrades() {
    try {
        const [tradesRes, statsRes] = await Promise.all([
            fetch(`${API_BASE}/api/trades/`),
            fetch(`${API_BASE}/api/trades/stats`),
        ]);
        const trades = await tradesRes.json();
        const stats = await statsRes.json();

        document.getElementById('stat-total').textContent = stats.total_trades;
        document.getElementById('stat-winrate').textContent = `${stats.win_rate}%`;

        const pnlEl = document.getElementById('stat-pnl');
        pnlEl.textContent = formatCurrency(stats.total_pnl);
        pnlEl.className = `text-xl font-bold mt-0.5 ${stats.total_pnl >= 0 ? 'text-profit' : 'text-loss'}`;

        document.getElementById('stat-best').textContent = stats.best_trade != null ? formatCurrency(stats.best_trade) : '--';
        document.getElementById('stat-worst').textContent = stats.worst_trade != null ? formatCurrency(stats.worst_trade) : '--';

        if (!trades.length) {
            document.getElementById('trades-table').innerHTML = `
                <div class="p-10 text-center" style="color:var(--text-muted)">
                    <p class="text-sm mb-1">No trades logged yet</p>
                    <p class="text-xs">Click "+ New Trade" to log your first trade.</p>
                </div>`;
            return;
        }

        const statusColor = s => s === 'open' ? '#4ade80' : s === 'cancelled' ? '#a78bfa' : s === 'sl_hit' ? '#f87171' : s === 'target_hit' ? '#22c55e' : '#94a3b8';
        const statusBg = s => s === 'open' ? 'rgba(34,197,94,0.1)' : s === 'cancelled' ? 'rgba(168,85,247,0.1)' : s === 'sl_hit' ? 'rgba(239,68,68,0.1)' : s === 'target_hit' ? 'rgba(34,197,94,0.1)' : 'rgba(148,163,184,0.1)';

        const rows = trades.map(t => {
            const pnlClass = t.pnl > 0 ? 'text-profit' : t.pnl < 0 ? 'text-loss' : '';
            const strikeInfo = t.trade_type === 'option' ? `${t.strike_price || ''} ${t.option_type || ''}` : '';
            const isOpen = t.status === 'open';
            return `<tr id="trade-row-${t.id}">
                <td class="font-medium" style="color:var(--text-primary)">
                    ${t.symbol}
                    ${strikeInfo ? `<div style="font-size:0.55rem;color:var(--text-secondary)">${strikeInfo} · ${t.expiry_date || ''}</div>` : ''}
                </td>
                <td><span class="text-2xs px-1.5 py-0.5 rounded-full" style="background:${t.trade_type === 'option' ? 'rgba(168,85,247,0.12)' : 'rgba(59,130,246,0.12)'};color:${t.trade_type === 'option' ? '#a78bfa' : '#60a5fa'}">${t.trade_type}</span></td>
                <td class="trade-editable" data-trade-id="${t.id}" data-field="entry_price" data-type="number">${t.entry_price || '-'}</td>
                <td class="trade-editable" data-trade-id="${t.id}" data-field="exit_price" data-type="number">${t.exit_price || '-'}</td>
                <td class="trade-editable" data-trade-id="${t.id}" data-field="sl_price" data-type="number">${t.sl_price || '-'}</td>
                <td class="trade-editable" data-trade-id="${t.id}" data-field="quantity" data-type="number">${t.quantity || '-'}</td>
                <td class="${pnlClass} font-medium">${t.pnl != null ? formatCurrency(t.pnl) : '-'}</td>
                <td>${t.entry_date || '-'}</td>
                <td>
                    <span style="background:${statusBg(t.status)};color:${statusColor(t.status)}" class="text-2xs px-1.5 py-0.5 rounded-full">${t.status}</span>
                </td>
                <td style="white-space:nowrap">
                    ${isOpen ? `<button onclick="_journalCancel(${t.id})" title="Cancel" style="background:none;border:none;color:#fbbf24;cursor:pointer;font-size:0.6rem;padding:2px 4px">Cancel</button>` : ''}
                    <button onclick="_journalEdit(${t.id})" title="Edit" style="background:none;border:none;color:#a5b4fc;cursor:pointer;font-size:0.6rem;padding:2px 4px">Edit</button>
                    <button onclick="_journalDelete(${t.id})" title="Delete" style="background:none;border:none;color:#f87171;cursor:pointer;font-size:0.6rem;padding:2px 4px">Delete</button>
                </td>
            </tr>`;
        }).join('');

        document.getElementById('trades-table').innerHTML = `
            <table class="data-table">
                <thead><tr>
                    <th>Symbol</th><th>Type</th><th>Entry</th><th>Exit</th>
                    <th>SL</th><th>Qty</th><th>P&L</th><th>Date</th><th>Status</th><th>Actions</th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table>`;
        applySortable('trades-table');
    } catch (err) {
        console.error('Error loading trades:', err);
    }
}

function openTradeModal() {
    alert('Use the Stock Options tab to place trades via the analysis panel.');
}

async function _journalCancel(tradeId) {
    if (!confirm('Mark this trade as cancelled?')) return;
    try {
        await fetch(`${API_BASE}/api/trades/${tradeId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'cancelled' }),
        });
        loadTrades();
    } catch (e) { alert('Error: ' + e.message); }
}

async function _journalDelete(tradeId) {
    if (!confirm('Permanently delete this trade record?')) return;
    try {
        await fetch(`${API_BASE}/api/trades/${tradeId}`, { method: 'DELETE' });
        loadTrades();
    } catch (e) { alert('Error: ' + e.message); }
}

function _journalEdit(tradeId) {
    const row = document.getElementById(`trade-row-${tradeId}`);
    if (!row) return;

    const editables = row.querySelectorAll('.trade-editable');
    const alreadyEditing = row.querySelector('.trade-edit-input');
    if (alreadyEditing) return;

    editables.forEach(td => {
        const field = td.dataset.field;
        const currentVal = td.textContent.trim();
        const val = currentVal === '-' ? '' : currentVal;
        td.dataset.originalValue = currentVal;
        td.innerHTML = `<input type="number" step="0.01" class="trade-edit-input" value="${val}"
            style="width:60px;padding:2px 4px;border-radius:4px;border:1px solid var(--glass-border);background:var(--glass-bg);color:var(--text-primary);font-size:0.65rem" />`;
    });

    // Change Edit button to Save
    const editBtn = row.querySelector('[title="Edit"]');
    if (editBtn) {
        editBtn.textContent = 'Save';
        editBtn.title = 'Save';
        editBtn.style.color = '#4ade80';
        editBtn.style.fontWeight = '700';
        editBtn.onclick = () => _journalSave(tradeId);
    }
}

async function _journalSave(tradeId) {
    const row = document.getElementById(`trade-row-${tradeId}`);
    if (!row) return;

    const updates = {};
    row.querySelectorAll('.trade-editable').forEach(td => {
        const input = td.querySelector('.trade-edit-input');
        if (input) {
            const val = input.value.trim();
            const field = td.dataset.field;
            if (val !== '' && val !== td.dataset.originalValue) {
                updates[field] = parseFloat(val);
            }
        }
    });

    if (Object.keys(updates).length === 0) {
        loadTrades();
        return;
    }

    try {
        await fetch(`${API_BASE}/api/trades/${tradeId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates),
        });
        loadTrades();
    } catch (e) { alert('Error: ' + e.message); }
}

// --- Settings: shared UI helpers ---

const ST_ICONS = {
    ok: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></svg>',
    warn: '<svg viewBox="0 0 24 24"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
    err: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/></svg>',
    info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/></svg>',
    eye: '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>',
    eyeOff: '<svg viewBox="0 0 24 24"><path d="M9.9 4.2A10 10 0 0 1 12 4c6.4 0 10 8 10 8a17 17 0 0 1-2.2 3.2M6.6 6.6C3.6 8.5 2 12 2 12s3.6 8 10 8a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="m2 2 20 20"/></svg>',
};

function stEsc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
}

/** Render an inline alert into element `id`. `html` must already be escaped. */
function stAlert(id, kind, html) {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = html ? `<div class="st-alert st-alert--${kind}">${ST_ICONS[kind] || ''}<div>${html}</div></div>` : '';
}

/** Put a button into a busy state; returns a function that restores it. */
function stBusy(btn, label) {
    if (!btn) return () => {};
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>${stEsc(label)}`;
    return () => { btn.disabled = false; btn.innerHTML = original; };
}

function stKv(items) {
    return items.map(([label, value, tone]) => `
        <div class="st-kv-item">
            <span class="st-kv-label">${stEsc(label)}</span>
            <span class="st-kv-value${tone ? ` st-kv-value--${tone}` : ''}" title="${stEsc(value)}">${stEsc(value)}</span>
        </div>`).join('');
}

function stTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

async function stFetchJson(url, options) {
    const response = await fetch(url, options);
    let data = null;
    try { data = await response.json(); } catch (_) { /* non-JSON body */ }
    if (!response.ok) {
        const detail = (data && (data.detail || data.message)) || `HTTP ${response.status}`;
        throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
    }
    return data;
}

// Connection pill in the page header, derived from credentials + token state.
const _stConn = { credentials: null, token: null };
function updateConnectionPill() {
    const pill = document.getElementById('st-conn-pill');
    if (!pill) return;
    const { credentials, token } = _stConn;
    let kind = '', text = 'Checking connection…';
    if (credentials !== null && token !== null) {
        if (token) { kind = 'ok'; text = 'Access token loaded'; }
        else if (credentials) { kind = 'warn'; text = 'Credentials saved · no token yet'; }
        else { kind = 'err'; text = 'Not connected to Dhan'; }
    }
    pill.className = `st-pill${kind ? ` st-pill--${kind}` : ''}`;
    pill.innerHTML = `<span class="st-dot"></span>${stEsc(text)}`;
}

function loadSettingsTab() {
    loadCredentialsStatus();
    loadTokenStatus();
    loadBackups();
}

// --- Settings: maintenance ---

async function resetSignals() {
    if (!confirm('Delete ALL scanner signals and their history?\n\nJournal trades are kept. This cannot be undone.')) return;
    const restore = stBusy(document.getElementById('btn-reset-signals'), 'Resetting…');
    try {
        const data = await stFetchJson(`${API_BASE}/api/settings/reset/signals`, { method: 'POST' });
        stAlert('reset-status', 'ok',
            `Deleted <strong>${stEsc(data.deleted_signals)}</strong> signals and <strong>${stEsc(data.deleted_history)}</strong> history records.`);
    } catch (err) {
        stAlert('reset-status', 'err', `Reset failed: ${stEsc(err.message)}`);
    } finally {
        restore();
    }
}

async function refreshInstruments() {
    const restore = stBusy(document.getElementById('btn-refresh-instruments'), 'Refreshing…');
    stAlert('instruments-status', 'info', 'Downloading the scrip master from Dhan. This can take a minute…');
    try {
        const d = await stFetchJson(`${API_BASE}/api/settings/instruments/refresh`, { method: 'POST' });
        stAlert('instruments-status', 'ok',
            `<strong>${stEsc(d.total_equity)}</strong> stocks · <strong>${stEsc(d.fno_symbols)}</strong> F&amp;O symbols`
            + `<small>${stEsc(d.added)} new, ${stEsc(d.updated)} updated`
            + (d.constituents ? ` · sector lists: ${stEsc(d.constituents.updated_sectors)} of ${stEsc(d.constituents.total_sectors)} indices updated from NSE`
                + (d.constituents.failed_sectors?.length ? ` (kept previous for ${stEsc(d.constituents.failed_sectors.join(', '))})` : '') : '')
            + `</small>`);
    } catch (err) {
        stAlert('instruments-status', 'err', `Refresh failed: ${stEsc(err.message)}`);
    } finally {
        restore();
    }
}

async function createBackup() {
    const restore = stBusy(document.getElementById('btn-backup-now'), 'Backing up…');
    try {
        const d = await stFetchJson(`${API_BASE}/api/settings/backup/now`, { method: 'POST' });
        stAlert('backup-status', 'ok', `Backup created: <strong>${stEsc(d.filename)}</strong><small>${stEsc(d.size_mb)} MB</small>`);
        loadBackups();
    } catch (err) {
        stAlert('backup-status', 'err', `Backup failed: ${stEsc(err.message)}`);
    } finally {
        restore();
    }
}

async function exportCSV() {
    const restore = stBusy(document.getElementById('btn-export-csv'), 'Exporting…');
    try {
        const d = await stFetchJson(`${API_BASE}/api/settings/backup/export-csv`, { method: 'POST' });
        stAlert('backup-status', 'ok', `Trades exported<small>${stEsc(d.path)}</small>`);
    } catch (err) {
        stAlert('backup-status', 'err', `Export failed: ${stEsc(err.message)}`);
    } finally {
        restore();
    }
}

async function loadBackups() {
    const list = document.getElementById('backup-list');
    if (!list) return;
    try {
        const backups = await stFetchJson(`${API_BASE}/api/settings/backup/list`);
        if (!backups.length) {
            list.innerHTML = '<div class="st-empty">No backups yet. Create one before risky changes.</div>';
            return;
        }
        const rows = backups.slice(0, 15).map(b => `
            <div class="st-row">
                <div class="st-row-main">
                    <div class="st-row-title st-row-title--mono">${stEsc(b.filename)}</div>
                    <div class="st-row-meta">${stEsc(b.created_at)} · ${stEsc(b.size_mb)} MB</div>
                </div>
                <button type="button" class="st-btn st-btn--ghost st-btn--sm" data-backup="${stEsc(b.filename)}"
                    onclick="restoreBackup(this.dataset.backup)">Restore</button>
            </div>`).join('');
        list.innerHTML = `<div class="st-list-head">Recent backups (${backups.length})</div>${rows}`;
    } catch (err) {
        list.innerHTML = `<div class="st-empty">Could not load backups: ${stEsc(err.message)}</div>`;
    }
}

async function restoreBackup(filename) {
    if (!confirm(`Restore the database from ${filename}?\n\nA safety copy of the current database is taken first.`)) return;
    try {
        const d = await stFetchJson(
            `${API_BASE}/api/settings/backup/restore?filename=${encodeURIComponent(filename)}`, { method: 'POST' });
        stAlert('backup-status', 'ok', `Restored from <strong>${stEsc(d.restored_from)}</strong><small>Reload the page to see restored data.</small>`);
        loadBackups();
    } catch (err) {
        stAlert('backup-status', 'err', `Restore failed: ${stEsc(err.message)}`);
    }
}

let searchTimeout;
function debounceSearch(query) {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => searchInstruments(query), 300);
}

async function searchInstruments(query) {
    const box = document.getElementById('search-results');
    if (!box) return;
    if (!query || query.trim().length < 2) {
        box.innerHTML = '';
        return;
    }
    try {
        const results = await stFetchJson(`${API_BASE}/api/settings/instruments/search?q=${encodeURIComponent(query.trim())}`);
        if (!results.length) {
            box.innerHTML = '<div class="st-empty">No instruments match that search.</div>';
            return;
        }
        box.innerHTML = results.map(r => `
            <div class="st-row">
                <div class="st-row-main">
                    <div class="st-row-title">${stEsc(r.symbol)}${r.is_fno ? '<span class="st-badge">F&amp;O</span>' : ''}</div>
                    <div class="st-row-meta">${stEsc(r.display_name || '')}</div>
                </div>
                <div class="st-row-side">${stEsc(r.security_id)}${r.is_fno && r.lot_size ? ` · lot ${stEsc(r.lot_size)}` : ''}</div>
            </div>`).join('');
    } catch (err) {
        box.innerHTML = `<div class="st-empty">Search failed: ${stEsc(err.message)}</div>`;
    }
}

// --- Utilities ---

function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function daysSince(dateStr) {
    if (!dateStr) return 0;
    const now = new Date();
    let d = null;

    if (typeof dateStr === 'string') {
        const dateOnly = dateStr.split('T')[0];
        const parts = dateOnly.split('-');
        if (parts.length === 3) {
            const year = Number(parts[0]);
            const month = Number(parts[1]);
            const day = Number(parts[2]);
            if (!Number.isNaN(year) && !Number.isNaN(month) && !Number.isNaN(day)) {
                d = new Date(year, month - 1, day);
            }
        }
    }

    if (!d) {
        d = new Date(dateStr);
    }

    if (Number.isNaN(d.getTime())) return 0;

    const diffDays = Math.floor((now - d) / (1000 * 60 * 60 * 24));
    return Math.max(0, diffDays);
}

function formatCurrency(amount) {
    if (amount == null) return '--';
    const prefix = amount >= 0 ? '+' : '';
    return prefix + new Intl.NumberFormat('en-IN', {
        style: 'currency', currency: 'INR', maximumFractionDigits: 0
    }).format(amount);
}

// --- VCP Scanner Functions ---

function showVcpInfo() {
    const panel = document.getElementById('vcp-info-panel');
    if (panel) {
        panel.classList.remove('hidden');
    }
}

function toggleVcpInfo() {
    const panel = document.getElementById('vcp-info-panel');
    if (panel) {
        panel.classList.toggle('hidden');
    }
}

function loadSwingSignalsWithVcpFilters() {
    const statusFilters = getSelectedPills('swing-status-filter');
    const scoreFilters = getSelectedPills('swing-score-filter');
    
    // Apply VCP-specific filtering
    loadSignals('swing', { statusFilters, scoreFilters });
}

async function runSwingScan() {
    const btn = document.getElementById('btn-swing-scan');
    const statusEl = document.getElementById('swing-scan-status');
    const originalText = btn.innerHTML;
    
    // Show loading state
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Scanning...';
    
    if (statusEl) {
        statusEl.textContent = 'Running VCP scan... This may take a few minutes.';
        statusEl.style.color = '#6366f1';
    }
    
    try {
        // Run the swing scan
        const response = await fetch(`${API_BASE}/api/settings/scan/run?section=swing`, { method: 'POST' });
        const data = await response.json();
        
        // Check if response indicates an error
        if (data.error) {
            throw new Error(data.message || 'Scan failed');
        }
        
        const s = data.summary || {};
        
        // Show success feedback with scan results
        let resultMsg = '✓ Scan Complete';
        let statusMsg = data.message || 'Scan completed successfully';
        
        if (s.scanned) {
            resultMsg = `✓ Found ${s.vcp_signals || 0} VCP`;
            statusMsg = `Scanned ${s.scanned} stocks, found ${s.vcp_signals || 0} VCP patterns`;
            if (s.chartink_matches) statusMsg += ` (${s.chartink_matches} passed Chartink filters)`;
        }
        
        btn.innerHTML = resultMsg;
        
        if (statusEl) {
            statusEl.textContent = statusMsg;
            statusEl.style.color = '#22c55e';
        }
        
        // Reload the signals to show new results
        await loadSignals('swing');
        
        // Reset button after delay
        setTimeout(() => {
            btn.innerHTML = originalText;
            btn.disabled = false;
            if (statusEl) {
                statusEl.textContent = '';
            }
        }, 5000);
        
    } catch (error) {
        console.error('Error running swing scan:', error);
        btn.innerHTML = '✗ Scan Failed';
        
        if (statusEl) {
            statusEl.textContent = `Scan failed: ${error.message}`;
            statusEl.style.color = '#ef4444';
        }
        
        setTimeout(() => {
            btn.innerHTML = originalText;
            btn.disabled = false;
            if (statusEl) {
                statusEl.textContent = '';
            }
        }, 5000);
    }
}

async function refreshSwingSignals() {
    const btn = document.getElementById('btn-refresh-swing');
    const originalText = btn.innerHTML;
    
    // Show loading state
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Refreshing...';
    
    try {
        // Reload signals with current filters
        await loadSignals('swing');
        
        // Show success feedback briefly
        btn.innerHTML = '✓ Refreshed';
        setTimeout(() => {
            btn.innerHTML = originalText;
            btn.disabled = false;
        }, 1000);
        
    } catch (error) {
        console.error('Error refreshing signals:', error);
        btn.innerHTML = '✗ Error';
        setTimeout(() => {
            btn.innerHTML = originalText;
            btn.disabled = false;
        }, 2000);
    }
}

// Enhanced signal rendering for VCP patterns
function renderVcpSignal(signal) {
    const vcpBadge = signal.signal_type === 'VCP' 
        ? `<span class="text-2xs px-1.5 py-0.5 rounded-full" style="background:rgba(34,197,94,0.12);color:#22c55e;margin-left:4px">VCP</span>`
        : '';
    
    const contractionInfo = signal.contraction_score 
        ? `<div class="text-2xs mt-1" style="color:var(--text-muted)">Contraction: ${(signal.contraction_score * 100).toFixed(0)}% • Volume: ${(signal.breakout_score * 100).toFixed(0)}%</div>`
        : '';
    
    return { vcpBadge, contractionInfo };
}

// --- Initialize ---
function startApp() {
    initTheme();
    initSidebar();
    initTabOrder();
    loadPnlGuardStatus();
    applyRoleAccess();
    switchTab(firstNavTab());
}

document.addEventListener('DOMContentLoaded', async () => {
    const ok = await initAuth();
    if (ok) startApp();
    
    // Make functions globally available for testing
    window.testCredentials = testCredentials;
    window.togglePassword = togglePassword;
    window.saveCredentials = saveCredentials;
    window.clearCredentials = clearCredentials;
    window.getCredentialsFromForm = getCredentialsFromForm;
    window.loadCredentialsStatus = loadCredentialsStatus;
    window.generateTokenNow = generateTokenNow;
    window.loginAppUser = loginAppUser;
    window.logoutAppUser = logoutAppUser;
    
});

// ── Settings: Dhan credentials & access token ──

function togglePassword(inputId) {
    const input = document.getElementById(inputId);
    const button = input && input.parentElement.querySelector('.toggle-password');
    if (!input || !button) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    button.innerHTML = show ? ST_ICONS.eyeOff : ST_ICONS.eye;
    button.setAttribute('aria-label', show ? 'Hide value' : 'Show value');
}

async function loadCredentialsStatus() {
    const listDiv = document.getElementById('credentialsList');
    if (!listDiv) return;
    try {
        const data = await stFetchJson(`${API_BASE}/api/settings/credentials/status`);
        _stConn.credentials = !!data.configured;
        if (data.configured) {
            const raw = data.credentials || {};
            // Collapse long mask runs: "*****************demo" -> "••••demo"
            const c = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v ?? '').replace(/\*+/g, '••••')]));
            listDiv.innerHTML = stKv([
                ['Client ID', c.client_id || '—'],
                ['API key', c.api_key || '—'],
                ['API secret', c.api_secret || '—'],
                ['PIN', c.pin || '—'],
                ['TOTP secret', c.totp_secret || '—'],
            ]);
            const setVal = (id, v) => { const el = document.getElementById(id); if (el && !el.value) el.value = v || ''; };
            setVal('clientId', c.client_id);
            const ph = (id, v) => {
                const el = document.getElementById(id);
                if (!el || !v) return;
                if (!el.dataset.ph) el.dataset.ph = el.placeholder;
                el.placeholder = 'Saved · re-enter to change';
            };
            ph('apiKey', c.api_key);
            ph('apiSecret', c.api_secret);
            ph('dhanPin', c.pin);
            ph('totpSecret', c.totp_secret);
            stAlert('credentialsStatus', '', '');
        } else {
            listDiv.innerHTML = '';
            stAlert('credentialsStatus', 'warn',
                '<strong>No credentials saved.</strong><small>Enter all five fields and save to enable automatic token generation.</small>');
        }
    } catch (err) {
        _stConn.credentials = false;
        stAlert('credentialsStatus', 'err', `Could not load credentials: ${stEsc(err.message)}`);
    }
    updateConnectionPill();
}

async function loadTokenStatus() {
    const box = document.getElementById('st-token-state');
    if (!box) return;
    try {
        const d = await stFetchJson(`${API_BASE}/api/settings/token/status`);
        const last = d.last || {};
        _stConn.token = !!d.has_token;
        const methodNames = { renew: 'RenewToken', totp_ui: 'TOTP · saved', totp_env: 'TOTP · env' };
        box.innerHTML = stKv([
            ['Token', d.has_token ? 'Loaded' : 'Missing', d.has_token ? 'ok' : 'err'],
            ['Last renewal', last.at ? stTime(last.at) : 'Not this session'],
            ['Method', methodNames[last.method] || (last.action === 'failed' ? 'Failed' : '—'), last.action === 'failed' ? 'err' : ''],
            ['Auto renewal', 'Daily 06:00 IST'],
        ]);
    } catch (err) {
        _stConn.token = false;
        box.innerHTML = '';
        stAlert('token-status', 'err', `Could not load token status: ${stEsc(err.message)}`);
    }
    updateConnectionPill();
}

function getCredentialsFromForm() {
    const val = id => (document.getElementById(id)?.value || '').trim();
    const creds = {
        client_id: val('clientId'),
        api_key: val('apiKey'),
        api_secret: val('apiSecret'),
        pin: val('dhanPin'),
        totp_secret: val('totpSecret'),
    };
    const labels = { client_id: 'Client ID', api_key: 'API key', api_secret: 'API secret', pin: 'PIN', totp_secret: 'TOTP secret' };
    const missing = Object.keys(creds).filter(k => !creds[k]).map(k => labels[k]);
    if (missing.length) {
        stAlert('credentialsStatus', 'err', `Please fill in: <strong>${stEsc(missing.join(', '))}</strong>`);
        return null;
    }
    if (!/^\d{6}$/.test(creds.pin)) {
        stAlert('credentialsStatus', 'err', '<strong>PIN must be exactly 6 digits.</strong>');
        return null;
    }
    return creds;
}

async function testCredentials() {
    const credentials = getCredentialsFromForm();
    if (!credentials) return;
    const restore = stBusy(document.getElementById('btn-test-credentials'), 'Testing…');
    stAlert('credentialsStatus', 'info', 'Checking credential format and TOTP secret…');
    try {
        const data = await stFetchJson(`${API_BASE}/api/settings/credentials/test`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials),
        });
        if (data.success) {
            stAlert('credentialsStatus', 'ok',
                '<strong>Looks good.</strong> The TOTP secret generates valid codes.<small>Save to use these credentials.</small>');
        } else {
            stAlert('credentialsStatus', 'err', `<strong>Validation failed.</strong> ${stEsc(data.message || 'Unknown error')}`);
        }
    } catch (err) {
        stAlert('credentialsStatus', 'err', `Test failed: ${stEsc(err.message)}`);
    } finally {
        restore();
    }
}

async function saveCredentials() {
    const credentials = getCredentialsFromForm();
    if (!credentials) return;
    const restore = stBusy(document.getElementById('btn-save-credentials'), 'Saving…');
    try {
        const data = await stFetchJson(`${API_BASE}/api/settings/credentials/save`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials),
        });
        if (data.success) {
            ['apiSecret', 'dhanPin', 'totpSecret'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
            await loadCredentialsStatus();
            stAlert('credentialsStatus', 'ok', `<strong>Saved.</strong> ${stEsc(data.message || '')}`);
        } else {
            stAlert('credentialsStatus', 'err', stEsc(data.message || 'Save failed'));
        }
    } catch (err) {
        stAlert('credentialsStatus', 'err', `Save failed: ${stEsc(err.message)}`);
    } finally {
        restore();
    }
}

async function clearCredentials() {
    if (!confirm('Delete the saved Dhan credentials and access token from this machine?\n\nAutomatic token renewal stops until you save them again.')) return;
    const restore = stBusy(document.getElementById('btn-clear-credentials'), 'Clearing…');
    try {
        const data = await stFetchJson(`${API_BASE}/api/settings/credentials/clear`, { method: 'POST' });
        if (data.success) {
            ['clientId', 'apiKey', 'apiSecret', 'dhanPin', 'totpSecret'].forEach(id => {
                const el = document.getElementById(id);
                if (el) { el.value = ''; if (el.dataset.ph) el.placeholder = el.dataset.ph; }
            });
            await loadCredentialsStatus();
            await loadTokenStatus();
        } else {
            stAlert('credentialsStatus', 'err', stEsc(data.message || 'Clear failed'));
        }
    } catch (err) {
        stAlert('credentialsStatus', 'err', `Clear failed: ${stEsc(err.message)}`);
    } finally {
        restore();
    }
}

async function _runTokenAction(btnId, busyLabel, url) {
    const restore = stBusy(document.getElementById(btnId), busyLabel);
    stAlert('token-status', 'info', 'Contacting Dhan…');
    try {
        const data = await stFetchJson(url, { method: 'POST' });
        if (data.success) {
            stAlert('token-status', 'ok', `<strong>${stEsc(data.message || 'Done')}</strong><small>${stEsc(new Date().toLocaleTimeString())}</small>`);
        } else {
            stAlert('token-status', 'err', `<strong>Failed.</strong> ${stEsc(data.message || 'See server logs')}`);
        }
    } catch (err) {
        stAlert('token-status', 'err', `Request failed: ${stEsc(err.message)}`);
    } finally {
        restore();
        loadTokenStatus();
    }
}

function generateTokenNow() {
    return _runTokenAction('btn-generate-token', 'Generating…', `${API_BASE}/api/settings/credentials/generate-token`);
}

function refreshDhanToken() {
    return _runTokenAction('btn-refresh-token', 'Renewing…', `${API_BASE}/api/settings/token/refresh`);
}

// ── TechnoFunda Analysis tab ──
// Search an NSE stock → /api/techno-funda/analyze/{symbol} → structured report
// (Summary · Fundamental · Technical · Business & News). Rendering only; all analysis is server-side.

const TF_RECENT_KEY = 'tf-recent';
const TF_VIEW_KEY = 'tf-view';
let _tfReport = null;
let _tfView = (() => { try { return localStorage.getItem(TF_VIEW_KEY) || 'summary'; } catch (_) { return 'summary'; } })();
let _tfSuggest = [];
let _tfActive = -1;
let _tfSearchTimer = null;
let _tfSearchSeq = 0;
let _tfChart = null;
let _tfInitDone = false;
let _tfLoadingSymbol = null;

const tfEsc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function tfNum(v, nd = 2) {
    if (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) return '—';
    return Number(v).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: nd });
}
function tfRs(v, nd = 2) { return v === null || v === undefined ? '—' : '₹' + tfNum(v, nd); }
function tfPct(v, nd = 1, signed = false) {
    if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
    const n = Number(v);
    return (signed && n > 0 ? '+' : '') + n.toFixed(nd) + '%';
}
function tfCr(v) {
    if (v === null || v === undefined) return '—';
    const n = Number(v);
    if (Math.abs(n) >= 100000) return '₹' + (n / 100000).toLocaleString('en-IN', { maximumFractionDigits: 2 }) + ' L Cr';
    return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 }) + ' Cr';
}
function tfTone(v) { return v === null || v === undefined ? '' : (Number(v) > 0 ? 'tf-pos' : Number(v) < 0 ? 'tf-neg' : ''); }
function tfBandClass(score) {
    if (score === null || score === undefined) return 'tf-band--na';
    return score >= 75 ? 'tf-band--strong' : score >= 60 ? 'tf-band--pos' : score >= 45 ? 'tf-band--neutral' : score >= 30 ? 'tf-band--weak' : 'tf-band--poor';
}

// ── init / quota ──

function tfInit() {
    if (!_tfInitDone) {
        _tfInitDone = true;
        const input = document.getElementById('tf-search-input');
        input.addEventListener('input', () => {
            clearTimeout(_tfSearchTimer);
            const q = input.value.trim();
            if (!q) { tfHideSuggest(); return; }
            _tfSearchTimer = setTimeout(() => tfSearch(q, false), 180);
        });
        input.addEventListener('keydown', tfSearchKeydown);
        input.addEventListener('focus', () => { if (_tfSuggest.length && input.value.trim()) tfShowSuggest(); });
        document.addEventListener('click', e => { if (!e.target.closest('#tf-search')) tfHideSuggest(); });
        tfRenderRecent();
        if (!_tfReport) tfRenderEmpty();
    }
    tfLoadQuota();
    setTimeout(() => document.getElementById('tf-search-input')?.focus(), 30);
}

async function tfLoadQuota(q) {
    try {
        const data = q || await (await fetch(`${API_BASE}/api/techno-funda/quota`)).json();
        const el = document.getElementById('tf-quota');
        if (!el || !data) return;
        el.classList.toggle('tf-quota--out', !!data.exhausted);
        el.innerHTML = data.exhausted
            ? '<span class="tf-dot"></span>Tapetide daily limit reached · cached fundamentals only'
            : `<span class="tf-dot"></span>Tapetide: ${tfEsc(data.calls_by_this_tab)} of ${tfEsc(data.daily_limit)} daily calls used here`;
    } catch (_) { /* non-critical */ }
}

// ── search ──

async function tfSearch(q, deep) {
    const seq = ++_tfSearchSeq;
    try {
        const resp = await fetch(`${API_BASE}/api/techno-funda/search?q=${encodeURIComponent(q)}${deep ? '&deep=true' : ''}`);
        const data = await resp.json();
        if (seq !== _tfSearchSeq) return;
        _tfSuggest = data.results || [];
        _tfActive = _tfSuggest.length ? 0 : -1;
        tfRenderSuggest(q, deep);
        if (deep) tfLoadQuota(data.quota);
    } catch (e) {
        if (seq === _tfSearchSeq) { _tfSuggest = []; tfRenderSuggest(q, deep, e.message); }
    }
}

function tfRenderSuggest(q, deep, err) {
    const box = document.getElementById('tf-suggest');
    let html = '';
    if (err) html += `<div class="tf-suggest-empty">Search failed: ${tfEsc(err)}</div>`;
    _tfSuggest.forEach((r, i) => {
        html += `<div class="tf-suggest-item${i === _tfActive ? ' active' : ''}" role="option" id="tf-opt-${i}" aria-selected="${i === _tfActive}"
                    onmousedown="event.preventDefault(); tfPick(${i})" onmouseenter="tfSetActive(${i})">
                    <span class="tf-sym">${r.symbol ? tfEsc(r.symbol) : '<span class="tf-muted" title="Ticker missing in the instrument list; it is looked up by ISIN">ISIN</span>'}</span>
                    <span class="tf-name">${tfEsc(r.name)}</span>
                    <span class="tf-tags">
                        ${r.is_fno ? '<span class="tf-tag">F&amp;O</span>' : ''}
                        ${r.exchange === 'BSE' ? '<span class="tf-tag">BSE</span>' : ''}
                        ${r.cached ? '<span class="tf-tag tf-tag--ok" title="Fundamentals saved on this machine — opening it costs no Tapetide calls">saved</span>' : ''}
                        ${r.sector ? `<span class="tf-sector">${tfEsc(r.sector)}</span>` : ''}
                    </span>
                 </div>`;
    });
    if (!_tfSuggest.length && !err) {
        html += `<div class="tf-suggest-empty">No NSE symbol or name matches “${tfEsc(q)}”.</div>`;
    }
    if (!deep && q.length >= 2 && _tfSuggest.length < 3) {
        html += `<button type="button" class="tf-suggest-deep" onmousedown="event.preventDefault(); tfSearch(${tfEsc(JSON.stringify(q))}, true)">
                    Search brand / old names via Tapetide <span>uses 1 of 50 daily calls</span></button>`;
    }
    const missing = _tfSuggest.some(r => !r.symbol);
    html += `<div class="tf-suggest-hint">↑ ↓ to move · Enter to analyse · Esc to close${missing ? ' · “ISIN” rows have no ticker yet: Settings → Refresh instruments fixes that' : ''}</div>`;
    box.innerHTML = html;
    tfShowSuggest();
}

function tfShowSuggest() {
    const box = document.getElementById('tf-suggest');
    box.hidden = false;
    document.getElementById('tf-search-input').setAttribute('aria-expanded', 'true');
}
function tfHideSuggest() {
    const box = document.getElementById('tf-suggest');
    if (box) box.hidden = true;
    document.getElementById('tf-search-input')?.setAttribute('aria-expanded', 'false');
}
function tfSetActive(i) {
    _tfActive = i;
    document.querySelectorAll('#tf-suggest .tf-suggest-item').forEach((el, j) => {
        el.classList.toggle('active', j === i);
        el.setAttribute('aria-selected', j === i);
    });
    document.getElementById(`tf-opt-${i}`)?.scrollIntoView({ block: 'nearest' });
}

function tfSearchKeydown(e) {
    const box = document.getElementById('tf-suggest');
    const open = box && !box.hidden;
    if (e.key === 'ArrowDown' && _tfSuggest.length) { e.preventDefault(); tfShowSuggest(); tfSetActive(Math.min(_tfSuggest.length - 1, _tfActive + 1)); }
    else if (e.key === 'ArrowUp' && _tfSuggest.length) { e.preventDefault(); tfSetActive(Math.max(0, _tfActive - 1)); }
    else if (e.key === 'Enter') {
        e.preventDefault();
        if (open && _tfActive >= 0 && _tfSuggest[_tfActive]) tfPick(_tfActive);
        else tfAnalyzeFromInput();
    } else if (e.key === 'Escape') tfHideSuggest();
}

function tfPick(i) {
    const r = _tfSuggest[i];
    if (!r) return;
    document.getElementById('tf-search-input').value = r.symbol || r.name || r.key;
    tfHideSuggest();
    tfAnalyze(r.key || r.symbol);
}

function tfAnalyzeFromInput() {
    const v = (document.getElementById('tf-search-input').value || '').trim();
    if (!v) { document.getElementById('tf-search-input').focus(); return; }
    // Exact symbol typed → go; otherwise use the top suggestion if we have one.
    const exact = _tfSuggest.find(r => r.symbol === v.toUpperCase());
    const sym = exact ? exact.symbol : (_tfSuggest[0] && !/^[A-Z0-9&\-]+$/.test(v) ? (_tfSuggest[0].key || _tfSuggest[0].symbol) : v.toUpperCase());
    document.getElementById('tf-search-input').value = sym;
    tfHideSuggest();
    tfAnalyze(sym);
}

// ── recent ──

function tfRecent() { try { return JSON.parse(localStorage.getItem(TF_RECENT_KEY) || '[]'); } catch (_) { return []; } }
function tfPushRecent(sym, name) {
    const list = tfRecent().filter(r => r.symbol !== sym);
    list.unshift({ symbol: sym, name });
    try { localStorage.setItem(TF_RECENT_KEY, JSON.stringify(list.slice(0, 8))); } catch (_) {}
    tfRenderRecent();
}
function tfRenderRecent() {
    const el = document.getElementById('tf-recent');
    const list = tfRecent();
    if (!el) return;
    el.innerHTML = list.length
        ? '<span class="tf-recent-label">Recent</span>' + list.map(r =>
            `<button type="button" class="tf-chip" title="${tfEsc(r.name || r.symbol)}" onclick="tfAnalyze('${tfEsc(r.symbol)}')">${tfEsc(r.symbol)}</button>`).join('')
        : '';
}

// ── analyse ──

async function tfAnalyze(symbol, opts = {}) {
    symbol = String(symbol || '').trim().toUpperCase();
    if (!symbol || _tfLoadingSymbol === symbol) return;
    _tfLoadingSymbol = symbol;
    const report = document.getElementById('tf-report');
    if (!opts.quiet) tfRenderLoading(symbol, opts);
    const params = new URLSearchParams();
    if (opts.refresh) params.set('refresh', 'true');
    if (opts.refreshFundamentals) params.set('refresh_fundamentals', 'true');
    try {
        const resp = await fetch(`${API_BASE}/api/techno-funda/analyze/${encodeURIComponent(symbol)}?${params}`);
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.detail || `HTTP ${resp.status}`);
        _tfReport = data;
        tfPushRecent(data.symbol, data.name);
        tfRenderReport();
        tfLoadQuota(data.quota);
    } catch (e) {
        report.innerHTML = `<div class="tf-card tf-error">
            <h3>Could not analyse ${tfEsc(symbol)}</h3><p>${tfEsc(e.message)}</p>
            <p class="tf-muted">Check the NSE symbol (e.g. <b>HDFCBANK</b>, <b>RELIANCE</b>) or pick a match from the search list.</p></div>`;
    } finally {
        _tfLoadingSymbol = null;
    }
}

function tfRenderEmpty() {
    document.getElementById('tf-report').innerHTML = `
        <div class="tf-card tf-empty">
            <div class="tf-empty-grid">
                <div><h3>Fundamental engine</h3><p>Valuation vs its own history, PEG, earnings yield, analyst targets, a 12–20× fair-value band, a mini-DCF, growth (3/5/10Y and quarterly), ROE/ROCE, cash conversion, Piotroski, leverage, promoter and institutional holding, pledge, concall takeaways.</p></div>
                <div><h3>Technical engine</h3><p>Trend (20–200 DMAs, Minervini template, Weinstein stage), momentum (RSI, MACD, ADX, stochastic), relative strength vs Nifty 50, volume (OBV, accumulation/distribution), volatility (ATR, Bollinger squeeze), support/resistance, pivots, Fibonacci and reference levels.</p></div>
                <div><h3>Verdict</h3><p>Both engines score 0–100 and combine into one TechnoFunda score, a quadrant (e.g. “Quality in momentum”), the key positives and risks, and what would change the view.</p></div>
            </div>
            <p class="tf-muted">Data: statements, ratios and shareholding from Screener.in, pledge and scorecard from Tickertape, prices from Dhan (or Yahoo Finance), all free. Analyst estimates, the concall digest and news come from Tapetide (about 3 of its 50 free daily calls per new stock). Each stock is saved for 24 hours, so reopening it is instant.</p>
        </div>`;
}

function tfRenderLoading(symbol, opts) {
    document.getElementById('tf-report').innerHTML = `
        <div class="tf-card tf-loading">
            <div class="tf-spinner" aria-hidden="true"></div>
            <div>
                <h3>Analysing ${tfEsc(symbol)}…</h3>
                <p class="tf-muted">${opts.refreshFundamentals ? 'Re-fetching fundamentals from Screener, Tickertape and Tapetide, and' : 'Loading saved or fresh fundamentals and'} two years of daily candles. This takes 5–20 seconds.</p>
            </div>
        </div>`;
}

function tfSetView(v) {
    _tfView = v;
    try { localStorage.setItem(TF_VIEW_KEY, v); } catch (_) {}
    tfRenderReport();
}

function tfRenderReport() {
    const d = _tfReport;
    if (!d) return;
    const views = [['summary', 'Summary'], ['fundamental', 'Fundamental'], ['technical', 'Technical'], ['business', 'Business & News']];
    const body = { summary: tfViewSummary, fundamental: tfViewFundamental, technical: tfViewTechnical, business: tfViewBusiness }[_tfView] || tfViewSummary;
    document.getElementById('tf-report').innerHTML = `
        ${tfHero(d)}
        <div class="tf-views" role="tablist">
            ${views.map(([k, l]) => `<button type="button" role="tab" aria-selected="${_tfView === k}" class="tf-view${_tfView === k ? ' active' : ''}" onclick="tfSetView('${k}')">${l}</button>`).join('')}
        </div>
        <div class="tf-body">${body(d)}</div>
        ${tfFooter(d)}`;
    tfAttachInfo(document.getElementById('tf-report'));
    if (_tfView === 'technical' || _tfView === 'summary') tfDrawChart(d);
}

// ── sections ──

function tfHero(d) {
    const f = d.fundamental || {}, t = d.technical || {}, c = f.company || {}, val = f.valuation || {};
    const q = d.quote || {};
    const lv = t.levels || {};
    const lo = lv.low_52w, hi = lv.high_52w, px = d.price;
    const pos = lo && hi && px && hi > lo ? Math.max(0, Math.min(100, (px - lo) / (hi - lo) * 100)) : null;
    const meta = d.sources?.fundamentals_meta || {};
    const fundAge = meta.source === 'cache' || meta.source === 'stale-cache'
        ? `saved ${meta.age_hours != null ? (meta.age_hours < 1 ? 'under an hour' : Math.round(meta.age_hours) + 'h') : ''} ago`
        : meta.source === 'live' ? `fetched now${meta.calls_used ? ` (${meta.calls_used} Tapetide calls)` : ''}` : 'unavailable';
    const notes = [d.sources?.price_note, meta.message].filter(Boolean);
    return `
    <div class="tf-card tf-hero">
        <div class="tf-hero-main">
            <div class="tf-hero-id">
                <h3><button type="button" class="tf-name-link" onclick="tfOpenInDhan('${tfEsc(d.symbol)}')"
                        title="Open the TradingView chart on Dhan (copies ${tfEsc(d.symbol)} to paste into its symbol search)">
                    ${tfEsc(d.name)}
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>
                </button></h3>
                <div id="tf-dhan-msg" class="tf-dhan-msg" role="status" hidden></div>
                <div class="tf-hero-tags">
                    <span class="tf-tag tf-tag--strong">${tfEsc(d.symbol)}</span>
                    ${c.classification ? `<span class="tf-tag">${tfEsc(c.classification)}</span>` : ''}
                    ${c.is_fno ? '<span class="tf-tag">F&amp;O</span>' : ''}
                    ${f.statement_basis ? `<span class="tf-tag" title="Financial statements basis">${tfEsc(f.statement_basis)}</span>` : ''}
                    ${d.sector ? `<span class="tf-muted">${tfEsc(d.sector)}${d.industry && d.industry !== d.sector ? ' · ' + tfEsc(d.industry) : ''}</span>` : ''}
                </div>
            </div>
            <div class="tf-hero-price">
                <div class="tf-price">${tfRs(px)}</div>
                ${q.change_pct != null ? `<div class="${tfTone(q.change_pct)}">${tfNum(q.change, 2)} (${tfPct(q.change_pct, 2, true)})</div>` : ''}
            </div>
        </div>
        <div class="tf-hero-stats">
            <div><span>Market cap</span><b>${tfCr(val.market_cap_cr)}</b></div>
            <div><span>P/E (TTM)</span><b>${tfNum(val.pe, 1)}</b></div>
            <div><span>P/B</span><b>${tfNum(val.pb, 2)}</b></div>
            <div><span>ROE</span><b>${tfPct(f.quality?.roe)}</b></div>
            <div><span>Div. yield</span><b>${tfPct(val.dividend_yield, 2)}</b></div>
            <div class="tf-range"><span>52-week range</span>
                ${pos !== null ? `<div class="tf-range-bar"><i style="left:${pos}%"></i></div><div class="tf-range-ends"><em>${tfRs(lo, 0)}</em><em>${tfRs(hi, 0)}</em></div>` : '<b>—</b>'}
            </div>
        </div>
        <div class="tf-hero-foot">
            <span class="tf-muted">Report ${tfEsc((d.generated_at || '').replace('T', ' '))}${d.cached ? ' (cached)' : ''} · Prices: ${tfEsc(d.sources?.prices)} · Fundamentals ${tfEsc(fundAge)}: ${tfEsc(d.sources?.fundamentals)}</span>
            <span class="tf-hero-actions">
                <button type="button" class="tf-btn" onclick="tfAnalyze('${tfEsc(d.symbol)}', {refresh: true})" title="Rebuild the report with fresh price data (no Tapetide calls if fundamentals are saved)">Refresh prices</button>
                <button type="button" class="tf-btn" onclick="tfAnalyze('${tfEsc(d.symbol)}', {refresh: true, refreshFundamentals: true})" title="Re-download from Screener and Tickertape (free) plus Tapetide extras (about 3 of its 50 daily calls)">Re-fetch fundamentals</button>
            </span>
        </div>
        ${notes.map(n => `<div class="tf-note">${tfEsc(n)}</div>`).join('')}
    </div>`;
}

/** Same flow as the IPO tab: tv.dhan.co can't be deep-linked, so copy the ticker and open it. */
async function tfOpenInDhan(sym) {
    if (!sym) return;
    const copy = navigator.clipboard?.writeText(sym).then(() => true, () => false) ?? Promise.resolve(false);
    const ok = sxOpenTab(SX_DHAN_TV_URL);  // synchronous inside the click, so it isn't treated as a pop-up
    const copied = await copy;
    const el = document.getElementById('tf-dhan-msg');
    if (!el) return;
    el.hidden = false;
    el.className = `tf-dhan-msg${ok ? '' : ' tf-dhan-msg--err'}`;
    el.textContent = !ok ? 'Your browser blocked the new tab. Allow pop-ups for this site, then try again.'
        : copied ? `Opened TradingView on Dhan · "${sym}" copied, paste it into the symbol search.`
        : `Opened TradingView on Dhan · search for "${sym}".`;
    clearTimeout(tfOpenInDhan._t);
    tfOpenInDhan._t = setTimeout(() => { el.hidden = true; }, 8000);
}

function tfGauge(score, label, sub, big) {
    const s = score ?? 0;
    const r = big ? 46 : 34, cx = big ? 56 : 42, w = big ? 10 : 8, size = cx * 2;
    const C = 2 * Math.PI * r;
    return `<div class="tf-gauge ${big ? 'tf-gauge--big' : ''} ${tfBandClass(score)}">
        <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">
            <circle cx="${cx}" cy="${cx}" r="${r}" class="tf-gauge-track" stroke-width="${w}" fill="none"/>
            <circle cx="${cx}" cy="${cx}" r="${r}" class="tf-gauge-val" stroke-width="${w}" fill="none"
                stroke-dasharray="${(score == null ? 0 : s / 100 * C).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 ${cx} ${cx})" stroke-linecap="round"/>
        </svg>
        <div class="tf-gauge-text"><b>${score == null ? '—' : score}</b><span>${tfEsc(label)}</span></div>
        ${sub ? `<div class="tf-gauge-sub">${tfEsc(sub)}</div>` : ''}
    </div>`;
}

function tfPillars(title, pillars, weights, names) {
    if (!pillars) return '';
    return `<div class="tf-pillars"><h4>${tfEsc(title)}</h4>
        ${Object.keys(names).map(k => {
            const v = pillars[k];
            return `<div class="tf-pillar ${tfBandClass(v)}">
                <span class="tf-pillar-name">${tfEsc(names[k])}<em>${weights?.[k] ?? ''}%</em></span>
                <span class="tf-bar"><i style="width:${v ?? 0}%"></i></span>
                <b>${v ?? '—'}</b></div>`;
        }).join('')}</div>`;
}

const TF_FUND_NAMES = { quality: 'Quality', growth: 'Growth', financial_health: 'Financial health', valuation: 'Valuation', ownership: 'Ownership' };
const TF_TECH_NAMES = { trend: 'Trend', momentum: 'Momentum', relative_strength: 'Relative strength', volume: 'Volume', risk: 'Risk / volatility' };

function tfViewSummary(d) {
    const v = d.verdict || {}, f = d.fundamental || {}, t = d.technical || {};
    return `
    ${tfBusinessSummary(d)}
    <div class="tf-card tf-verdict ${tfBandClass(v.score)}">
        <div class="tf-verdict-gauges">
            ${tfGauge(v.score, 'TechnoFunda', v.rating, true)}
            <div class="tf-verdict-sub">
                ${tfGauge(v.fundamental_score, 'Fundamental', v.fundamental_rating)}
                ${tfGauge(v.technical_score, 'Technical', v.technical_bias || v.technical_rating)}
            </div>
        </div>
        <div class="tf-verdict-text">
            <div class="tf-quadrant">${tfEsc(v.quadrant)}</div>
            <p>${tfEsc(v.summary)}</p>
            <div class="tf-two">
                <div><h4 class="tf-pos">Positives</h4><ul class="tf-list">${(v.positives || []).map(x => `<li>${tfEsc(x)}</li>`).join('') || '<li class="tf-muted">None stand out</li>'}</ul></div>
                <div><h4 class="tf-neg">Risks / weaknesses</h4><ul class="tf-list">${(v.negatives || []).map(x => `<li>${tfEsc(x)}</li>`).join('') || '<li class="tf-muted">None flagged</li>'}</ul></div>
            </div>
            ${(v.triggers || []).length ? `<h4>What would change the view</h4><ul class="tf-list tf-list--plain">${v.triggers.map(x => `<li>${tfEsc(x)}</li>`).join('')}</ul>` : ''}
            <p class="tf-muted tf-small">Weights: fundamental ${Math.round((v.weights?.fundamental || 0) * 100)}%, technical ${Math.round((v.weights?.technical || 0) * 100)}%.</p>
        </div>
    </div>
    <div class="tf-grid-2">
        <div class="tf-card">${f.available ? tfPillars('Fundamental pillars', f.pillars, f.weights, TF_FUND_NAMES) : tfUnavailable('Fundamentals', f.reason)}</div>
        <div class="tf-card">${t.available ? tfPillars('Technical pillars', t.pillars, t.weights, TF_TECH_NAMES) : tfUnavailable('Technicals', t.reason)}</div>
    </div>
    ${t.available ? `<div class="tf-card"><h4>Price, 50-DMA and 200-DMA (1 year)</h4><div class="tf-chart"><canvas id="tf-chart"></canvas></div></div>` : ''}
    ${f.available ? tfKeyMetrics(f) : ''}`;
}

function tfUnavailable(what, reason) {
    return `<h4>${tfEsc(what)}</h4><p class="tf-muted">${tfEsc(reason || 'Not available for this stock.')}</p>`;
}

function tfMetricGrid(items) {
    return `<div class="tf-metrics">${items.map(([label, value, hint, tone]) =>
        `<div class="tf-metric" ${hint ? `title="${tfEsc(hint)}"` : ''}><span>${tfEsc(label)}</span><b class="${tone || ''}">${value}</b></div>`).join('')}</div>`;
}

function tfKeyMetrics(f) {
    const v = f.valuation || {}, g = f.growth || {}, q = f.quality || {}, h = f.financial_health || {}, o = f.ownership || {};
    return `<div class="tf-card"><h4>Key numbers</h4>${tfMetricGrid([
        ['Sales CAGR 3Y', tfPct(g.sales_cagr?.['3 Years']), '', tfTone(g.sales_cagr?.['3 Years'])],
        ['Profit CAGR 3Y', tfPct(g.profit_cagr?.['3 Years']), '', tfTone(g.profit_cagr?.['3 Years'])],
        [`Sales YoY (${g.latest_quarter || 'latest Q'})`, tfPct(g.sales_yoy_q, 1, true), '', tfTone(g.sales_yoy_q)],
        [`Profit YoY (${g.latest_quarter || 'latest Q'})`, tfPct(g.profit_yoy_q, 1, true), '', tfTone(g.profit_yoy_q)],
        ['ROCE', tfPct(q.roce), '5Y average ' + tfPct(q.roce_5y_avg)],
        ['Cash conversion (5Y)', q.cash_conversion_5y != null ? tfNum(q.cash_conversion_5y, 2) + '×' : '—', 'Operating cash flow ÷ net profit'],
        ['Debt / Equity', h.is_financial ? 'n/a (lender)' : tfNum(h.debt_to_equity, 2)],
        ['Promoter holding', tfPct(o.promoter), 'Pledged: ' + tfPct(o.pledge_pct)],
        ['Forward P/E', tfNum(v.forward_pe, 1), v.forward_period ? 'FY ending ' + v.forward_period : ''],
        ['Median P/E (own history)', tfNum(v.median_pe_hist, 1), v.median_pe_basis || ''],
        ['PEG', tfNum(v.peg, 2), 'P/E ÷ EPS growth (3Y)'],
        ['Analyst target', tfRs(v.analyst_target?.mean, 0), v.analyst_target?.upside_pct != null ? 'Upside ' + tfPct(v.analyst_target.upside_pct, 1, true) : ''],
    ])}</div>`;
}

function tfChecklist(title, checks, score) {
    if (!checks || !checks.length) return '';
    const icon = { pass: '✓', fail: '✕', neutral: '–', na: '·' };
    return `<div class="tf-card tf-checks">
        <div class="tf-checks-head"><h4>${tfEsc(title)}</h4>${score != null ? `<span class="tf-score-pill ${tfBandClass(score)}">${score}/100</span>` : ''}</div>
        <ul>${checks.map(c => `<li class="tf-check tf-check--${c.status}">
            <span class="tf-check-icon" aria-label="${c.status}">${icon[c.status] || '·'}</span>
            <span class="tf-check-label">${tfEsc(c.label)}</span>
            <span class="tf-check-detail">${tfEsc(c.detail || '')}</span></li>`).join('')}</ul></div>`;
}

function tfTable(head, rows, cls = '') {
    return `<div class="tf-table-wrap"><table class="tf-table ${cls}"><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

// ── Business: "what the company does" (Summary) and the deep dive (Fundamental) ──

/** Minimal, safe Markdown → HTML for the annual-report digest: escapes first, then headings, lists, tables, bold. */
function tfMd(md) {
    const inline = t => tfEsc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    const out = [];
    let list = null, table = null, para = [];
    const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
    const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map(i => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; } };
    const flushTable = () => {
        if (table) {
            const rows = table.filter(r => !/^\s*\|?\s*:?-{2,}/.test(r)).map(r => r.replace(/^\s*\||\|\s*$/g, '').split('|').map(c => inline(c.trim())));
            if (rows.length) out.push(`<div class="tf-table-wrap"><table class="tf-table tf-table--compact tf-table--wrap"><thead><tr>${rows[0].map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.slice(1).map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
            table = null;
        }
    };
    for (const line of String(md || '').split(/\r?\n/)) {
        const t = line.trim();
        if (!t) { flushPara(); flushList(); flushTable(); continue; }
        if (t.startsWith('|')) { flushPara(); flushList(); (table = table || []).push(t); continue; }
        flushTable();
        let m;
        if ((m = t.match(/^#{1,6}\s+(.*)/))) { flushPara(); flushList(); out.push(`<h6>${inline(m[1])}</h6>`); continue; }
        if ((m = t.match(/^[-*•]\s+(.*)/)) || (m = t.match(/^\d+[.)]\s+(.*)/))) {
            flushPara();
            const tag = /^\d/.test(t) ? 'ol' : 'ul';
            if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
            list.items.push(m[1]);
            continue;
        }
        flushList();
        para.push(t);
    }
    flushPara(); flushList(); flushTable();
    return out.join('');
}

function tfMixBars(mix) {
    if (!mix || !(mix.items || []).length) return '';
    const max = Math.max(...mix.items.map(i => i.pct));
    return `<div class="tf-mix">
        ${mix.title ? `<div class="tf-mix-title">${tfEsc(mix.title)}</div>` : ''}
        ${mix.items.map(i => `<div class="tf-mix-row"><span class="tf-mix-label">${tfEsc(i.label)}</span>
            <span class="tf-bar"><i style="width:${(i.pct / max * 100).toFixed(1)}%"></i></span><b>${tfNum(i.pct, 1)}%</b></div>`).join('')}
    </div>`;
}

function tfFactChips(facts, keys) {
    const items = (keys || Object.keys(facts || {})).filter(k => facts && facts[k]);
    if (!items.length) return '';
    return `<div class="tf-facts">${items.map(k => `<span class="tf-fact"><em>${tfEsc(k)}</em>${k === 'Website'
        ? `<a href="https://${tfEsc(String(facts[k]).replace(/^https?:\/\//, ''))}" target="_blank" rel="noopener noreferrer">${tfEsc(facts[k])}</a>`
        : tfEsc(facts[k])}</span>`).join('')}</div>`;
}

function tfOpenDeepDive() {
    tfSetView('fundamental');
    requestAnimationFrame(() => document.getElementById('tf-deepdive')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

function tfBusinessSummary(d) {
    const b = d.business || {};
    if (!b.available) return '';
    const o = b.overview || {};
    const name = (d.name || d.symbol || '').replace(/ (Ltd|Limited)\.?$/i, '');
    return `
    <div class="tf-card tf-biz">
        <div class="tf-biz-head">
            <h4>What ${tfEsc(name)} does</h4>
            ${o.identity ? `<span class="tf-biz-identity">${tfEsc(o.identity)}</span>` : ''}
        </div>
        ${o.about ? `<p class="tf-biz-about">${tfEsc(o.about)}</p>` : ''}
        ${o.latest ? `<div class="tf-biz-latest"><span class="tf-term-k">Where the business stands now${o.latest_period ? ` · annual report ${tfEsc(o.latest_period)}` : ''}</span><p>${tfEsc(o.latest)}</p></div>` : ''}
        <div class="tf-biz-grid">
            ${tfFactChips(b.facts, ['Founded', 'Headquarters', 'Industry', 'Employees', 'Listed since'])}
            ${tfMixBars(b.revenue_mix)}
        </div>
        <button type="button" class="tf-btn tf-biz-more" onclick="tfOpenDeepDive()">Read the full business story →</button>
    </div>`;
}

function tfBusinessDeepDive(d) {
    const b = d.business || {};
    if (!b.available) return '';
    const o = b.overview || {}, ar = b.annual_report, peers = b.peers, wiki = b.wiki;
    const name = (d.name || d.symbol || '').replace(/ (Ltd|Limited)\.?$/i, '');
    const wikiParas = wiki?.extract ? wiki.extract.split(/\n+/).filter(Boolean).slice(0, 4) : [];
    const story = (b.story || []).map(x => `<div class="tf-story-item"><h5>${tfEsc(x.title)}</h5><p>${tfEsc(x.text)}</p></div>`).join('');
    const peerRows = (peers?.rows || []).map(r => [
        `${r.is_self ? '<b>' : ''}${tfEsc(r.name)}${r.is_self ? '</b> <span class="tf-tag tf-tag--strong">this stock</span>' : ''}`,
        tfRs(r.price), tfNum(r.pe, 1), tfCr(r.market_cap), tfPct(r.roce, 1),
        `<span class="${tfTone(r.qtr_sales_var)}">${tfPct(r.qtr_sales_var, 1, true)}</span>`,
        `<span class="${tfTone(r.qtr_profit_var)}">${tfPct(r.qtr_profit_var, 1, true)}</span>`]);
    return `
    <div id="tf-deepdive" class="tf-deep">
        <div class="tf-deep-title"><h3>Business deep dive: ${tfEsc(name)}</h3>
            <span class="tf-muted">What the company does, how it got here, and where it stands</span></div>

        <div class="tf-grid-2">
            <div class="tf-card"><h4>The business</h4>
                ${o.identity ? `<div class="tf-biz-identity">${tfEsc(o.identity)}</div>` : ''}
                ${o.about ? `<p class="tf-biz-about">${tfEsc(o.about)}</p>` : ''}
                ${wikiParas.length ? `<div class="tf-wiki">${wikiParas.map(x => `<p>${tfEsc(x)}</p>`).join('')}
                    <p class="tf-muted tf-small">Background from <a href="${tfEsc(wiki.url)}" target="_blank" rel="noopener noreferrer">Wikipedia</a> (CC BY-SA). Check recent filings for current details.</p></div>` : ''}
                ${tfFactChips(b.facts)}
            </div>
            <div class="tf-card"><h4>Where the money comes from</h4>
                ${tfMixBars(b.revenue_mix) || ''}
                ${(b.key_points || []).length ? `<ul class="tf-list">${b.key_points.map(k => `<li>${tfEsc(k.replace(/^[-•]\s*/, ''))}</li>`).join('')}</ul>` : ''}
                ${!b.revenue_mix && !(b.key_points || []).length ? `<p class="tf-muted">The company's segment split isn't published on the free sources; see “Segment” in the annual-report deep dive below.</p>` : ''}
                <p class="tf-muted tf-small">Source: company disclosures via Screener.in.</p>
            </div>
        </div>

        ${story ? `<div class="tf-card tf-story"><h4>The story in numbers</h4>
            <p class="tf-muted tf-small">Written automatically from 10+ years of reported financials, peers and shareholding, not opinion.</p>${story}</div>` : ''}

        ${ar ? `<div class="tf-card tf-ar"><h4>Annual report deep dive · ${tfEsc(ar.period || ar.title || '')}</h4>
            <p class="tf-muted tf-small">An AI-generated digest (Tapetide) of the ${ar.pages ? tfEsc(ar.pages) + '-page ' : ''}annual report filed with the exchange. Verify key numbers against the
                ${ar.pdf_url ? `<a href="${tfEsc(ar.pdf_url)}" target="_blank" rel="noopener noreferrer">original PDF</a>` : 'original filing'}.</p>
            ${(ar.sections || []).map((sec, i) => `<details class="tf-ar-sec"${i < 2 ? ' open' : ''}><summary>${tfEsc(sec.heading)}</summary><div class="tf-md">${tfMd(sec.body)}</div></details>`).join('')}
        </div>` : `<div class="tf-card"><h4>Annual report deep dive</h4><p class="tf-muted">No parsed annual report is available for this company yet${(d.quota || {}).exhausted ? ' (Tapetide’s daily limit is used up; it resets at midnight IST)' : ''}.</p></div>`}

        ${peerRows.length ? `<div class="tf-card"><h4>Industry and peers</h4>
            ${tfTable(['Company', 'Price', 'P/E', 'Market cap', 'ROCE', 'Sales YoY (qtr)', 'Profit YoY (qtr)'], peerRows, 'tf-table--compact tf-peers')}
            <p class="tf-muted tf-small">Closest listed companies in the same industry group (Screener.in).</p></div>` : ''}
    </div>`;
}

function tfViewFundamental(d) {
    const f = d.fundamental || {};
    if (!f.available) return `<div class="tf-card">${tfUnavailable('Fundamentals', f.reason)}</div>`;
    const v = f.valuation || {}, g = f.growth || {}, q = f.quality || {}, h = f.financial_health || {}, o = f.ownership || {};
    const fair = v.conservative_fair_range || {}, dcf = v.mini_dcf || {}, at = v.analyst_target || {};
    const valuation = `<div class="tf-card"><h4>Valuation</h4>${tfMetricGrid([
        ['P/E (TTM)', tfNum(v.pe, 1)], ['Median P/E, own history', tfNum(v.median_pe_hist, 1), v.median_pe_basis || ''],
        ['Forward P/E', tfNum(v.forward_pe, 1)], ['PEG', tfNum(v.peg, 2)],
        ['P/B', tfNum(v.pb, 2)], ['Earnings yield', tfPct(v.earnings_yield, 2), `vs 10Y G-sec ~${v.gsec_yield}%`],
        ['EPS (TTM)', tfRs(v.eps_ttm)], ['Book value / share', tfRs(v.book_value)],
        ['Graham number', tfRs(v.graham_number, 0), '√(22.5 × EPS × book value) — a deep-value ceiling'],
        ['Value at own median P/E', tfRs(v.historical_pe_fair_value, 0), 'Forward (or TTM) EPS × median P/E: where it would trade if the old multiple returned'],
        ['12–20× earnings band', fair.fair_value_low ? `${tfRs(fair.fair_value_low, 0)} – ${tfRs(fair.fair_value_high, 0)}` : '—', 'Value Investing tab’s conservative fair-value range'],
        ['Mini-DCF (EPS based)', dcf.dcf_low ? `${tfRs(dcf.dcf_low, 0)} – ${tfRs(dcf.dcf_high, 0)}` : '—', dcf.growth_low != null ? `Growth ${dcf.growth_low}–${dcf.growth_high}%, Value Investing tab’s DCF settings` : ''],
        ['Analyst target (mean)', tfRs(at.mean, 0), at.period ? 'Period ' + at.period : ''],
        ['Analyst range', at.low ? `${tfRs(at.low, 0)} – ${tfRs(at.high, 0)}` : '—'],
        ['Upside to mean target', tfPct(at.upside_pct, 1, true), '', tfTone(at.upside_pct)],
    ])}</div>`;

    const cagrRow = (label, obj, keys) => [label, ...keys.map(k => `<span class="${tfTone(obj?.[k])}">${tfPct(obj?.[k], 0)}</span>`)];
    const growthCagr = tfTable(['', '3Y', '5Y', '10Y', 'TTM'], [
        cagrRow('Sales', g.sales_cagr, ['3 Years', '5 Years', '10 Years', 'TTM']),
        cagrRow('Net profit', g.profit_cagr, ['3 Years', '5 Years', '10 Years', 'TTM']),
    ]);
    const annual = (g.annual || []).length ? tfTable(['Year', 'Sales (Cr)', 'Net profit (Cr)', 'OPM %', 'EPS'],
        g.annual.map(r => [tfEsc(r.period), tfNum(r.sales, 0), tfNum(r.net_profit, 0), tfNum(r.opm, 0), tfNum(r.eps, 2)])) : '';
    const quarters = (g.quarters || []).length ? tfTable(['Quarter', 'Sales (Cr)', 'YoY', 'Net profit (Cr)', 'YoY', 'OPM %'],
        g.quarters.map(r => [tfEsc(r.period), tfNum(r.sales, 0), `<span class="${tfTone(r.sales_yoy)}">${tfPct(r.sales_yoy, 1, true)}</span>`,
            tfNum(r.net_profit, 0), `<span class="${tfTone(r.profit_yoy)}">${tfPct(r.profit_yoy, 1, true)}</span>`, tfNum(r.opm, 0)])) : '';

    const pio = q.piotroski || {};
    const quality = `<div class="tf-card"><h4>Profitability & quality</h4>${tfMetricGrid([
        ['ROE (latest)', tfPct(q.roe)], ['ROE 3Y / 5Y / 10Y', [q.roe_history?.['3 Years'], q.roe_history?.['5 Years'], q.roe_history?.['10 Years']].map(x => tfPct(x, 0)).join(' / ')],
        ['ROCE (latest)', tfPct(q.roce)], ['ROCE 5Y average', tfPct(q.roce_5y_avg)],
        ['Cash conversion (5Y)', q.cash_conversion_5y != null ? tfNum(q.cash_conversion_5y, 2) + '×' : '—'],
        ['FCF positive years', q.fcf_years ? `${q.fcf_positive_years} of ${q.fcf_years}` : '—'],
        ['Other income % of PBT', tfPct(q.other_income_pct_pbt)], ['Debtor days', q.debtor_days != null ? tfNum(q.debtor_days, 0) + (q.debtor_days_change_3y != null ? ` (${q.debtor_days_change_3y > 0 ? '+' : ''}${tfNum(q.debtor_days_change_3y, 0)} in 3Y)` : '') : '—'],
        ['Dividend payout', tfPct(q.dividend_payout_pct, 0)], ['Tax rate', tfPct(q.tax_rate_pct, 0)],
    ])}
    ${pio.available ? `<h5>Piotroski F-score: ${pio.score} / ${pio.max} <span class="tf-muted">(${tfEsc((pio.years || []).join(' → '))})</span></h5>
        <ul class="tf-mini-checks">${pio.tests.map(t => `<li class="${t.passed ? 'tf-pos' : 'tf-neg'}">${t.passed ? '✓' : '✕'} ${tfEsc(t.label)}</li>`).join('')}</ul>` : ''}</div>`;

    const health = `<div class="tf-card"><h4>Balance sheet</h4>${tfMetricGrid([
        ['Debt / Equity', h.is_financial ? 'n/a (lender)' : tfNum(h.debt_to_equity, 2)],
        ['Borrowings', tfCr(h.borrowings)], ['Net worth', tfCr(h.net_worth)],
        ['Interest coverage', h.interest_coverage != null ? tfNum(h.interest_coverage, 1) + '×' : '—'],
        ['Borrowings CAGR 3Y', tfPct(h.borrowings_cagr_3y)], ['Share capital change 3Y', tfPct(h.equity_change_3y_pct, 1, true)],
    ])}</div>`;

    const ownRows = Object.entries(o.table || {}).map(([k, arr]) => [tfEsc(k), ...arr.map(x => tfPct(x, 2))]);
    const ownership = `<div class="tf-card"><h4>Shareholding</h4>
        ${ownRows.length ? tfTable(['', ...(o.periods || []).map(tfEsc)], ownRows, 'tf-table--compact') : ''}
        ${tfMetricGrid([
            ['Promoter change (QoQ)', tfPct(o.promoter_change_qoq, 2, true), '', tfTone(o.promoter_change_qoq)],
            ['Promoter change (1Y)', tfPct(o.promoter_change_1y, 2, true), '', tfTone(o.promoter_change_1y)],
            ['FII + DII', tfPct(o.institutional, 2)], ['Institutional change (1Y)', tfPct(o.institutional_change_1y, 2, true), '', tfTone(o.institutional_change_1y)],
            ['Promoter pledge', tfPct(o.pledge_pct, 2)], ['Shareholders (1Y change)', tfPct(o.shareholders_change_1y_pct, 1, true)],
        ])}
        ${(o.recent_deals || []).length ? `<h5>Recent bulk / block / insider deals</h5>${tfTable(['Date', 'Type', 'Side', 'Entity', 'Qty', 'Price'],
            o.recent_deals.map(x => [tfEsc(x.date), tfEsc(x.kind), `<span class="${x.side === 'Buy' ? 'tf-pos' : 'tf-neg'}">${tfEsc(x.side)}</span>`, tfEsc(x.entity), tfNum(x.qty, 0), tfRs(x.price)]), 'tf-table--compact')}` : ''}
    </div>`;

    const flags = `<div class="tf-grid-2">
        <div class="tf-card"><h4 class="tf-pos">Green flags</h4><ul class="tf-list">${(f.green_flags || []).map(x => `<li>${tfEsc(x)}</li>`).join('') || '<li class="tf-muted">None</li>'}</ul></div>
        <div class="tf-card"><h4 class="tf-neg">Red flags</h4><ul class="tf-list">${(f.red_flags || []).map(x => `<li>${tfEsc(x)}</li>`).join('') || '<li class="tf-muted">None</li>'}</ul></div></div>`;

    const P = f.pillars || {}, C = f.checks || {};
    return `${tfBusinessDeepDive(d)}
        ${flags}
        <div class="tf-grid-2">
            ${tfChecklist('Quality checks', C.quality, P.quality)}
            ${tfChecklist('Growth checks', C.growth, P.growth)}
            ${tfChecklist('Financial health checks', C.financial_health, P.financial_health)}
            ${tfChecklist('Valuation checks', C.valuation, P.valuation)}
            ${tfChecklist('Ownership checks', C.ownership, P.ownership)}
        </div>
        ${valuation}
        <div class="tf-card"><h4>Growth</h4>${growthCagr}${annual ? '<h5>Annual</h5>' + annual : ''}${quarters ? '<h5>Last 8 quarters</h5>' + quarters : ''}</div>
        <div class="tf-grid-2">${quality}${health}</div>
        ${ownership}`;
}

function tfViewTechnical(d) {
    const t = d.technical || {};
    if (!t.available) return `<div class="tf-card">${tfUnavailable('Technicals', t.reason || d.sources?.price_note)}</div>`;
    const tr = t.trend || {}, m = t.momentum || {}, rs = t.relative_strength || {}, vo = t.volume || {}, vl = t.volatility || {}, lv = t.levels || {}, p = t.plan || {};
    const P = t.pillars || {}, C = t.checks || {};
    const maRows = (tr.moving_averages || []).map(x => [tfEsc(x.name), tfRs(x.value), `<span class="${x.above ? 'tf-pos' : 'tf-neg'}">${tfPct(x.distance_pct, 1, true)}</span>`, x.above ? 'Above' : 'Below']);
    const tt = tr.trend_template || {};
    const retKeys = ['1W', '1M', '3M', '6M', '1Y'];
    const retRows = [['Stock', ...retKeys.map(k => `<span class="${tfTone(m.returns?.[k])}">${tfPct(m.returns?.[k], 1, true)}</span>`)]];
    if (rs.available) {
        retRows.push(['Nifty 50', '—', ...['1M', '3M', '6M', '1Y'].map(k => tfPct(rs.benchmark_returns?.[k], 1, true))]);
        retRows.push(['Out / under-performance', '—', ...['1M', '3M', '6M', '1Y'].map(k => `<span class="${tfTone(rs.outperformance?.[k])}">${rs.outperformance?.[k] != null ? (rs.outperformance[k] > 0 ? '+' : '') + tfNum(rs.outperformance[k], 1) + ' pts' : '—'}</span>`)]);
    }
    const lvlRows = [
        ...(lv.resistances || []).slice().reverse().map(r => ['<span class="tf-neg">Resistance</span>', tfRs(r.price), tfPct(r.distance_pct, 1, true), `${r.touches}×`]),
        [`<b>Last close</b>`, `<b>${tfRs(t.last_close)}</b>`, '', ''],
        ...(lv.supports || []).map(s => ['<span class="tf-pos">Support</span>', tfRs(s.price), tfPct(s.distance_pct, 1, true), `${s.touches}×`]),
    ];
    const piv = lv.weekly_pivots || {};
    return `
    <div class="tf-card"><h4>Price, 50-DMA and 200-DMA (1 year)</h4><div class="tf-chart"><canvas id="tf-chart"></canvas></div>
        <p class="tf-muted tf-small">As of ${tfEsc(t.as_of)} · ${tfEsc(t.sessions)} sessions · ${tfEsc(d.sources?.prices)}</p></div>
    <div class="tf-grid-2">
        ${tfChecklist('Trend checks', C.trend, P.trend)}
        ${tfChecklist('Momentum checks', C.momentum, P.momentum)}
        ${tfChecklist('Relative strength vs Nifty 50', C.relative_strength, P.relative_strength)}
        ${tfChecklist('Volume checks', C.volume, P.volume)}
        ${tfChecklist('Risk & volatility checks', C.risk, P.risk)}
        ${tt.total ? tfChecklist(`Minervini trend template — ${tt.passed}/${tt.total}`, tt.checks, null) : ''}
    </div>
    <div class="tf-grid-2">
        <div class="tf-card"><h4>Trend structure</h4>
            ${tfMetricGrid([
                ['Weinstein stage', tfEsc(tr.stage?.label || '—'), tr.stage?.wma30 ? `30-week MA ${tfRs(tr.stage.wma30)}, 4-week slope ${tfPct(tr.stage.wma30_slope_4w_pct, 2, true)}` : ''],
                ['Weekly trend (10-week MA)', tfEsc(tr.weekly_trend || '—')],
                ['200-DMA slope (1M)', tfPct(tr.sma200_slope_1m_pct, 2, true), '', tfTone(tr.sma200_slope_1m_pct)],
                ['Last 50/200 cross', tr.last_cross ? `${tr.last_cross.type === 'golden' ? '<span class="tf-pos">Golden</span>' : '<span class="tf-neg">Death</span>'} · ${tfEsc(tr.last_cross.date)}` : '—', tr.last_cross ? tr.last_cross.sessions_ago + ' sessions ago' : ''],
            ])}
            ${tfTable(['Average', 'Value', 'Price vs MA', ''], maRows, 'tf-table--compact')}
        </div>
        <div class="tf-card"><h4>Momentum</h4>
            ${tfMetricGrid([
                ['RSI (14)', tfNum(m.rsi14, 1)], ['MACD / signal', `${tfNum(m.macd, 2)} / ${tfNum(m.macd_signal, 2)}`, 'Histogram ' + tfNum(m.macd_hist, 2)],
                ['ADX (14)', tfNum(m.adx14, 1), `+DI ${tfNum(m.plus_di, 1)} / −DI ${tfNum(m.minus_di, 1)}`], ['Stochastic %K / %D', `${tfNum(m.stoch_k, 0)} / ${tfNum(m.stoch_d, 0)}`],
                ['Mansfield RS', tfNum(rs.mansfield_rs, 1), 'Stock/Nifty ratio vs its 52-week average'], ['RS line trend (1M)', tfPct(rs.rs_line_trend_1m_pct, 2, true), '', tfTone(rs.rs_line_trend_1m_pct)],
            ])}
            <h5>Returns</h5>${tfTable(['', ...retKeys], retRows, 'tf-table--compact')}
        </div>
    </div>
    <div class="tf-grid-2">
        <div class="tf-card"><h4>Volume & volatility</h4>${tfMetricGrid([
            ['Relative volume (today ÷ 20D)', vo.relative_volume != null ? tfNum(vo.relative_volume, 2) + '×' : '—'],
            ['Avg volume 20D / 50D', `${tfNum(vo.avg20, 0)} / ${tfNum(vo.avg50, 0)}`],
            ['Accumulation / distribution days (25)', `${vo.accumulation_days ?? '—'} / ${vo.distribution_days ?? '—'}`],
            ['Up/down volume ratio (50D)', tfNum(vo.up_down_ratio_50d, 2)],
            ['ATR (14)', `${tfRs(vl.atr14)} (${tfPct(vl.atr_pct, 2)})`], ['Historical volatility (20D, annualised)', tfPct(vl.hv20_annualised_pct, 1)],
            ['Bollinger %B', tfNum(vl.bb_pct_b, 2), `Bands ${tfRs(vl.bb_lower)} – ${tfRs(vl.bb_upper)}`],
            ['Band width', `${tfPct(vl.bb_width_pct, 1)}${vl.squeeze ? ' · squeeze' : ''}`, 'Squeeze = band width in its lowest 20% of the last 6 months'],
            ['Max drawdown (1Y)', tfPct(vl.max_drawdown_1y_pct, 1), '', 'tf-neg'],
        ])}</div>
        <div class="tf-card"><h4>Key levels</h4>
            ${tfTable(['', 'Price', 'Distance', 'Touches'], lvlRows, 'tf-table--compact')}
            ${tfMetricGrid([
                ['52-week high', `${tfRs(lv.high_52w)} (${tfPct(lv.from_52w_high_pct, 1, true)})`],
                ['52-week low', `${tfRs(lv.low_52w)} (${tfPct(lv.from_52w_low_pct, 1, true)})`],
                ['Weekly pivot', tfRs(piv.pivot), `R1 ${tfRs(piv.r1)} · R2 ${tfRs(piv.r2)} · S1 ${tfRs(piv.s1)} · S2 ${tfRs(piv.s2)}`],
            ])}
            ${lv.fibonacci_52w && Object.keys(lv.fibonacci_52w).length ? `<h5>Fibonacci retracements of the 52-week range</h5>
                <div class="tf-fib">${Object.entries(lv.fibonacci_52w).map(([k, v]) => `<span><em>${tfEsc(k)}</em>${tfRs(v, 0)}</span>`).join('')}</div>` : ''}
        </div>
    </div>
    ${p.available ? `<div class="tf-card tf-plan"><h4>Reference levels <span class="tf-muted">(educational, not a trade recommendation)</span></h4>
        <div class="tf-plan-grid">
            <div><span>Entry zone</span><b>${tfRs(p.entry_zone?.[0])} – ${tfRs(p.entry_zone?.[1])}</b></div>
            <div class="tf-neg-bg"><span>Stop-loss (${tfEsc(p.stop_basis)})</span><b>${tfRs(p.stop_loss)}</b><em>Risk ${tfRs(p.risk_per_share)} / share (${tfPct(p.risk_pct, 1)})</em></div>
            <div class="tf-pos-bg"><span>Target 1</span><b>${tfRs(p.target_1)}</b><em>${tfNum(p.target_1_rr, 1)} R</em></div>
            <div class="tf-pos-bg"><span>Target 2</span><b>${tfRs(p.target_2)}</b><em>${tfNum(p.target_2_rr, 1)} R</em></div>
        </div>
        <p class="tf-muted tf-small">Stop = the tighter of 2 × ATR and just below the nearest support (never closer than 1 × ATR). Targets = next resistances, or 2R / 3R when none are close.</p>
    </div>` : ''}`;
}

function tfViewBusiness(d) {
    const f = d.fundamental || {}, c = f.company || {}, cc = f.concall, ts = f.tapetide_score, op = f.options;
    const sentiment = s => s ? `<span class="tf-tag ${s === 'positive' ? 'tf-tag--ok' : s === 'negative' ? 'tf-tag--bad' : ''}">${tfEsc(s)}</span>` : '';
    return `
    <div class="tf-card"><h4>About ${tfEsc(c.name || d.name)}</h4>
        <p class="tf-about">${tfEsc(c.about || 'No description available.')}</p>
        ${tfMetricGrid([
            ['Sector path', tfEsc([c.sector, c.industry, c.basic_industry].filter(Boolean).join(' › ') || '—')],
            ['Listed since', tfEsc(c.listing_date || '—')], ['CEO', tfEsc(c.ceo || '—')],
            ['Employees', tfNum(c.employees, 0)], ['Website', c.website ? `<a href="https://${tfEsc(c.website)}" target="_blank" rel="noopener noreferrer">${tfEsc(c.website)}</a>` : '—'],
            ['ISIN', tfEsc(d.isin || '—')],
        ])}
        ${(c.pros || []).length || (c.cons || []).length ? `<div class="tf-two">
            <div><h5 class="tf-pos">Pros (Tapetide)</h5><ul class="tf-list">${(c.pros || []).map(x => `<li>${tfEsc(x)}</li>`).join('')}</ul></div>
            <div><h5 class="tf-neg">Cons (Tapetide)</h5><ul class="tf-list">${(c.cons || []).map(x => `<li>${tfEsc(x)}</li>`).join('')}</ul></div></div>` : ''}
    </div>
    ${cc ? `<div class="tf-card"><h4>Latest earnings call — ${tfEsc(cc.period || '')}</h4>
        <div class="tf-three">
            <div><h5 class="tf-pos">Highlights</h5><ul class="tf-list">${cc.highlights.map(x => `<li>${tfEsc(x)}</li>`).join('')}</ul></div>
            <div><h5 class="tf-neg">Risks</h5><ul class="tf-list">${cc.risks.map(x => `<li>${tfEsc(x)}</li>`).join('')}</ul></div>
            <div><h5>Guidance</h5><ul class="tf-list">${cc.guidance.map(x => `<li>${tfEsc(x)}</li>`).join('')}</ul></div>
        </div><p class="tf-muted tf-small">AI-generated digest of the concall transcript (Tapetide).</p></div>` : ''}
    ${(f.news || []).length ? `<div class="tf-card"><h4>Recent news</h4><ul class="tf-news">${f.news.map(n => `<li>
        <div class="tf-news-head"><b>${n.url ? `<a href="${tfEsc(n.url)}" target="_blank" rel="noopener noreferrer">${tfEsc(n.title)}</a>` : tfEsc(n.title)}</b>${sentiment(n.sentiment)}<span class="tf-muted">${tfEsc(n.date)}</span></div>
        ${n.summary ? `<p class="tf-muted">${tfEsc(n.summary)}</p>` : ''}</li>`).join('')}</ul></div>` : ''}
    <div class="tf-grid-2">
        ${(f.corporate_actions || []).length ? `<div class="tf-card"><h4>Corporate actions</h4>${tfTable(['Ex-date', 'Type', 'Detail'],
            f.corporate_actions.map(a => [tfEsc(a.ex_date), tfEsc([a.type, a.kind].filter(Boolean).join(' · ')), tfEsc(a.detail)]), 'tf-table--compact')}</div>` : ''}
        ${op ? `<div class="tf-card"><h4>Options market (nearest liquid expiry)</h4>${tfMetricGrid([
            ['Expiry', tfEsc(op.expiry || '—')], ['ATM implied vol', tfPct(op.atm_iv, 1)],
            ['IV rank / percentile', `${tfNum(op.iv_rank, 0)} / ${tfNum(op.iv_percentile, 0)}`], ['Put-call ratio (OI)', tfNum(op.pcr_oi, 2)],
            ['Max pain', tfRs(op.max_pain, 0)],
        ])}</div>` : ''}
        ${(f.tickertape_scorecard || []).length ? `<div class="tf-card"><h4>Tickertape scorecard (independent cross-check)</h4>
            ${tfTable(['', 'Rating', 'What it means'], f.tickertape_scorecard.map(x => [tfEsc(x.name), `<b>${tfEsc(x.tag)}</b>`, tfEsc(x.description)]), 'tf-table--compact tf-table--wrap')}</div>` : ''}
        ${ts ? `<div class="tf-card"><h4>Tapetide score (independent cross-check)</h4>
            ${tfMetricGrid([['Score', `${tfNum(ts.score, 0)} / 100`], ['Percentile', tfNum(ts.percentile, 1)], ['Data confidence', tfPct(ts.confidence, 0)]])}
            ${ts.pillars ? tfTable(['Pillar', 'Score'], Object.entries(ts.pillars).map(([k, v]) => [tfEsc(k.replace(/_/g, ' ')), tfNum(v, 0)]), 'tf-table--compact') : ''}</div>` : ''}
        ${(f.credit_ratings || []).length ? `<div class="tf-card"><h4>Credit ratings</h4>${tfTable(['Date', 'Agency', 'Rating', 'Action', 'Outlook'],
            f.credit_ratings.map(r => [tfEsc(r.date), tfEsc(r.agency), tfEsc(r.rating), tfEsc(r.action), tfEsc(r.outlook)]), 'tf-table--compact')}</div>` : ''}
    </div>
    ${!cc && !(f.news || []).length ? `<p class="tf-muted tf-small">The concall digest and news come from Tapetide (1 call each). They appear once its daily limit resets, or when enabled in <code>techno_funda.tapetide_extras</code> in config.yaml.</p>` : ''}`;
}

function tfFooter(d) {
    return `<div class="tf-footer">
        <p><b>Sources:</b> ${tfEsc(d.sources?.prices)}; ${tfEsc(d.sources?.fundamentals)}. Analysis took ${tfEsc(d.elapsed_sec)}s.</p>
        <p class="tf-disclaimer">${tfEsc(d.disclaimer)}</p></div>`;
}

// ── chart ──

function tfDrawChart(d) {
    const canvas = document.getElementById('tf-chart');
    const ch = d.technical?.chart;
    if (_tfChart) { _tfChart.destroy(); _tfChart = null; }
    if (!canvas || !ch || typeof Chart === 'undefined') return;
    const css = getComputedStyle(document.documentElement);
    const grid = css.getPropertyValue('--chart-grid').trim() || 'rgba(128,128,128,0.1)';
    const label = css.getPropertyValue('--chart-label').trim() || '#64748b';
    const accent = css.getPropertyValue('--accent').trim() || '#6366f1';
    _tfChart = new Chart(canvas.getContext('2d'), {
        data: {
            labels: ch.dates,
            datasets: [
                { type: 'line', label: 'Close', data: ch.close, borderColor: accent, borderWidth: 1.8, pointRadius: 0, tension: 0.1, yAxisID: 'y', order: 1 },
                { type: 'line', label: '50-DMA', data: ch.sma50, borderColor: '#f59e0b', borderWidth: 1.3, pointRadius: 0, borderDash: [4, 3], yAxisID: 'y', order: 2 },
                { type: 'line', label: '200-DMA', data: ch.sma200, borderColor: '#ef4444', borderWidth: 1.3, pointRadius: 0, borderDash: [6, 4], yAxisID: 'y', order: 3 },
                { type: 'bar', label: 'Volume', data: ch.volume, backgroundColor: 'rgba(148,163,184,0.25)', yAxisID: 'v', order: 4 },
            ],
        },
        options: {
            responsive: true, maintainAspectRatio: false, animation: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { labels: { color: label, boxWidth: 14, font: { size: 10 } } },
                tooltip: { callbacks: { label: c => c.dataset.label === 'Volume' ? `Volume: ${tfNum(c.raw, 0)}` : `${c.dataset.label}: ₹${tfNum(c.raw, 2)}` } },
            },
            scales: {
                x: { ticks: { color: label, maxTicksLimit: 8, font: { size: 10 } }, grid: { color: grid } },
                y: { position: 'right', ticks: { color: label, font: { size: 10 } }, grid: { color: grid } },
                v: { position: 'left', display: false, beginAtZero: true, max: Math.max(...ch.volume.filter(Boolean)) * 4 || undefined },
            },
        },
    });
}

// ── TechnoFunda glossary: ⓘ buttons that explain every term in plain language ──
// Each entry: t = title, w = what it is, r = how to read it, e = worked example.
// Buttons are attached after each render by matching label text (tfTermKey), so labels that
// come from the backend (check names) are covered without wiring every call site.

const TF_GLOSSARY = {
    // ── Scores & verdict ──
    technofunda: { t: 'TechnoFunda score', w: 'One 0–100 number that blends how good the business is (fundamental score, 55%) with how healthy the price trend is (technical score, 45%).', r: '75+ Strong · 60–74 Positive · 45–59 Neutral · 30–44 Weak · below 30 Poor. It summarises the checklists below; it is not a buy or sell signal on its own.', e: 'Fundamental 72 and technical 58 give 0.55 × 72 + 0.45 × 58 ≈ 66, "Positive".' },
    fundamental_score: { t: 'Fundamental score', w: 'How strong the business and its financials are, from 0 to 100. It averages five pillars: quality, growth, financial health, valuation and ownership.', r: 'Higher is better. It is capped when promoters have pledged a lot of their shares, and pulled toward 50 when too little data was available to judge.', e: 'A debt-free company with 25% ROE, steady growth and a fair P/E typically scores 70+.' },
    technical_score: { t: 'Technical score', w: 'How healthy the price chart is, from 0 to 100. It averages five pillars: trend, momentum, relative strength, volume and risk.', r: 'High = the stock is in an established uptrend with buyers in control. Low = downtrend or weak price action. It says nothing about whether the business is good.', e: 'A stock above its rising 200-day average, beating the Nifty, on rising volume usually scores 70+.' },
    quadrant: { t: 'Techno-funda quadrant', w: 'A plain-language label that combines the two scores: is the business good, and is the chart supportive?', r: '"Quality in momentum" = both strong. "Good business, weak chart" = wait for the trend to turn. "Momentum without fundamental support" = a trade at best, not an investment. "Weak on both counts" = no edge.', e: 'Fundamental 72 + technical 40 → "Good business, weak chart".' },
    confidence: { t: 'Data confidence', w: 'How many of the checks could actually be run with the data available.', r: 'When few checks ran (new listings, tiny companies, missing filings), the score is pulled toward a neutral 50 so a handful of passes cannot make a stock look great.', e: 'Only 6 of ~25 checks had data → a raw 85 is shown as about 64.' },
    governance: { t: 'Governance cap', w: 'A ceiling on the fundamental score when promoters have pledged a large part of their shares as loan collateral.', r: '≥ 50% of the promoter stake pledged caps the score at 50; ≥ 20% caps it at 65. A falling price can force lenders to sell pledged shares, which pushes the price down further.', e: 'Promoters own 55%, and all of it is pledged → the score cannot exceed 50, however good the profits are.' },
    // pillars
    p_quality: { t: 'Quality pillar', w: 'Does the company earn high returns on the money it uses, and are its profits real cash?', r: 'Built from ROE, ROCE, cash conversion, free cash flow, other income, debtor days and the Piotroski score.', e: 'ROCE 30% and operating cash flow matching profit → high quality.' },
    p_growth: { t: 'Growth pillar', w: 'Are sales and profits growing, both over years and in the latest quarter?', r: 'Built from 3/5-year sales and profit CAGR, the latest quarter vs a year ago, margin trend and EPS growth.', e: 'Sales +15% a year for 3 years and the last quarter’s profit +20% YoY → strong growth.' },
    p_health: { t: 'Financial health pillar', w: 'Can the company comfortably carry its debt?', r: 'Built from debt/equity, interest coverage, whether debt grows faster than sales, net worth and share dilution. Banks and NBFCs are judged on net-worth growth and ROE instead, because borrowing is their business.', e: 'Debt/equity 0.2 and interest covered 15× → very healthy.' },
    p_valuation: { t: 'Valuation pillar', w: 'Is the price reasonable for what you get?', r: 'Built from P/E vs its own history, PEG, earnings yield vs government bonds and the analyst target. A great business can still be a poor buy at too high a price.', e: 'P/E 18 when it usually trades at 25 → attractive on valuation.' },
    p_ownership: { t: 'Ownership pillar', w: 'Who owns the company, and are insiders and institutions buying or selling?', r: 'Built from promoter holding, promoter selling, pledged shares, and whether FIIs/DIIs are adding.', e: 'Promoters hold 60%, none pledged, mutual funds raising their stake → strong ownership.' },
    p_trend: { t: 'Trend pillar', w: 'Is the stock in a sustained uptrend?', r: 'Built from price vs the 20/50/200-day averages, the slope of the 200-day average, the Minervini template and the Weinstein stage.', e: 'Price above a rising 200-DMA with the 50-DMA above it → strong trend.' },
    p_momentum: { t: 'Momentum pillar', w: 'Is the recent move gaining or losing strength?', r: 'Built from RSI, MACD, ADX and the 3-month return.', e: 'RSI 62, MACD above its signal line, ADX 30 → good momentum.' },
    p_rs: { t: 'Relative strength pillar', w: 'Is the stock doing better than the overall market (Nifty 50)?', r: 'Market leaders usually keep leading. Built from 3/6/12-month out-performance and the Mansfield RS.', e: 'Stock +25% in 6 months while the Nifty is +8% → strong relative strength.' },
    p_volume: { t: 'Volume pillar', w: 'Is trading volume confirming the price move?', r: 'Big players leave footprints in volume. Rising prices on rising volume = accumulation; falling prices on rising volume = distribution.', e: '15 accumulation days vs 6 distribution days in a month → buyers in control.' },
    p_risk: { t: 'Risk / volatility pillar', w: 'How wild are the price swings, and is the stock over-stretched?', r: 'Built from ATR %, distance above the 50-DMA, Bollinger Bands and the worst fall in the last year.', e: 'Daily range 1.5% of price and only 5% above the 50-DMA → calm, not over-extended.' },

    // ── Valuation ──
    market_cap: { t: 'Market capitalisation', w: 'The total value the stock market puts on the company: share price × number of shares.', r: 'In India: large cap ≈ top 100 companies, mid cap 101–250, small cap the rest. Bigger usually means more stable but slower-growing.', e: '1,000 crore shares × ₹500 = ₹5,00,000 crore market cap.' },
    pe: { t: 'P/E ratio (price to earnings)', w: 'How many rupees investors pay for every ₹1 of yearly profit per share. TTM = the last 12 months.', r: 'Lower = cheaper, but compare with the company’s own history and peers. Fast growers deserve higher P/Es; a very low P/E can mean the market expects trouble.', e: 'Price ₹500, EPS ₹25 → P/E 20: you pay ₹20 for each ₹1 of annual profit.' },
    forward_pe: { t: 'Forward P/E', w: 'Price divided by next year’s expected EPS (analyst consensus), instead of last year’s.', r: 'Forward P/E below the current P/E means analysts expect profits to grow.', e: 'Price ₹500, expected EPS ₹32 → forward P/E 15.6, vs 20 on last year’s earnings.' },
    median_pe: { t: 'Median P/E (own history)', w: 'The P/E the stock has typically traded at over the past few years.', r: 'Today’s P/E well below its own median can mean it is cheap, or that the business has changed. Above the median = the market is paying more than usual.', e: 'Usually traded at 25× earnings, now at 17× → 32% below its normal valuation.' },
    peg: { t: 'PEG ratio', w: 'P/E divided by the yearly earnings growth rate. It adjusts the P/E for growth.', r: 'Below 1 = cheap for its growth · 1–1.5 fair · above 2 expensive for its growth.', e: 'P/E 30 with EPS growing 30% a year → PEG 1.0. P/E 30 growing 10% → PEG 3.0.' },
    pb: { t: 'P/B ratio (price to book)', w: 'Share price divided by book value per share (what shareholders would own on paper if everything were sold and debts paid).', r: 'Most useful for banks and asset-heavy firms. A P/B under 1 means the market values the company below its net assets. High-ROE companies justify high P/Bs.', e: 'Price ₹300, book value ₹100 per share → P/B 3.' },
    earnings_yield: { t: 'Earnings yield', w: 'The P/E turned upside down: profit per share as a % of the price.', r: 'Compare it with the ~6.5% a 10-year government bond pays risk-free. An earnings yield above that leaves room for the extra risk of shares.', e: 'P/E 16 → earnings yield 1 ÷ 16 = 6.25%.' },
    eps: { t: 'EPS (earnings per share)', w: 'Net profit divided by the number of shares: the profit that belongs to each share.', r: 'Rising EPS over the years is what ultimately pushes share prices up.', e: 'Net profit ₹1,000 crore, 50 crore shares → EPS ₹20.' },
    book_value: { t: 'Book value per share', w: 'Shareholders’ equity (capital + reserves) divided by the number of shares.', r: 'Steady growth in book value means the company is retaining and compounding profits.', e: 'Equity ₹5,000 crore, 50 crore shares → book value ₹100 per share.' },
    dividend_yield: { t: 'Dividend yield', w: 'Yearly dividends per share as a % of the share price.', r: 'Income you receive in cash. Very high yields can be a warning sign if the price has collapsed.', e: '₹10 dividend a year on a ₹400 share → 2.5% yield.' },
    graham: { t: 'Graham number', w: 'A conservative maximum fair price from Benjamin Graham: √(22.5 × EPS × book value per share).', r: 'Built for slow-growing, asset-heavy value stocks. Quality growth companies almost always trade well above it, so treat it as a deep-value floor, not a target.', e: 'EPS ₹20, book value ₹150 → √(22.5 × 20 × 150) ≈ ₹260.' },
    value_median_pe: { t: 'Value at own median P/E', w: 'Where the price would be if the stock returned to its usual P/E: EPS × median P/E.', r: 'A rough "re-rating" target. It assumes the old valuation is still deserved, which is not always true if growth has slowed.', e: 'Forward EPS ₹32 × median P/E 22 ≈ ₹704.' },
    fair_band: { t: '12–20× earnings band', w: 'A conservative fair-value range: EPS multiplied by a P/E of 12 (low) to 20 (high). The Value Investing tab uses the same formula.', r: 'Price below the low end = cheap on plain-vanilla earnings. Fast growers usually trade above the band.', e: 'EPS ₹25 → fair band ₹300 – ₹500.' },
    dcf: { t: 'Mini-DCF (discounted cash flow)', w: 'Values the share by projecting EPS 5 years ahead at an assumed growth rate, then discounting each year back to today at 12% (the return you could demand elsewhere).', r: 'Gives a low–high range for two growth assumptions. Very sensitive to the growth rate, so use it as a sanity check, not a precise target.', e: 'EPS ₹25 growing 10% a year, discounted at 12%, with an exit P/E of 12 → about ₹300.' },
    analyst_target: { t: 'Analyst price target', w: 'The average 12-month price target published by brokerage analysts who cover the stock, with their lowest and highest targets.', r: 'Upside = how far the target is above today’s price. Analysts are often optimistic and late, so treat it as one input.', e: 'Mean target ₹600 vs price ₹500 → +20% upside.' },

    // ── Growth ──
    cagr: { t: 'CAGR (compound annual growth rate)', w: 'The steady yearly growth rate that would turn the starting value into the ending value.', r: '10–15% a year is good for a large company; 20%+ is excellent if it is consistent.', e: 'Sales ₹1,000 cr → ₹1,520 cr in 3 years = 15% CAGR (1.15 × 1.15 × 1.15 ≈ 1.52).' },
    yoy: { t: 'YoY (year on year)', w: 'Compares a quarter with the same quarter a year earlier.', r: 'Removes seasonal effects (festive quarters, monsoon), so it is the fairest way to judge quarterly results.', e: 'Sep-2026 quarter profit ₹120 cr vs Sep-2025 ₹100 cr → +20% YoY.' },
    qoq: { t: 'QoQ (quarter on quarter)', w: 'Compares a quarter with the quarter just before it.', r: 'Shows short-term direction, but seasonality can distort it.', e: 'Sales ₹520 cr this quarter vs ₹505 cr last quarter → +3% QoQ.' },
    ttm: { t: 'TTM (trailing twelve months)', w: 'The total of the last four reported quarters.', r: 'More up to date than the last full financial year.', e: 'In November, TTM = the Dec, Mar, Jun and Sep quarters added together.' },
    opm: { t: 'OPM (operating profit margin)', w: 'Operating profit (before interest, depreciation and tax) as a % of sales.', r: 'Shows pricing power and cost control. Stable or rising margins are good; falling margins often come before profit downgrades.', e: 'Sales ₹1,000 cr, operating profit ₹220 cr → OPM 22%.' },
    eps_growth: { t: 'EPS growth', w: 'How fast profit per share is growing, usually as a 3- or 5-year CAGR.', r: 'Over the long run share prices tend to follow EPS. 10%+ a year is healthy.', e: 'EPS ₹10 → ₹16.1 in 5 years = 10% CAGR.' },

    // ── Quality ──
    roe: { t: 'ROE (return on equity)', w: 'Net profit as a % of shareholders’ money (equity).', r: '15%+ is good, 20%+ excellent. Check it is not inflated by heavy debt.', e: 'Profit ₹200 cr on equity of ₹1,000 cr → ROE 20%.' },
    roce: { t: 'ROCE (return on capital employed)', w: 'Operating profit (EBIT) as a % of all capital used, debt included.', r: 'The best single measure of business quality: how much the company earns on every rupee invested. 15%+ good, 25%+ outstanding. Not meaningful for banks.', e: 'EBIT ₹300 cr on capital (equity + debt) of ₹1,200 cr → ROCE 25%.' },
    cash_conversion: { t: 'Cash conversion (CFO ÷ PAT)', w: 'Operating cash flow divided by net profit (PAT), added up over 5 years.', r: 'Profits are an accounting figure; cash is real. Around 1× or more = profits are backed by cash. Well below 0.8× = money stuck in receivables or inventory, a classic warning sign.', e: '5-year operating cash ₹950 cr vs profit ₹1,000 cr → 0.95×, healthy.' },
    fcf: { t: 'Free cash flow (FCF)', w: 'Operating cash flow minus capital expenditure: cash left after keeping the business running and growing.', r: 'FCF pays dividends, buybacks and debt. Positive in most years is a strong sign; persistently negative needs a good reason (heavy expansion).', e: 'Operating cash ₹500 cr − capex ₹200 cr = FCF ₹300 cr.' },
    other_income: { t: 'Other income share', w: 'Income that is not from the main business (interest on cash, one-off gains) as a % of profit before tax.', r: 'Under 25% is fine. If a big chunk of profit is other income, the core business is weaker than the headline profit suggests.', e: 'PBT ₹400 cr including ₹160 cr of treasury income → 40%, a red flag.' },
    debtor_days: { t: 'Debtor days', w: 'On average, how many days customers take to pay their bills.', r: 'Rising debtor days can mean the company is pushing sales on credit or customers are struggling; it also ties up cash.', e: 'Debtor days going from 60 to 95 in 3 years → a warning sign.' },
    piotroski: { t: 'Piotroski F-score', w: 'A checklist by Prof. Joseph Piotroski scoring 1 point per test: profitable, positive cash flow, improving returns, cash above profit, falling leverage, no new shares, improving margin and asset turnover. (8 tests here; the current-ratio test needs data not available.)', r: '6+ = financially strengthening · 4–5 = mixed · 0–3 = weakening. Not used for banks.', e: 'A company passing 7 of 8 tests is improving on almost every front.' },
    dividend_payout: { t: 'Dividend payout ratio', w: 'The % of net profit paid out as dividends.', r: 'High payout with little growth = mature cash cow; low payout = profits being reinvested. Above 100% is not sustainable.', e: 'Profit ₹100 cr, dividends ₹35 cr → 35% payout.' },
    tax_rate: { t: 'Tax rate', w: 'Tax paid as a % of profit before tax.', r: 'India’s corporate rate is roughly 25%. Unusually low rates may come from one-off benefits that will not repeat.', e: 'PBT ₹100 cr, tax ₹25 cr → 25%.' },
    profitable: { t: 'Profitable on a TTM basis', w: 'Whether the company made a net profit over the last 12 months.', r: 'A loss-making company has no meaningful P/E, and losses eat into net worth.', e: 'Net profit −₹15 cr over the last four quarters → fails this check.' },

    // ── Financial health ──
    de: { t: 'Debt to equity', w: 'Total borrowings divided by shareholders’ equity.', r: 'Below 0.5 comfortable · 0.5–1 moderate · above 1 high for most businesses. Not meaningful for banks and NBFCs, which borrow to lend.', e: 'Borrowings ₹300 cr, equity ₹1,000 cr → D/E 0.3.' },
    icr: { t: 'Interest coverage', w: 'How many times operating profit (before interest and tax) covers the yearly interest bill.', r: 'Above 5× is safe; below 2.5× means a bad year could make it hard to pay lenders.', e: 'EBIT ₹500 cr, interest ₹50 cr → 10× coverage.' },
    net_worth: { t: 'Net worth', w: 'Shareholders’ equity: share capital plus accumulated reserves. What would be left for shareholders after paying all liabilities.', r: 'Negative net worth means accumulated losses exceed all the capital put in, a serious red flag.', e: 'Capital ₹50 cr + reserves ₹950 cr = net worth ₹1,000 cr.' },
    borrowings: { t: 'Borrowings growth', w: 'How fast the company’s debt is growing compared with its sales.', r: 'Debt growing much faster than sales means growth is being bought with borrowed money.', e: 'Debt growing 25% a year while sales grow 8% → fails the check.' },
    dilution: { t: 'Equity dilution', w: 'The increase in share capital, i.e. new shares issued.', r: 'New shares split the same profit among more owners. Bonus issues, splits and mergers also raise share capital, so check the reason.', e: 'Share capital up 30% in 3 years from fund-raising → each share owns 23% less of the company.' },
    lender: { t: 'Why lenders are treated differently', w: 'For banks, NBFCs and insurers, borrowing (deposits, bonds) is the raw material of the business.', r: 'Debt/equity, interest coverage, other income and Piotroski checks do not apply. Net-worth growth and ROE are used instead.', e: 'HDFC Bank’s "debt" is mostly customer deposits it lends out, so a high D/E is normal.' },

    // ── Ownership ──
    promoter: { t: 'Promoter holding', w: 'The % of shares owned by the founders or controlling group.', r: 'High holding (40%+) means the owners have skin in the game. Promoters selling steadily can be a warning; buying is usually a vote of confidence.', e: 'The Tata group holding ~72% of TCS.' },
    pledge: { t: 'Promoter pledge', w: 'The % of the promoters’ own shares given to lenders as collateral for loans.', r: 'Below 5% fine · 20%+ risky · 50%+ serious. If the price falls, lenders can sell pledged shares, causing a sharper fall.', e: 'Promoters hold 50 lakh shares and pledged 30 lakh → 60% pledged.' },
    fii_dii: { t: 'FII and DII holding', w: 'FII = foreign institutional investors (overseas funds). DII = domestic institutions (Indian mutual funds, LIC, insurers).', r: 'Institutions do deep research; their holding rising over a year is a positive signal, falling is a caution.', e: 'FII + DII going from 20% to 24% in a year → institutions are accumulating.' },
    shareholders: { t: 'Number of shareholders', w: 'How many individual and institutional holders own the stock.', r: 'A sharp rise in small shareholders after a big rally can mean retail is chasing the stock.', e: 'Holders up from 2 lakh to 5 lakh in a year.' },
    deals: { t: 'Bulk, block and insider deals', w: 'Bulk deal = one party trades over 0.5% of the company’s shares in a day. Block deal = a large trade (≥ ₹10 crore) in a special window. Insider = trades by directors and key staff.', r: 'Shows who is buying or selling large quantities.', e: 'A mutual fund buying 1% of the company in a block deal.' },

    // ── Statements ──
    consolidated: { t: 'Consolidated vs standalone', w: 'Consolidated accounts include subsidiaries; standalone covers only the parent company.', r: 'Consolidated is usually the truer picture of a group. This report uses consolidated when complete, otherwise standalone.', e: 'A company whose subsidiaries run the overseas business looks much smaller on a standalone basis.' },

    // ── Trend & moving averages ──
    dma: { t: 'Moving average (DMA / SMA)', w: 'The average closing price over the last N trading days, updated every day. DMA = daily moving average; SMA = simple moving average.', r: 'Price above a rising average = uptrend. The 50-DMA tracks the medium-term trend and the 200-DMA the long-term trend.', e: 'Average of the last 200 closes = ₹480 while price is ₹520 → 8% above the 200-DMA.' },
    ema: { t: 'EMA (exponential moving average)', w: 'A moving average that gives more weight to recent prices, so it reacts faster.', r: 'EMA 9 above EMA 21 = short-term momentum is up.', e: 'After a sharp rally the EMA 9 rises above the EMA 21 within days.' },
    dma200: { t: '200-day moving average', w: 'Average of the last 200 closing prices: the most watched long-term trend line.', r: 'Above a rising 200-DMA = long-term uptrend. Many institutions avoid stocks below a falling 200-DMA.', e: 'Price ₹520, 200-DMA ₹480 and rising → long-term uptrend intact.' },
    cross: { t: 'Golden cross / death cross', w: 'Golden cross: the 50-DMA crosses above the 200-DMA. Death cross: it crosses below.', r: 'A golden cross often marks the start of a longer uptrend; a death cross the start of a downtrend. Both lag the price.', e: '50-DMA moves from ₹470 to ₹485 while the 200-DMA is ₹480 → golden cross.' },
    template: { t: 'Minervini trend template', w: 'Seven conditions trader Mark Minervini uses to make sure a stock is in a strong Stage 2 uptrend before considering it.', r: '7/7 = textbook uptrend · 5–6 = mostly there · fewer = not in a confirmed uptrend.', e: 'Price above the 150- and 200-DMA, both rising, at least 30% above the 52-week low and within 25% of the high.' },
    stage: { t: 'Weinstein stage', w: 'Stan Weinstein’s four market stages based on the 30-week moving average: 1 Basing, 2 Advancing, 3 Topping, 4 Declining.', r: 'Stage 2 (price above a rising 30-week average) is where most big gains happen. Avoid Stage 4.', e: 'After months moving sideways, price breaks above a now-rising 30-week MA → Stage 2 begins.' },
    weekly_trend: { t: 'Weekly trend', w: 'Direction of the weekly chart, using the 10-week moving average.', r: 'Up = weekly close above a rising 10-week MA. Weekly trends filter out daily noise.', e: 'Weekly close ₹510, 10-week MA ₹495 and rising → "up".' },
    slope200: { t: '200-DMA slope', w: 'How much the 200-day average has moved over the last month.', r: 'Positive = the long-term trend is still rising; negative = it has turned down.', e: '200-DMA from ₹470 to ₹480 in a month → +2.1%.' },

    // ── Momentum ──
    rsi: { t: 'RSI (Relative Strength Index)', w: 'A 0–100 gauge of how strong recent gains are compared with recent losses (14 days).', r: 'Above 70 = overbought (stretched) · below 30 = oversold · 50–70 = healthy uptrend zone. Strong stocks can stay overbought for weeks.', e: 'RSI 62 → rising steadily without being stretched.' },
    macd: { t: 'MACD', w: 'Moving Average Convergence Divergence: the gap between the 12- and 26-day EMAs (the MACD line), and its own 9-day average (the signal line).', r: 'MACD above the signal line = momentum turning up. Above zero = the short-term trend is above the longer one.', e: 'MACD 4.2 vs signal 3.1 → bullish momentum; a growing histogram means it is accelerating.' },
    adx: { t: 'ADX and +DI / −DI', w: 'ADX measures how strong a trend is (not its direction). +DI and −DI show whether buyers or sellers dominate.', r: 'ADX above 25 = strong trend · below 20 = no real trend. +DI above −DI = buyers in control.', e: 'ADX 32, +DI 28, −DI 14 → a strong uptrend.' },
    stoch: { t: 'Stochastic %K / %D', w: 'Where today’s close sits within the last 14 days’ high–low range, from 0 to 100.', r: 'Above 80 = near the top of the range · below 20 = near the bottom. %D is a smoothed %K.', e: '14-day range ₹450–₹520, close ₹510 → %K ≈ 86.' },
    returns: { t: 'Returns', w: 'Price change over 1 week, 1 month, 3, 6 and 12 months.', r: 'Compare with the Nifty row to see whether the stock beat the market.', e: 'Stock +18% in 6 months vs Nifty +7% → out-performed by 11 points.' },

    // ── Relative strength ──
    rs: { t: 'Relative strength vs Nifty', w: 'The stock’s return minus the Nifty 50’s return over the same period.', r: 'Positive = beating the market. Leaders tend to keep leading; laggards keep lagging.', e: 'Stock +12% in 3 months, Nifty +4% → +8 points out-performance.' },
    mansfield: { t: 'Mansfield RS', w: 'The stock-to-Nifty price ratio compared with its own 52-week average.', r: 'Above 0 = currently stronger than the market relative to the past year; rising = improving.', e: 'Mansfield RS +12 → noticeably stronger than its usual relationship with the Nifty.' },
    rs_line: { t: 'RS line', w: 'A line of the stock price divided by the Nifty 50.', r: 'A rising RS line means the stock is out-performing, even if both are falling.', e: 'Nifty −5%, stock −1% → the RS line still rises.' },

    // ── Volume ──
    rel_volume: { t: 'Relative volume', w: 'Today’s volume divided by the 20-day average volume.', r: 'Above 1.5× = unusual interest; a breakout on high relative volume is more trustworthy.', e: '30 lakh shares traded vs a 20 lakh average → 1.5×.' },
    acc_dist: { t: 'Accumulation / distribution days', w: 'Accumulation day: price up on higher volume than the previous day. Distribution day: price down on higher volume.', r: 'More accumulation than distribution = institutions are buying. Clusters of distribution days often come before declines.', e: '12 accumulation vs 5 distribution days in 25 sessions → buyers in control.' },
    updown: { t: 'Up/down volume ratio', w: 'Total volume on up days divided by total volume on down days over 50 sessions.', r: 'Above 1 = more volume when the price rises, i.e. buying pressure.', e: '4 crore shares on up days vs 2.5 crore on down days → 1.6.' },
    obv: { t: 'OBV (on-balance volume)', w: 'A running total that adds the day’s volume on up days and subtracts it on down days.', r: 'Rising OBV = volume flowing into the stock. OBV rising while price is flat can come before a breakout.', e: 'Price flat for a month but OBV climbing → quiet accumulation.' },

    // ── Volatility & risk ──
    atr: { t: 'ATR (average true range)', w: 'The average daily price range over 14 days, including overnight gaps.', r: 'Shows typical daily movement and is used to set stop-losses. ATR above 4% of price = a volatile stock.', e: 'ATR ₹15 on a ₹500 share = 3%: a ₹15 move is an ordinary day.' },
    hv: { t: 'Historical volatility', w: 'How much the price has swung over the last 20 days, scaled to a yearly %.', r: 'Under 25% calm · 25–40% normal for mid caps · above 50% very volatile.', e: 'HV 30% → roughly ±30% price swings over a year.' },
    bollinger: { t: 'Bollinger Bands and %B', w: 'Bands drawn 2 standard deviations above and below the 20-day average. %B shows where price sits: 0 = lower band, 1 = upper band.', r: '%B above 1 = unusually strong (or stretched) · below 0 = unusually weak.', e: 'Bands ₹470–₹530, price ₹520 → %B ≈ 0.83.' },
    squeeze: { t: 'Band width and squeeze', w: 'The distance between the Bollinger Bands as a % of price. A squeeze = band width in its lowest 20% of the last 6 months.', r: 'Quiet periods often come before big moves; a squeeze warns that a breakout or breakdown may be near.', e: 'Band width shrinks to 4% after months at 10% → squeeze.' },
    extended: { t: 'Over-extended', w: 'How far the price has run above its 50-day average.', r: 'More than ~15% above the 50-DMA = stretched; a pullback becomes more likely.', e: 'Price ₹580, 50-DMA ₹500 → 16% above, over-extended.' },
    drawdown: { t: 'Maximum drawdown', w: 'The biggest fall from a peak to a later low over the last year.', r: 'Shows the pain a holder would have sat through. Worse than −35% = a rough ride.', e: 'Peak ₹600, later low ₹420 → −30% drawdown.' },

    // ── Levels ──
    support: { t: 'Support and resistance', w: 'Support: a price zone where buyers have repeatedly stepped in. Resistance: a zone where sellers have repeatedly appeared. Touches = how many times price turned there.', r: 'More touches = a stronger level. A close above resistance on high volume is a breakout; a close below support is a breakdown.', e: 'The stock bounced off ₹450 three times → strong support at ₹450.' },
    range52: { t: '52-week high / low', w: 'The highest and lowest prices of the last year.', r: 'Stocks near their 52-week high are often leaders; near the low, often laggards.', e: '52-week range ₹380–₹560, price ₹540 → 4% below the high.' },
    pivot: { t: 'Weekly pivot points', w: 'Levels calculated from last week’s high, low and close: Pivot = (H + L + C) ÷ 3, with resistances R1/R2 above and supports S1/S2 below.', r: 'Many traders watch these as intraday and swing levels. Above the pivot = bullish bias for the week.', e: 'Last week H ₹520, L ₹480, C ₹510 → pivot ₹503.' },
    fib: { t: 'Fibonacci retracements', w: 'Levels at 23.6%, 38.2%, 50%, 61.8% and 78.6% of the distance between the 52-week high and low.', r: 'Pullbacks in an uptrend often pause near the 38.2%–61.8% levels.', e: 'High ₹600, low ₹400 → 50% retracement at ₹500.' },

    // ── Reference levels ──
    entry: { t: 'Entry zone', w: 'A price band where buying would keep risk reasonable: between just above the stop and the current price (or the 50-DMA when it is close).', r: 'Educational reference only, not a recommendation.', e: 'Entry zone ₹495–₹510 with a stop at ₹470.' },
    stop: { t: 'Stop-loss', w: 'A pre-decided price at which you exit to limit losses if the trade goes wrong.', r: 'Set here at the tighter of 2 × ATR below the price and just below the nearest support, but never closer than 1 × ATR so normal noise does not trigger it.', e: 'Price ₹510, ATR ₹12, support ₹478 → stop ≈ ₹486.' },
    target: { t: 'Targets and R-multiple', w: 'Target = a price to take profit, usually the next resistance. R = risk per share (entry − stop). A 2R target makes twice what you risk.', r: 'Look for at least 2R so one winner pays for two losers.', e: 'Entry ₹510, stop ₹490 (risk ₹20), target ₹550 → 2R.' },

    // ── Options & cross-checks ──
    iv: { t: 'Implied volatility (IV)', w: 'The yearly volatility that option prices imply, i.e. how big a move the options market expects.', r: 'High IV = options are expensive and a big move is expected (often around results).', e: 'ATM IV 30% → the market expects roughly ±30% movement over a year.' },
    iv_rank: { t: 'IV rank / percentile', w: 'Where today’s implied volatility sits compared with its own past year (0–100).', r: 'High (70+) = options are expensive vs usual; low = cheap.', e: 'IV rank 85 → options are pricier than on most days of the past year.' },
    pcr: { t: 'Put-call ratio (OI)', w: 'Open interest in put options divided by open interest in call options.', r: 'Above 1 = more puts, often read as hedging or bearish positioning; very high readings are sometimes contrarian-bullish.', e: '9 lakh puts vs 12 lakh calls open → PCR 0.75.' },
    max_pain: { t: 'Max pain', w: 'The strike price at which option buyers as a group would lose the most money at expiry.', r: 'Some traders believe prices drift toward max pain near expiry. A weak signal.', e: 'Max pain ₹2,480 with the stock at ₹2,460.' },
    scorecard: { t: 'Tickertape scorecard', w: 'Tickertape’s own independent ratings of performance, valuation, growth, profitability, entry point and red flags.', r: 'Use it as a second opinion next to this report’s scores. For valuation, "Low" = cheap; for red flags, "Low" = few red flags.', e: 'Profitability High, Valuation Low → a profitable company at an undemanding price.' },
    tapetide_score: { t: 'Tapetide score', w: 'Tapetide’s own 0–100 composite across financial health, growth, momentum, ownership, quality and valuation.', r: 'An independent cross-check; percentile shows where it ranks among ~4,500 stocks.', e: 'Score 62, percentile 93 → better than 93% of listed stocks on their model.' },
    concall: { t: 'Earnings call (concall)', w: 'The conference call where management discusses quarterly results with analysts. Shown here as an AI summary of the transcript.', r: 'Look for guidance (management’s outlook) and the risks they admit to.', e: '"Margins expected to stay at 24% this year; North America demand still weak."' },
};

// Text pattern → term. Order matters: specific patterns first.
const TF_TERM_RULES = [
    // scores & verdict
    [/^techno ?funda$/i, 'technofunda'], [/^fundamental$|fundamental score/i, 'fundamental_score'], [/^technical$|technical score/i, 'technical_score'],
    [/quality in momentum|good business|momentum without|weak on both|mixed signals/i, 'quadrant'],
    [/governance/i, 'governance'], [/data confidence/i, 'confidence'],
    // pillar names / checklist titles (anchored so "Risks / weaknesses" etc. don't match)
    [/^quality( checks)?$/i, 'p_quality'], [/^growth( checks)?$/i, 'p_growth'], [/^financial health( checks)?$|^balance sheet$/i, 'p_health'],
    [/^valuation( checks)?$/i, 'p_valuation'], [/^ownership( checks)?$/i, 'p_ownership'], [/^trend( checks)?$/i, 'p_trend'],
    [/^momentum( checks)?$/i, 'p_momentum'], [/^relative strength( vs nifty 50)?$/i, 'p_rs'], [/^volume( checks)?$/i, 'p_volume'],
    [/^risk ?(&|\/) ?volatility/i, 'p_risk'],
    // reference levels before ATR / DMA
    [/entry zone/i, 'entry'], [/stop-loss/i, 'stop'], [/^target \d|^reference levels/i, 'target'],
    // structure
    [/minervini|trend template/i, 'template'], [/weinstein|^stage/i, 'stage'], [/piotroski/i, 'piotroski'],
    [/golden|death|50\/200 cross|50-DMA above 200-DMA/i, 'cross'], [/200-DMA slope|200-DMA rising|200-DMA trending/i, 'slope200'],
    [/weekly trend/i, 'weekly_trend'], [/weekly pivot|^pivot/i, 'pivot'], [/fibonacci/i, 'fib'],
    [/over-extended/i, 'extended'],
    // ownership before YoY/QoQ/CAGR (e.g. "Promoter change (QoQ)")
    [/pledge/i, 'pledge'], [/promoter/i, 'promoter'], [/fii|dii|institution/i, 'fii_dii'], [/shareholders/i, 'shareholders'],
    [/bulk|block|insider/i, 'deals'], [/^shareholding$/i, 'fii_dii'],
    // valuation
    [/value at own median/i, 'value_median_pe'], [/forward p\/e/i, 'forward_pe'],
    [/median p\/e|p\/e at or below its own/i, 'median_pe'],
    [/\bpeg\b/i, 'peg'], [/earnings yield/i, 'earnings_yield'], [/graham/i, 'graham'], [/12–20×|earnings band/i, 'fair_band'],
    [/dcf/i, 'dcf'], [/analyst|upside to mean target/i, 'analyst_target'],
    [/company is profitable|profitable on a ttm/i, 'profitable'],
    [/\bp\/b\b/i, 'pb'], [/\bp\/e\b|^pe\b/i, 'pe'], [/market cap/i, 'market_cap'],
    // balance sheet before CAGR (e.g. "Borrowings CAGR 3Y")
    [/debt \/ equity|debt to equity/i, 'de'], [/^leverage tests/i, 'lender'], [/interest coverage/i, 'icr'], [/net worth/i, 'net_worth'],
    [/borrowings/i, 'borrowings'], [/dilution|share capital change/i, 'dilution'],
    // growth / earnings
    [/eps .*cagr|eps growth/i, 'eps_growth'], [/\beps\b/i, 'eps'], [/book value/i, 'book_value'], [/dividend yield|div\. yield/i, 'dividend_yield'],
    [/dividend payout/i, 'dividend_payout'], [/tax rate/i, 'tax_rate'],
    [/cagr/i, 'cagr'], [/\byoy\b/i, 'yoy'], [/\bqoq\b/i, 'qoq'], [/^ttm$/i, 'ttm'],
    [/operating margin|\bopm\b/i, 'opm'],
    // quality
    [/roce/i, 'roce'], [/\broe\b|capital adequacy/i, 'roe'], [/cash conversion|convert to cash|\bcfo\b/i, 'cash_conversion'],
    [/free cash flow|\bfcf\b/i, 'fcf'], [/other income|core earnings/i, 'other_income'], [/debtor days/i, 'debtor_days'],
    // averages & momentum
    [/^price, 50-dma/i, 'dma'], [/^ema\b|ema 9|ema 21/i, 'ema'], [/200-dma|sma 200/i, 'dma200'], [/\bdma\b|-dma\b|^sma\b|moving average/i, 'dma'],
    [/rsi/i, 'rsi'], [/macd/i, 'macd'], [/adx/i, 'adx'], [/stochastic/i, 'stoch'], [/^returns$|3-month return/i, 'returns'],
    [/mansfield/i, 'mansfield'], [/rs line/i, 'rs_line'], [/outperforming nifty|out \/ under-performance|relative strength/i, 'rs'],
    // volume
    [/relative volume|20-day volume|avg volume/i, 'rel_volume'], [/accumulation|distribution/i, 'acc_dist'], [/up\/down volume/i, 'updown'], [/\bobv\b/i, 'obv'],
    // volatility & levels
    [/\batr\b/i, 'atr'], [/historical volatility/i, 'hv'], [/band width|squeeze/i, 'squeeze'], [/bollinger/i, 'bollinger'],
    [/drawdown/i, 'drawdown'], [/52-week|52w/i, 'range52'], [/^key levels$|^support$|^resistance$/i, 'support'],
    // options & cross-checks
    [/implied vol|atm iv/i, 'iv'], [/iv rank/i, 'iv_rank'], [/put-call/i, 'pcr'], [/max pain/i, 'max_pain'],
    [/tickertape scorecard/i, 'scorecard'], [/tapetide score/i, 'tapetide_score'], [/earnings call/i, 'concall'],
    [/^consolidated$|^standalone$/i, 'consolidated'],
];

function tfTermKey(text) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (!s || s.length > 90) return null;
    for (const [re, key] of TF_TERM_RULES) if (re.test(s)) return TF_GLOSSARY[key] ? key : null;
    return null;
}

function tfInfoBtn(key) {
    const g = TF_GLOSSARY[key];
    if (!g) return '';
    return `<button type="button" class="tf-i" data-term="${key}" aria-haspopup="dialog" aria-label="What is ${tfEsc(g.t)}?">i</button>`;
}

/** After a render: add an ⓘ next to every label that matches a glossary term. */
function tfAttachInfo(root) {
    if (!root) return;
    const sel = ['.tf-metric > span', '.tf-check-label', '.tf-pillar-name', '.tf-card h4', '.tf-card h5', '.tf-hero-stats > div > span',
        '.tf-gauge-text span', '.tf-quadrant', '.tf-plan-grid > div > span', '.tf-table th', '.tf-table:not(.tf-table--wrap) td:first-child', '.tf-hero-tags .tf-tag'];
    root.querySelectorAll(sel.join(',')).forEach(el => {
        if (el.querySelector('.tf-i') || el.closest('.tf-i')) return;
        // Use the label text without any trailing muted note, e.g. "Reference levels (educational…)".
        const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ').trim() || el.textContent;
        const key = tfTermKey(own);
        if (key) el.insertAdjacentHTML('beforeend', tfInfoBtn(key));
    });
}

// ── popover ──

let _tfTermBtn = null;

function tfShowTerm(btn) {
    const key = btn.dataset.term, g = TF_GLOSSARY[key];
    if (!g) return;
    let pop = document.getElementById('tf-term-pop');
    if (!pop) {
        pop = document.createElement('div');
        pop.id = 'tf-term-pop';
        pop.className = 'tf-term-pop';
        pop.setAttribute('role', 'dialog');
        document.body.appendChild(pop);
    }
    if (_tfTermBtn === btn && !pop.hidden) { tfHideTerm(); return; }
    if (_tfTermBtn) _tfTermBtn.setAttribute('aria-expanded', 'false');
    _tfTermBtn = btn;
    btn.setAttribute('aria-expanded', 'true');
    pop.setAttribute('aria-label', g.t);
    pop.innerHTML = `
        <div class="tf-term-head"><b>${tfEsc(g.t)}</b>
            <button type="button" class="tf-term-close" aria-label="Close" onclick="tfHideTerm(true)">×</button></div>
        <p><span class="tf-term-k">What it is</span>${tfEsc(g.w)}</p>
        <p><span class="tf-term-k">How to read it</span>${tfEsc(g.r)}</p>
        ${g.e ? `<p class="tf-term-ex"><span class="tf-term-k">Example</span>${tfEsc(g.e)}</p>` : ''}`;
    pop.hidden = false;
    // Position below the button (above if no room), clamped to the viewport.
    const r = btn.getBoundingClientRect();
    const w = Math.min(340, window.innerWidth - 16);
    pop.style.width = w + 'px';
    const h = pop.offsetHeight;
    let left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
    let top = r.bottom + 8;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
}

function tfHideTerm(refocus) {
    const pop = document.getElementById('tf-term-pop');
    if (pop) pop.hidden = true;
    if (_tfTermBtn) {
        _tfTermBtn.setAttribute('aria-expanded', 'false');
        if (refocus) _tfTermBtn.focus();
    }
    _tfTermBtn = null;
}

document.addEventListener('click', e => {
    const btn = e.target.closest('.tf-i');
    if (btn) { e.preventDefault(); e.stopPropagation(); tfShowTerm(btn); return; }
    if (!e.target.closest('#tf-term-pop')) tfHideTerm();
}, true);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && _tfTermBtn) tfHideTerm(true); });
window.addEventListener('resize', () => tfHideTerm());
document.addEventListener('scroll', e => { if (_tfTermBtn && !e.target.closest?.('#tf-term-pop')) tfHideTerm(); }, true);
