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

    if (tab === 'sectors') {
        loadSectorsTab();
        syncSectorTelegramToggle();
    }
    if (tab === 'ipos') { loadIposTab(); }
    if (tab === 'market-direction') { loadMarketDirection(); }
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
    loadPnlGuardStatus();
    switchTab('sectors');
    applyRoleAccess();
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
