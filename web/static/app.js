/* autorec Web UI - メインアプリケーション */

const API = {
    TIMEOUT_MS: 10000,
    async _fetch(path, options = {}) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.TIMEOUT_MS);
        try {
            const res = await fetch(path, { ...options, signal: controller.signal });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error || `HTTP ${res.status}`);
            }
            return await res.json();
        } catch (err) {
            if (err.name === 'AbortError')
                throw new Error('サーバーへの接続がタイムアウトしました');
            throw err;
        } finally {
            clearTimeout(timer);
        }
    },
    get(path) { return this._fetch(path); },
    post(path, data) {
        return this._fetch(path, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
    },
    put(path, data) {
        return this._fetch(path, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
    },
    del(path) { return this._fetch(path, { method: 'DELETE' }); },
};

/* --- ユーティリティ --- */

function formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso.replace(' ', 'T'));
    return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}

function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso.replace(' ', 'T'));
    return d.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short' });
}

function formatDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso.replace(' ', 'T'));
    return d.toLocaleString('ja-JP', {
        month: 'numeric', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });
}

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function nowTimestamp() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}


function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

/* --- ライブ視聴 --- */

let livePlayer = null;    // mpegts.Player
let liveNowTimer = null;  // 番組情報更新用 interval

let streamQuality = localStorage.getItem('autorec-stream-quality') || 'high';

function setStreamQuality(quality) {
    streamQuality = quality;
    localStorage.setItem('autorec-stream-quality', quality);
    // 両方の select を同期
    document.querySelectorAll('#nav-quality-select, #drawer-quality-select').forEach(sel => {
        sel.value = quality;
    });
    // ライブ再生中なら再起動
    if (livePlayer && liveRecScheduleId) {
        const id = liveRecScheduleId;
        const title = document.getElementById('live-player-title').textContent.replace(' (録画中)', '');
        stopLive(true);
        startLiveFromRecording(id, title);
    } else if (livePlayer && liveCurrentCh) {
        const ch = liveCurrentCh;
        const sid = liveCurrentSid;
        const title = document.getElementById('live-player-title').textContent;
        stopLive(true);
        startLive(ch, title, sid);
    }
    // 録画再生中なら現在位置から再起動
    if (recordingPlayer && recordingPath) {
        const currentTime = recordingBaseTime + (document.getElementById('video-player').currentTime || 0);
        startRecordingStream(currentTime);
    }
}

/* --- ナビゲーション --- */

let channels = [];
let categories = [];

function switchSection(name) {
    // セクション切替時、ライブ視聴中なら停止
    if (name !== 'live' && livePlayer) stopLive();

    // Close more drawer if open
    closeMoreDrawer();

    document.querySelectorAll('.section').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('nav a[data-section]').forEach(el => el.classList.remove('active'));
    // Also clear active from nav-tab and nav-link (for desktop topbar)
    document.querySelectorAll('.nav-tab, .nav-link').forEach(el => el.classList.remove('active'));

    const section = document.getElementById('section-' + name);
    if (section) section.classList.add('active');

    // Activate all matching links (desktop tab + mobile tab)
    document.querySelectorAll(`nav a[data-section="${name}"]`).forEach(
        link => link.classList.add('active')
    );

    if (name === 'epg') loadEPG();
    else if (name === 'rules') loadRules();
    else if (name === 'schedules') loadSchedules();
    else if (name === 'recordings') loadRecordings();
    else if (name === 'live') initLiveSection();
    else if (name === 'storage') loadStorage();
    else if (name === 'season') loadSeason();
}

/* --- More Drawer (mobile) --- */

function toggleMoreDrawer(e) {
    if (e) e.preventDefault();
    const drawer = document.getElementById('more-drawer');
    const backdrop = document.getElementById('more-drawer-backdrop');
    if (!drawer) return;
    const isActive = drawer.classList.contains('active');
    if (isActive) {
        closeMoreDrawer();
    } else {
        drawer.classList.add('active');
        if (backdrop) backdrop.classList.add('active');
    }
}

function closeMoreDrawer() {
    const drawer = document.getElementById('more-drawer');
    const backdrop = document.getElementById('more-drawer-backdrop');
    if (drawer) drawer.classList.remove('active');
    if (backdrop) backdrop.classList.remove('active');
}

function switchFromDrawer(name, e) {
    if (e) e.preventDefault();
    closeMoreDrawer();
    switchSection(name);
}

/* --- 番組表 (メイン) --- */

// 番組データをグローバルに保持 (onclick軽量化)
window._programmes = [];

async function loadEPG() {
    const category = getFilterValue('epg-category');
    const now = nowTimestamp();

    let url = `/api/programmes?limit=10000&active_after=${encodeURIComponent(now)}`;
    if (category) url += `&category=${encodeURIComponent(category)}`;

    try {
        const data = await API.get(url);
        renderEPGTable(data.programmes);
    } catch (err) {
        document.getElementById('epg-table').innerHTML =
            `<p style="color:var(--error)">番組表の読み込みに失敗しました: ${escapeHtml(err.message)}</p>`;
    }
}

/* 現在時刻線の更新タイマー */
let _epgNowTimer = null;

function renderEPGGrid(programmes, container, options) {
    const showNowLine = options && options.showNowLine !== undefined ? options.showNowLine : true;
    const autoScroll = options && options.autoScroll !== undefined ? options.autoScroll : true;

    if (!programmes || programmes.length === 0) {
        container.innerHTML = '<p style="color:var(--text-muted)">番組データがありません</p>';
        return;
    }

    // 前回のタイマーをクリア
    if (_epgNowTimer) { clearInterval(_epgNowTimer); _epgNowTimer = null; }

    const PX_PER_HOUR = 120;

    // 番組データをグローバル配列に格納
    window._programmes = programmes;

    // 日付パース & チャンネル別グループ化
    const parsed = programmes.map((p, idx) => ({
        ...p,
        idx,
        startDate: new Date(p.start_time.replace(' ', 'T')),
        endDate:   new Date(p.end_time.replace(' ', 'T')),
    }));

    const byChannel = {};
    const channelSet = new Set();
    parsed.forEach(p => {
        if (!byChannel[p.channel]) {
            byChannel[p.channel] = [];
            channelSet.add(p.channel);
        }
        byChannel[p.channel].push(p);
    });

    // channels.conf の順序に合わせてソート (ライブ画面と同じ並び)
    const chConfOrder = channels.map(c => c.name);
    const chSortKey = (name) => {
        const idx = chConfOrder.indexOf(name);
        return idx >= 0 ? idx : chConfOrder.length;
    };
    const channelOrder = [...channelSet].sort((a, b) => chSortKey(a) - chSortKey(b));

    // グリッド時間範囲を計算
    const now = new Date();
    let gridStart, gridEnd;

    if (showNowLine) {
        // メイン番組表: 現在正時から開始
        gridStart = new Date(now); gridStart.setMinutes(0, 0, 0);
        gridEnd = new Date(now); gridEnd.setHours(gridEnd.getHours() + 6, 0, 0, 0);
    } else {
        // アーカイブ: 最初の番組の正時から開始
        const earliest = parsed.reduce((min, p) => p.startDate < min ? p.startDate : min, parsed[0].startDate);
        gridStart = new Date(earliest.getFullYear(), earliest.getMonth(), earliest.getDate(), earliest.getHours(), 0, 0);
        const latest = parsed.reduce((max, p) => p.endDate > max ? p.endDate : max, parsed[0].endDate);
        gridEnd = new Date(latest);
        if (gridEnd.getMinutes() > 0 || gridEnd.getSeconds() > 0) {
            gridEnd.setHours(gridEnd.getHours() + 1, 0, 0, 0);
        }
    }

    parsed.forEach(p => {
        if (p.startDate < gridStart) gridStart = new Date(p.startDate.getFullYear(), p.startDate.getMonth(), p.startDate.getDate(), p.startDate.getHours(), 0, 0);
        if (p.endDate > gridEnd) {
            gridEnd = new Date(p.endDate);
            if (gridEnd.getMinutes() > 0 || gridEnd.getSeconds() > 0) {
                gridEnd.setHours(gridEnd.getHours() + 1, 0, 0, 0);
            }
        }
    });

    const totalHours = (gridEnd - gridStart) / 3600000;
    const totalPx = totalHours * PX_PER_HOUR;

    // ヘルパー: Date → px offset
    const timeToPx = (d) => ((d - gridStart) / 3600000) * PX_PER_HOUR;

    // ヘルパー: カテゴリ → CSSクラス
    const categoryClass = (cat) => {
        if (!cat) return '';
        const c = cat.toLowerCase();
        if (c.includes('ニュース') || c.includes('報道') || c.includes('news'))       return 'cat-news';
        if (c.includes('スポーツ') || c.includes('sport'))                             return 'cat-sports';
        if (c.includes('ドラマ') || c.includes('drama'))                               return 'cat-drama';
        if (c.includes('アニメ') || c.includes('anime'))                               return 'cat-anime';
        if (c.includes('映画') || c.includes('movie'))                                 return 'cat-movie';
        if (c.includes('バラエティ') || c.includes('variety'))                         return 'cat-variety';
        if (c.includes('音楽') || c.includes('music'))                                 return 'cat-music';
        if (c.includes('ドキュメンタリー') || c.includes('documentary') || c.includes('教養')) return 'cat-documentary';
        if (c.includes('趣味') || c.includes('教育') || c.includes('education'))       return 'cat-education';
        if (c.includes('情報') || c.includes('info'))                                  return 'cat-info';
        return '';
    };

    // --- HTML構築 ---
    // 日付ラベル用ヘルパー
    const weekday = ['日','月','火','水','木','金','土'];
    const dateLabelOf = (d) => `${d.getMonth()+1}/${d.getDate()}(${weekday[d.getDay()]})`;

    // 日付境界(0時)の位置を事前計算
    const dateBoundaries = [];
    {
        // gridStart の翌日0時から探索
        let d = new Date(gridStart);
        d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0);
        while (d < gridEnd) {
            dateBoundaries.push({ date: new Date(d), px: timeToPx(d) });
            d.setDate(d.getDate() + 1);
        }
    }

    // --- ヘッダー行（スクロール領域の外） ---
    let html = '<div class="epg-container">';
    html += '<div class="epg-header">';
    html += `<div class="epg-header-corner">${dateLabelOf(gridStart)}</div>`;
    channelOrder.forEach(ch => {
        html += `<div class="epg-header-cell">${escapeHtml(ch)}</div>`;
    });
    html += '</div>';

    // --- スクロール領域 ---
    html += '<div class="epg-grid">';

    // 時刻軸
    html += '<div class="epg-time-axis">';
    html += `<div class="epg-time-axis-body" style="height:${totalPx}px">`;
    for (let h = 0; h <= totalHours; h++) {
        const t = new Date(gridStart.getTime() + h * 3600000);
        const top = h * PX_PER_HOUR;
        html += `<div class="epg-time-label" style="top:${top}px">${t.getHours()}</div>`;
    }
    // 日付境界ラベル（時刻軸）
    dateBoundaries.forEach(b => {
        html += `<div class="epg-date-label" style="top:${b.px}px">${dateLabelOf(b.date)}</div>`;
    });
    html += '</div></div>';

    // チャンネル列（ヘッダーなし — body のみ）
    channelOrder.forEach(ch => {
        html += '<div class="epg-channel">';
        html += `<div class="epg-channel-body" style="height:${totalPx}px">`;

        // 毎時罫線
        for (let h = 0; h <= totalHours; h++) {
            html += `<div class="epg-hour-line" style="top:${h * PX_PER_HOUR}px"></div>`;
        }
        // 日付境界線
        dateBoundaries.forEach(b => {
            html += `<div class="epg-date-line" style="top:${b.px}px"></div>`;
        });

        // 番組ブロック
        byChannel[ch].forEach(p => {
            const top = Math.max(0, timeToPx(p.startDate));
            const bottom = Math.min(totalPx, timeToPx(p.endDate));
            const height = bottom - top;
            if (height <= 0) return;

            const catCls = categoryClass(p.category);
            html += `<div class="epg-programme epg-cell ${catCls}" style="top:${top}px;height:${height}px" onclick="showProgrammeDetail(this, ${p.idx})">`;
            html += `<div class="epg-prog-time">${formatTime(p.start_time)}</div>`;
            html += `<div class="epg-prog-title">${escapeHtml(p.title)}</div>`;
            html += '</div>';
        });

        html += '</div></div>';
    });

    html += '</div></div>';
    container.innerHTML = html;

    // ヘッダーと本体のスクロール同期
    const grid = container.querySelector('.epg-grid');
    const header = container.querySelector('.epg-header');
    const cornerEl = container.querySelector('.epg-header-corner');

    // スクロール位置から表示中の日付を算出しヘッダーに反映
    const updateCornerDate = () => {
        const scrollMs = (grid.scrollTop / PX_PER_HOUR) * 3600000;
        const visibleDate = new Date(gridStart.getTime() + scrollMs);
        cornerEl.textContent = dateLabelOf(visibleDate);
    };

    grid.addEventListener('scroll', () => {
        header.scrollLeft = grid.scrollLeft;
        updateCornerDate();
    });

    if (showNowLine) {
        // 現在時刻線 & 自動スクロール
        const updateNowLine = () => {
            const n = new Date();
            const px = timeToPx(n);
            grid.querySelectorAll('.epg-now-line').forEach(el => el.remove());
            if (px < 0 || px > totalPx) return;

            grid.querySelectorAll('.epg-channel-body, .epg-time-axis-body').forEach(body => {
                const line = document.createElement('div');
                line.className = 'epg-now-line';
                line.style.top = px + 'px';
                body.appendChild(line);
            });
        };
        updateNowLine();

        // 60秒ごとに現在時刻線を更新
        _epgNowTimer = setInterval(updateNowLine, 60000);
    }

    if (autoScroll) {
        // 現在位置へ自動スクロール
        const nowPx = timeToPx(now);
        if (nowPx > 0 && nowPx < totalPx) {
            grid.scrollTop = Math.max(0, nowPx - 60);
        }
    }

    updateCornerDate();
}

function renderEPGTable(programmes) {
    const container = document.getElementById('epg-table');
    renderEPGGrid(programmes, container, { showNowLine: true, autoScroll: true });
}

/* カテゴリ表示用ヘルパー: JSON配列から日本語カテゴリのみ抽出 */
function formatCategory(cat) {
    if (!cat) return '';
    let arr;
    if (typeof cat === 'string') {
        try { arr = JSON.parse(cat); } catch { return cat; }
    } else {
        arr = cat;
    }
    if (!Array.isArray(arr) || arr.length === 0) return '';
    // 日本語カテゴリのみ抽出 (英語キーを除外)
    const ja = arr.filter(c => typeof c === 'string' && /[^\x00-\x7F]/.test(c));
    // 重複除去
    return [...new Set(ja)].join('・');
}

/* 番組extra表示用ヘルパー */
function formatExtra(extra) {
    if (!extra) return '';
    let obj;
    if (typeof extra === 'string') {
        try { obj = JSON.parse(extra); } catch { return ''; }
    } else {
        obj = extra;
    }
    if (!obj || typeof obj !== 'object' || Object.keys(obj).length === 0) return '';
    const parts = [];
    for (const [key, val] of Object.entries(obj)) {
        if (val === null || val === undefined || val === '') continue;
        if (Array.isArray(val)) {
            if (val.length > 0) parts.push(`${key}: ${val.join(', ')}`);
        } else {
            parts.push(`${key}: ${val}`);
        }
    }
    return parts.join(' / ');
}

/* 番組詳細表示 */
function showProgrammeDetail(el, idx) {
    const p = window._programmes[idx];
    const detail = document.getElementById('programme-detail');
    const isMobile = window.innerWidth < 768;

    const catText = formatCategory(p.category);
    const extraText = formatExtra(p.extra);

    detail.innerHTML = `
        <h4>${escapeHtml(p.title)}</h4>
        <div class="meta">
            ${escapeHtml(p.channel)} | ${formatDateTime(p.start_time)} - ${formatTime(p.end_time)}
            ${catText ? ' | ' + escapeHtml(catText) : ''}
        </div>
        <div class="desc">${escapeHtml(p.description || '')}</div>
        ${extraText ? '<div class="programme-extra">' + escapeHtml(extraText) + '</div>' : ''}
        <div style="margin-top:0.75rem;display:flex;gap:0.5rem;flex-wrap:wrap">
            <button class="btn btn-primary btn-sm" onclick="directSchedule(${idx})">
                <i class="ph ph-calendar-check"></i> 録画予約
            </button>
            <button class="btn btn-secondary btn-sm" onclick="quickAddRule('${escapeHtml(p.title)}')">
                <i class="ph ph-funnel"></i> 録画ルールを作成
            </button>
        </div>
    `;

    if (isMobile) {
        // Bottom sheet: CSS handles positioning via .programme-detail.active
        detail.style.top = '';
        detail.style.left = '';
    } else {
        // Desktop: popup near the element
        const rect = el.getBoundingClientRect();
        let top = rect.bottom + 5;
        let left = rect.left;
        if (top + 250 > window.innerHeight) top = Math.max(5, rect.top - 260);
        if (left + 400 > window.innerWidth) left = Math.max(5, window.innerWidth - 410);
        detail.style.top = top + 'px';
        detail.style.left = left + 'px';
    }
    detail.classList.add('active');
}

// クリックで他の場所を押した場合は閉じる
document.addEventListener('click', (e) => {
    if (!e.target.closest('.epg-cell') && !e.target.closest('.programme-detail')) {
        document.getElementById('programme-detail').classList.remove('active');
    }
});

/* --- 番組改編 --- */

let _seasonProgrammes = [];
let _seasonCategoryFilter = '';

function loadSeason() {
    const tab = document.querySelector('#season-tabs .btn-filter.active');
    const mode = tab ? tab.dataset.value : 'new';
    _updateSeasonVisibility(mode);
    if (mode === 'new') loadNewProgrammes();
    else loadEndingRules();
}

function setSeasonTab(btn, mode) {
    btn.parentElement.querySelectorAll('.btn-filter').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _updateSeasonVisibility(mode);
    if (mode === 'new') loadNewProgrammes();
    else loadEndingRules();
}

function _updateSeasonVisibility(mode) {
    document.getElementById('season-new-list').style.display = mode === 'new' ? 'block' : 'none';
    document.getElementById('season-ending-list').style.display = mode === 'ending' ? 'block' : 'none';
    document.getElementById('season-category-filter').style.display = mode === 'new' ? '' : 'none';
    document.getElementById('season-ending-toolbar').style.display = mode === 'ending' ? '' : 'none';
}

function _primaryCategory(cat) {
    if (!cat) return '';
    let arr;
    if (typeof cat === 'string') {
        try { arr = JSON.parse(cat); } catch { return cat; }
    } else {
        arr = cat;
    }
    if (!Array.isArray(arr) || arr.length === 0) return '';
    const ja = arr.find(c => typeof c === 'string' && /[^\x00-\x7F]/.test(c));
    return ja || '';
}

function _buildCategoryButtons(programmes) {
    const counts = {};
    for (const p of programmes) {
        const cat = _primaryCategory(p.category);
        if (cat) counts[cat] = (counts[cat] || 0) + 1;
    }
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const btnGroup = document.getElementById('season-category-buttons');
    btnGroup.innerHTML = `<button class="btn-filter active" data-value="" onclick="filterSeasonCategory(this, '')">すべて (${programmes.length})</button>`
        + sorted.map(([cat, cnt]) =>
            `<button class="btn-filter" data-value="${escapeHtml(cat)}" onclick="filterSeasonCategory(this, '${escapeHtml(cat)}')">${escapeHtml(cat)} (${cnt})</button>`
        ).join('');
}

function filterSeasonCategory(btn, cat) {
    btn.parentElement.querySelectorAll('.btn-filter').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _seasonCategoryFilter = cat;
    renderNewProgrammes();
}

async function loadNewProgrammes() {
    const el = document.getElementById('season-new-list');
    el.innerHTML = '<p style="padding:1rem;color:var(--text-muted)">読み込み中...</p>';
    try {
        const data = await API.get('/api/programmes/new');
        if (!data.programmes || data.programmes.length === 0) {
            _seasonProgrammes = [];
            _buildCategoryButtons([]);
            el.innerHTML = '<p style="padding:1rem;color:var(--text-muted)">新番組が見つかりません</p>';
            return;
        }
        _seasonProgrammes = data.programmes.sort((a, b) => (a.has_rule === b.has_rule) ? 0 : a.has_rule ? 1 : -1);
        _buildCategoryButtons(_seasonProgrammes);
        renderNewProgrammes();
    } catch (err) {
        el.innerHTML = `<p style="padding:1rem;color:var(--error)">${escapeHtml(err.message)}</p>`;
    }
}

function renderNewProgrammes() {
    const el = document.getElementById('season-new-list');
    const filtered = _seasonCategoryFilter
        ? _seasonProgrammes.filter(p => _primaryCategory(p.category) === _seasonCategoryFilter)
        : _seasonProgrammes;
    if (filtered.length === 0) {
        el.innerHTML = '<p style="padding:1rem;color:var(--text-muted)">該当する番組がありません</p>';
        return;
    }
    el.innerHTML = filtered.map(p => {
        const channels = (p.channels || [p.channel]).map(escapeHtml).join(', ');
        return `
        <div class="season-item ${p.has_rule ? 'season-item-done' : ''}">
            <div class="season-item-header">
                <div class="season-item-info">
                    <div class="season-item-title">${escapeHtml(p.normalized_title)}</div>
                    <div class="season-item-meta">
                        <span><i class="ph ph-television"></i>${channels}</span>
                        <span><i class="ph ph-calendar-blank"></i>${formatDate(p.start_time)}</span>
                        ${formatCategory(p.category) ? '<span><i class="ph ph-tag"></i>' + escapeHtml(formatCategory(p.category)) + '</span>' : ''}
                    </div>
                </div>
                <div class="season-item-actions">
                    ${p.has_rule
                        ? '<span class="badge badge-done"><i class="ph ph-check-circle"></i> 登録済み</span>'
                        : `<button class="btn btn-primary btn-sm" onclick="seasonAddRule(this)" data-title="${escapeHtml(p.normalized_title)}"><i class="ph ph-plus"></i> ルール作成</button>`
                    }
                </div>
            </div>
        </div>`;
    }).join('');
}

function seasonAddRule(btn) {
    const title = btn.dataset.title;
    switchSection('rules');
    showRuleForm(null);
    document.getElementById('rule-form').elements['rule-name'].value = title;
    document.getElementById('rule-form').elements['rule-keyword'].value = title;
    previewRule();
}

let _endingRuleIds = [];

async function loadEndingRules() {
    const el = document.getElementById('season-ending-list');
    el.innerHTML = '<p style="padding:1rem;color:var(--text-muted)">読み込み中...</p>';
    try {
        const data = await API.get('/api/rules/ending');
        _endingRuleIds = (data.rules || []).map(r => r.id);
        document.getElementById('season-ending-count').textContent = _endingRuleIds.length > 0 ? `${_endingRuleIds.length}件` : '';
        if (!data.rules || data.rules.length === 0) {
            el.innerHTML = '<p style="padding:1rem;color:var(--text-muted)">終了候補のルールはありません</p>';
            return;
        }
        el.innerHTML = data.rules.map(r => `
            <div class="season-item">
                <div class="season-item-header">
                    <div class="season-item-info">
                        <div class="season-item-title">${escapeHtml(r.name)}</div>
                        <div class="season-item-meta">
                            ${r.keyword ? '<span><i class="ph ph-magnifying-glass"></i>' + escapeHtml(r.keyword) + '</span>' : ''}
                            ${r.channel ? '<span><i class="ph ph-television"></i>' + escapeHtml(r.channel) + '</span>' : ''}
                        </div>
                    </div>
                    <div class="season-item-actions">
                        <button class="btn btn-secondary btn-sm" onclick="seasonDisableRule(this)" data-rule-id="${r.id}" data-rule-name="${escapeHtml(r.name)}"><i class="ph ph-prohibit"></i> 無効化</button>
                    </div>
                </div>
            </div>`).join('');
    } catch (err) {
        el.innerHTML = `<p style="padding:1rem;color:var(--error)">${escapeHtml(err.message)}</p>`;
    }
}

async function seasonDisableAll() {
    if (_endingRuleIds.length === 0) return;
    if (!confirm(`終了候補 ${_endingRuleIds.length}件のルールをすべて無効化しますか？`)) return;
    try {
        let totalCancelled = 0;
        for (const id of _endingRuleIds) {
            const result = await API.put(`/api/rules/${id}`, { enabled: 0 });
            if (result.cancelled_schedules) totalCancelled += result.cancelled_schedules;
        }
        let msg = `${_endingRuleIds.length}件のルールを無効化しました`;
        if (totalCancelled) msg += `\n${totalCancelled}件の録画予定を取り消しました`;
        alert(msg);
        loadEndingRules();
    } catch (err) {
        alert(err.message);
    }
}

async function seasonDisableRule(btn) {
    const id = btn.dataset.ruleId;
    const name = btn.dataset.ruleName;
    if (!confirm(`「${name}」を無効化しますか？`)) return;
    try {
        const result = await API.put(`/api/rules/${id}`, { enabled: 0 });
        let msg = 'ルールを無効化しました';
        if (result.cancelled_schedules) msg += `\n${result.cancelled_schedules}件の録画予定を取り消しました`;
        alert(msg);
        loadEndingRules();
    } catch (err) {
        alert(err.message);
    }
}

/* --- 録画ルール --- */

async function loadRules() {
    const tbody = document.getElementById('rules-table');
    const cardsEl = document.getElementById('rules-cards');
    try {
        const data = await API.get('/api/rules');
        // 無効ルール削除ボタンの表示切替
        const disabledRules = (data.rules || []).filter(r => !r.enabled);
        const btnDel = document.getElementById('btn-delete-disabled-rules');
        if (btnDel) btnDel.style.display = disabledRules.length > 0 ? '' : 'none';

        if (!data.rules || data.rules.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">ルールなし</td></tr>';
            if (cardsEl) cardsEl.innerHTML = '<p style="padding:1rem;color:var(--text-muted)">ルールなし</p>';
            return;
        }
        tbody.innerHTML = data.rules.map(r => `
            <tr>
                <td>${r.id}</td>
                <td>${escapeHtml(r.name)}</td>
                <td>${escapeHtml(r.keyword || '*')}</td>
                <td>${escapeHtml(r.channel || '-')}</td>
                <td>${escapeHtml(r.category || '-')}</td>
                <td>
                    <div class="rule-table-actions">
                        <label class="switch"><input type="checkbox" ${r.enabled ? 'checked' : ''} onchange="toggleRuleEnabled(${r.id}, ${r.enabled})"><span class="switch-slider"></span></label>
                        <button class="btn btn-secondary btn-sm btn-icon" onclick="editRule(${r.id})" title="編集"><i class="ph ph-pencil-simple"></i></button>
                        <button class="btn btn-danger btn-sm btn-icon" onclick="deleteRule(${r.id}, '${escapeHtml(r.name)}')" title="削除"><i class="ph ph-trash"></i></button>
                    </div>
                </td>
            </tr>
        `).join('');

        // Card list for mobile
        if (cardsEl) {
            cardsEl.innerHTML = data.rules.map(r => {
                const catText = formatCategory(r.category);
                return `
                <div class="rule-card">
                    <div class="rule-card-header">
                        <div class="rule-title">${escapeHtml(r.name)}</div>
                        <div class="rule-card-controls">
                            <label class="switch"><input type="checkbox" ${r.enabled ? 'checked' : ''} onchange="toggleRuleEnabled(${r.id}, ${r.enabled})"><span class="switch-slider"></span></label>
                            <button class="btn btn-secondary btn-sm btn-icon" onclick="editRule(${r.id})" title="編集"><i class="ph ph-pencil-simple"></i></button>
                            <button class="btn btn-danger btn-sm btn-icon" onclick="deleteRule(${r.id}, '${escapeHtml(r.name)}')" title="削除"><i class="ph ph-trash"></i></button>
                        </div>
                    </div>
                    <div class="rule-meta">
                        <span class="rule-meta-item"><i class="ph ph-magnifying-glass"></i>${escapeHtml(r.keyword || 'すべて')}</span>
                        ${r.channel ? '<span class="rule-meta-item"><i class="ph ph-television"></i>' + escapeHtml(r.channel) + '</span>' : ''}
                        ${catText ? '<span class="rule-meta-item"><i class="ph ph-tag"></i>' + escapeHtml(catText) + '</span>' : ''}
                    </div>
                </div>`;
            }).join('');
        }
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--error)">読み込みに失敗しました: ${escapeHtml(err.message)}</td></tr>`;
        if (cardsEl) cardsEl.innerHTML = `<p style="padding:1rem;color:var(--error)">読み込みに失敗しました: ${escapeHtml(err.message)}</p>`;
    }
}

function showRuleForm(rule) {
    const overlay = document.getElementById('rule-modal');
    const form = document.getElementById('rule-form');
    document.getElementById('rule-modal-title').textContent = rule ? '録画ルール 編集' : '録画ルール';
    form.dataset.ruleId = rule ? rule.id : '';

    form.elements['rule-name'].value = rule ? rule.name : '';
    form.elements['rule-keyword'].value = rule ? (rule.keyword || '') : '';
    form.elements['rule-enabled'].checked = rule ? !!rule.enabled : true;

    // チャンネル select を生成・値セット
    const chSelect = document.getElementById('rule-channel');
    let chOpts = '<option value="">指定なし</option>';
    channels.forEach(ch => {
        chOpts += `<option value="${escapeHtml(ch.name)}">${escapeHtml(ch.name)}</option>`;
    });
    chSelect.innerHTML = chOpts;
    chSelect.value = rule ? (rule.channel || '') : '';

    // カテゴリ select を生成・値セット
    const catSelect = document.getElementById('rule-category');
    let catOpts = '<option value="">指定なし</option>';
    categories.forEach(cat => {
        catOpts += `<option value="${escapeHtml(cat)}">${escapeHtml(cat)}</option>`;
    });
    catSelect.innerHTML = catOpts;
    catSelect.value = rule ? (rule.category || '') : '';

    // プレビューをリセット
    const preview = document.getElementById('rule-preview');
    preview.style.display = 'none';
    document.getElementById('rule-preview-table').innerHTML = '';
    document.getElementById('rule-preview-count').textContent = '0';

    overlay.classList.add('active');

    // キーワードまたはカテゴリがあれば即プレビュー
    const kw = form.elements['rule-keyword'].value.trim();
    const cat = catSelect.value;
    if (kw || cat) {
        previewRule();
    }
}

async function editRule(id) {
    const data = await API.get('/api/rules');
    const rule = data.rules.find(r => r.id === id);
    if (rule) showRuleForm(rule);
}

async function deleteRule(id, name) {
    if (!confirm(`ルール「${name}」を削除しますか?\n※ 未実行の録画予定も取り消されます`)) return;
    try {
        const result = await API.del(`/api/rules/${id}`);
        if (result.cancelled_schedules > 0) {
            alert(`ルールを削除し、${result.cancelled_schedules}件の録画予定を取り消しました`);
        }
        loadRules();
    } catch (err) {
        alert('削除に失敗しました: ' + err.message);
    }
}

async function deleteDisabledRules() {
    const data = await API.get('/api/rules');
    const disabled = (data.rules || []).filter(r => !r.enabled);
    if (disabled.length === 0) { alert('無効なルールはありません'); return; }
    const names = disabled.map(r => r.name).join('\n');
    if (!confirm(`無効な${disabled.length}件のルールを削除しますか？\n\n${names}`)) return;
    try {
        for (const r of disabled) {
            await API.del(`/api/rules/${r.id}`);
        }
        alert(`${disabled.length}件のルールを削除しました`);
        loadRules();
    } catch (err) {
        alert('削除に失敗しました: ' + err.message);
    }
}

async function toggleRuleEnabled(id, currentEnabled) {
    const newEnabled = currentEnabled ? 0 : 1;
    try {
        const result = await API.put(`/api/rules/${id}`, { enabled: newEnabled });
        if (result.cancelled_schedules > 0) {
            alert(`ルールを無効化し、${result.cancelled_schedules}件の録画予定を取り消しました`);
        }
        loadRules();
    } catch (err) {
        alert('変更に失敗しました: ' + err.message);
    }
}

async function saveRule() {
    const form = document.getElementById('rule-form');
    const ruleId = form.dataset.ruleId;
    const data = {
        name: form.elements['rule-name'].value,
        keyword: form.elements['rule-keyword'].value || null,
        channel: document.getElementById('rule-channel').value || null,
        category: document.getElementById('rule-category').value || null,
        time_from: null,
        time_to: null,
        weekdays: null,
        priority: 0,
        enabled: form.elements['rule-enabled'].checked ? 1 : 0,
    };

    if (!data.name) {
        alert('ルール名を入力してください');
        return;
    }

    try {
        let result;
        if (ruleId) {
            result = await API.put(`/api/rules/${ruleId}`, data);
        } else {
            result = await API.post('/api/rules', data);
        }
        document.getElementById('rule-modal').classList.remove('active');
        if (result.cancelled_schedules > 0) {
            alert(`ルールを無効化し、${result.cancelled_schedules}件の録画予定を取り消しました`);
        }
        loadRules();
        // スケジュール更新を待って録画予定を表示
        switchSection('schedules');
        setTimeout(loadSchedules, 3000);
    } catch (err) {
        alert('保存に失敗しました: ' + err.message);
    }
}

async function previewRule() {
    const keyword = document.getElementById('rule-keyword').value.trim();
    const channel = document.getElementById('rule-channel').value;
    const category = document.getElementById('rule-category').value;
    const preview = document.getElementById('rule-preview');
    const countEl = document.getElementById('rule-preview-count');
    const tableEl = document.getElementById('rule-preview-table');

    if (!keyword && !channel && !category) {
        preview.style.display = 'none';
        tableEl.innerHTML = '';
        countEl.textContent = '0';
        return;
    }

    preview.style.display = '';
    tableEl.innerHTML = '<p style="color:var(--text-muted)">検索中...</p>';

    try {
        let searchUrl = `/api/programmes/search?limit=30&date_from=${encodeURIComponent(nowTimestamp())}&sort=asc`;
        if (keyword) searchUrl += `&keyword=${encodeURIComponent(keyword)}`;
        if (channel) searchUrl += `&channel=${encodeURIComponent(channel)}`;
        if (category) searchUrl += `&category=${encodeURIComponent(category)}`;
        const data = await API.get(searchUrl);
        const programmes = data.programmes || [];
        const total = data.total || 0;
        countEl.textContent = total;

        if (programmes.length === 0) {
            tableEl.innerHTML = '<p style="color:var(--text-muted)">一致する番組はありません</p>';
            return;
        }

        let html = '<div class="rule-preview-scroll"><table><thead><tr>';
        html += '<th>日時</th><th>チャンネル</th><th>番組名</th>';
        html += '</tr></thead><tbody>';
        programmes.forEach(p => {
            html += '<tr>';
            html += `<td style="white-space:nowrap">${formatDateTime(p.start_time)}</td>`;
            html += `<td>${escapeHtml(p.channel)}</td>`;
            html += `<td>${escapeHtml(p.title)}</td>`;
            html += '</tr>';
        });
        html += '</tbody></table></div>';
        if (total > 30) {
            html += `<p style="font-size:0.8rem;color:var(--text-muted);margin-top:0.25rem">他 ${total - 30} 件</p>`;
        }
        tableEl.innerHTML = html;
    } catch (err) {
        tableEl.innerHTML = `<p style="color:var(--error)">プレビュー取得に失敗しました: ${escapeHtml(err.message)}</p>`;
    }
}

function quickAddRule(title) {
    document.getElementById('programme-detail').classList.remove('active');
    switchSection('rules');
    showRuleForm(null);
    document.getElementById('rule-form').elements['rule-name'].value = title;
    document.getElementById('rule-form').elements['rule-keyword'].value = title;
    previewRule();
}

async function directSchedule(idx) {
    const p = window._programmes[idx];
    if (!confirm(`「${p.title}」を録画予約しますか？`)) return;
    try {
        await API.post('/api/schedules', {
            event_id: p.event_id, channel: p.channel,
            title: p.title, start_time: p.start_time, end_time: p.end_time,
        });
        alert('録画予約しました');
        document.getElementById('programme-detail').classList.remove('active');
    } catch (err) {
        alert(err.message);
    }
}

/* --- フィルタボタン --- */

function setFilter(btn, callback) {
    btn.parentElement.querySelectorAll('.btn-filter').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    callback();
}

function getFilterValue(id) {
    const active = document.querySelector(`#${id} .btn-filter.active`);
    return active ? active.dataset.value : '';
}

/* --- 録画スケジュール --- */

async function loadSchedules() {
    const tbody = document.getElementById('schedules-table');
    const cardsEl = document.getElementById('schedules-cards');
    try {
        const data = await API.get('/api/schedules?limit=200');
        if (!data.schedules || data.schedules.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">スケジュールなし</td></tr>';
            if (cardsEl) cardsEl.innerHTML = '<p style="padding:1rem;color:var(--text-muted)">スケジュールなし</p>';
            return;
        }
        tbody.innerHTML = data.schedules.map(s => `
            <tr>
                <td>${s.id}</td>
                <td>${escapeHtml(s.title)}</td>
                <td>${escapeHtml(s.channel)}</td>
                <td>${formatDateTime(s.start_time)}</td>
                <td>${formatDateTime(s.end_time)}</td>
                <td>${escapeHtml(s.rule_name || '-')}</td>
            </tr>
        `).join('');

        if (cardsEl) {
            cardsEl.innerHTML = data.schedules.map(s => `
                <div class="schedule-card">
                    <div class="schedule-title">${escapeHtml(s.title)}</div>
                    <div class="schedule-meta">${escapeHtml(s.channel)} | ${formatDateTime(s.start_time)} - ${formatTime(s.end_time)}</div>
                    ${s.rule_name ? '<span style="font-size:0.8rem;color:var(--text-muted)">' + escapeHtml(s.rule_name) + '</span>' : ''}
                </div>
            `).join('');
        }
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--error)">読み込みに失敗しました: ${escapeHtml(err.message)}</td></tr>`;
        if (cardsEl) cardsEl.innerHTML = `<p style="padding:1rem;color:var(--error)">読み込みに失敗しました: ${escapeHtml(err.message)}</p>`;
    }
}

/* --- ストレージ --- */

async function loadStorage() {
    const container = document.getElementById('storage-content');
    try {
        const data = await API.get('/api/storage');
        const disk = data.disk;
        const series = data.series || [];

        // プログレスバーの色
        let barColor = 'var(--accent)';
        if (disk.usage_percent >= 90) barColor = 'var(--error)';
        else if (disk.usage_percent >= 75) barColor = '#FF9500';

        let html = '';

        // ディスク概要カード (ドーナツチャート)
        const usedPct = Math.min(Math.max(disk.usage_percent, 0), 100);
        const radius = 54;
        const circumference = 2 * Math.PI * radius;
        const usedDash = circumference * usedPct / 100;
        const freeDash = circumference - usedDash;
        const freeColor = 'var(--bg-tertiary, #3a3a3c)';

        html += '<div class="card" style="margin-bottom:1rem">';
        html += '<h3 style="margin-bottom:0.75rem">ディスク使用状況</h3>';
        html += `<p style="font-size:0.85rem;color:var(--text-muted);margin-bottom:0.75rem">${escapeHtml(disk.path)}</p>`;
        html += '<div style="display:flex;align-items:center;gap:1.5rem;flex-wrap:wrap">';

        // SVG ドーナツチャート
        html += '<div style="position:relative;width:180px;height:180px;flex-shrink:0">';
        html += `<svg viewBox="0 0 128 128" style="width:100%;height:100%;transform:rotate(-90deg)">`;
        html += `<circle cx="64" cy="64" r="${radius}" fill="none" stroke="${freeColor}" stroke-width="16"/>`;
        if (usedPct > 0) {
            html += `<circle cx="64" cy="64" r="${radius}" fill="none" stroke="${barColor}" stroke-width="16" `
                  + `stroke-dasharray="${usedDash} ${freeDash}" stroke-linecap="round"/>`;
        }
        html += '</svg>';
        html += `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">`;
        html += `<span style="font-size:1.5rem;font-weight:700;color:${barColor}">${disk.usage_percent}%</span>`;
        html += `<span style="font-size:0.7rem;color:var(--text-muted)">使用率</span>`;
        html += '</div>';
        html += '</div>';

        // 凡例・数値
        html += '<div style="display:grid;gap:0.6rem;font-size:0.9rem;flex:1;min-width:160px">';
        html += `<div style="display:flex;align-items:center;gap:0.5rem"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${barColor}"></span><span style="color:var(--text-muted)">使用済み</span><strong style="margin-left:auto">${formatFileSize(disk.used)}</strong></div>`;
        html += `<div style="display:flex;align-items:center;gap:0.5rem"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${freeColor}"></span><span style="color:var(--text-muted)">空き</span><strong style="margin-left:auto">${formatFileSize(disk.free)}</strong></div>`;
        html += `<div style="display:flex;align-items:center;gap:0.5rem;padding-top:0.4rem;border-top:1px solid var(--border)"><span style="color:var(--text-muted)">合計</span><strong style="margin-left:auto">${formatFileSize(disk.total)}</strong></div>`;
        html += '</div>';

        html += '</div>';
        html += '</div>';

        // シリーズ別使用量カード
        if (series.length > 0) {
            const recordingsTotal = series.reduce((a, s) => a + s.total_size, 0);

            html += '<div class="card" style="padding:0">';
            html += '<div style="padding:1rem 1rem 0.5rem"><h3 style="margin-bottom:0.25rem">シリーズ別使用量</h3>';
            html += `<p style="font-size:0.85rem;color:var(--text-muted)">録画合計: ${formatFileSize(recordingsTotal)}</p></div>`;

            // デスクトップ: テーブル
            html += '<div class="table-card desktop-only" style="box-shadow:none;border-radius:0">';
            html += '<table><thead><tr><th>シリーズ名</th><th>ファイル数</th><th>サイズ</th><th>ディスク割合</th></tr></thead><tbody>';
            series.forEach(s => {
                const pct = disk.total > 0 ? ((s.total_size / disk.total) * 100).toFixed(1) : '0.0';
                html += '<tr>';
                html += `<td>${escapeHtml(s.name)}</td>`;
                html += `<td>${s.file_count}</td>`;
                html += `<td style="white-space:nowrap">${formatFileSize(s.total_size)}</td>`;
                html += `<td>${pct}%</td>`;
                html += '</tr>';
            });
            html += '</tbody></table></div>';

            // モバイル: カードリスト
            html += '<div class="card-list" style="padding:0 0.5rem 0.5rem">';
            series.forEach(s => {
                const pct = disk.total > 0 ? ((s.total_size / disk.total) * 100).toFixed(1) : '0.0';
                html += '<div class="storage-series-card" style="padding:0.75rem;border-bottom:1px solid var(--border)">';
                html += `<div style="font-weight:500">${escapeHtml(s.name)}</div>`;
                html += `<div style="font-size:0.85rem;color:var(--text-muted)">${s.file_count} ファイル / ${formatFileSize(s.total_size)} (${pct}%)</div>`;
                html += '</div>';
            });
            html += '</div>';

            html += '</div>';
        }

        container.innerHTML = html;
    } catch (err) {
        container.innerHTML =
            `<p style="color:var(--error)">ストレージ情報の読み込みに失敗しました: ${escapeHtml(err.message)}</p>`;
    }
}

/* --- 録画済みファイル --- */

let recordingsData = [];

async function loadRecordings() {
    const container = document.getElementById('recordings-list');
    try {
        const data = await API.get('/api/recordings');
        recordingsData = data.series || [];
        renderRecordings(recordingsData);
    } catch (err) {
        container.innerHTML =
            `<p style="color:var(--error)">録画一覧の読み込みに失敗しました: ${escapeHtml(err.message)}</p>`;
    }
}

function _buildSeriesHtml(series) {
    let html = '';
    series.forEach((s, idx) => {
        html += `<div class="card" style="padding:0;margin-bottom:0.5rem">`;
        html += `<div class="recordings-series-header" onclick="toggleSeries(${idx})">`;
        html += `<span class="recordings-series-arrow" id="series-arrow-${idx}"><i class="ph ph-caret-right"></i></span>`;
        html += `<strong>${escapeHtml(s.name)}</strong>`;
        html += `<span style="margin-left:auto;color:var(--text-muted);font-size:0.85rem">${s.file_count} ファイル / ${formatFileSize(s.total_size)}</span>`;
        html += `</div>`;
        html += `<div class="recordings-files" id="series-files-${idx}" style="display:none">`;
        html += `<table><thead><tr><th>ファイル名</th><th>サイズ</th><th>更新日時</th><th>操作</th></tr></thead><tbody>`;
        s.files.forEach(f => {
            const encodedPath = encodeURIComponent(f.path).replace(/%2F/g, '/');
            const nicojkPath = encodedPath.replace(/\.ts$/, '.nicojk');
            html += `<tr>`;
            html += `<td class="recordings-filename">${escapeHtml(f.name)}</td>`;
            html += `<td style="white-space:nowrap">${formatFileSize(f.size)}</td>`;
            html += `<td style="white-space:nowrap">${escapeHtml(f.mtime)}</td>`;
            html += `<td style="white-space:nowrap">`;
            html += `<button class="btn btn-primary btn-sm btn-icon" onclick="playRecording('${encodedPath}', '${escapeHtml(f.name)}', ${!!f.has_nicojk})" title="再生"><i class="ph ph-play"></i></button> `;
            html += `<a class="btn btn-secondary btn-sm btn-icon" href="/recordings/${encodedPath}?download=1" title="ダウンロード"><i class="ph ph-download-simple"></i></a>`;
            if (f.has_nicojk) {
                html += ` <a class="btn btn-secondary btn-sm" href="/recordings/${nicojkPath}?download=1" title="実況コメントDL"><i class="ph ph-chat-circle-text"></i> 実況</a>`;
            }
            html += `</td></tr>`;
        });
        html += `</tbody></table>`;
        // Mobile card layout
        html += `<div class="recordings-file-card">`;
        s.files.forEach(f => {
            const encodedPath = encodeURIComponent(f.path).replace(/%2F/g, '/');
            const nicojkPath = encodedPath.replace(/\.ts$/, '.nicojk');
            html += `<div class="recordings-file-card-item">`;
            html += `<div class="recordings-file-card-name">${escapeHtml(f.name)}</div>`;
            html += `<div class="recordings-file-card-meta">${formatFileSize(f.size)} / ${escapeHtml(f.mtime)}</div>`;
            html += `<div class="recordings-file-card-actions">`;
            html += `<button class="btn btn-primary btn-sm btn-icon" onclick="playRecording('${encodedPath}', '${escapeHtml(f.name)}', ${!!f.has_nicojk})" title="再生"><i class="ph ph-play"></i></button>`;
            html += `<a class="btn btn-secondary btn-sm btn-icon" href="/recordings/${encodedPath}?download=1" title="ダウンロード"><i class="ph ph-download-simple"></i></a>`;
            if (f.has_nicojk) {
                html += `<a class="btn btn-secondary btn-sm" href="/recordings/${nicojkPath}?download=1" title="実況コメントDL"><i class="ph ph-chat-circle-text"></i> 実況</a>`;
            }
            html += `</div></div>`;
        });
        html += `</div>`;
        html += `</div></div>`;
    });
    return html;
}

function renderRecordings(series) {
    const container = document.getElementById('recordings-list');
    if (!series || series.length === 0) {
        container.innerHTML = '<p style="color:var(--text-muted)">録画ファイルがありません</p>';
    } else {
        container.innerHTML = _buildSeriesHtml(series);
    }
    buildRecordingsInitialFilter(recordingsData);
}

/* --- 録画済み頭文字フィルタ --- */

function getInitialChar(name) {
    if (!name) return '';
    const ch = name.charAt(0);
    // Hiragana/Katakana grouping by row
    const code = ch.charCodeAt(0);
    // Katakana → Hiragana normalization
    const hira = (code >= 0x30A1 && code <= 0x30F6) ? String.fromCharCode(code - 0x60) : ch;
    const hiraCode = hira.charCodeAt(0);
    // Japanese hiragana rows
    if (hiraCode >= 0x3041 && hiraCode <= 0x304A) return 'あ';
    if (hiraCode >= 0x304B && hiraCode <= 0x3054) return 'か';
    if (hiraCode >= 0x3055 && hiraCode <= 0x305E) return 'さ';
    if (hiraCode >= 0x305F && hiraCode <= 0x3069) return 'た';
    if (hiraCode >= 0x306A && hiraCode <= 0x306E) return 'な';
    if (hiraCode >= 0x306F && hiraCode <= 0x307D) return 'は';
    if (hiraCode >= 0x307E && hiraCode <= 0x3082) return 'ま';
    if (hiraCode >= 0x3083 && hiraCode <= 0x3088) return 'や';
    if (hiraCode >= 0x3089 && hiraCode <= 0x308D) return 'ら';
    if (hiraCode >= 0x308E && hiraCode <= 0x3093) return 'わ';
    // CJK (kanji) - group by first char as-is, or general "漢"
    if (hiraCode >= 0x4E00 && hiraCode <= 0x9FFF) return ch;
    // Latin
    if (/[a-zA-Z]/.test(ch)) return 'A-Z';
    if (/[0-9]/.test(ch)) return '0-9';
    return ch;
}

function buildRecordingsInitialFilter(series) {
    const filterEl = document.getElementById('recordings-initial-filter');
    if (!filterEl) return;

    // Collect unique initials
    const initials = new Set();
    series.forEach(s => {
        const initial = getInitialChar(s.name);
        if (initial) initials.add(initial);
    });

    // Desired order
    const jpOrder = ['あ','か','さ','た','な','は','ま','や','ら','わ'];
    const sorted = [];
    jpOrder.forEach(c => { if (initials.has(c)) sorted.push(c); });
    // Kanji and other chars
    initials.forEach(c => {
        if (!jpOrder.includes(c) && c !== 'A-Z' && c !== '0-9') sorted.push(c);
    });
    if (initials.has('A-Z')) sorted.push('A-Z');
    if (initials.has('0-9')) sorted.push('0-9');

    let html = '<button class="btn-filter active" data-value="" onclick="filterRecordingsByInitial(\'\', this)">全て</button>';
    sorted.forEach(c => {
        html += `<button class="btn-filter" data-value="${escapeHtml(c)}" onclick="filterRecordingsByInitial('${escapeHtml(c)}', this)">${escapeHtml(c)}</button>`;
    });
    filterEl.innerHTML = html;
}

function filterRecordingsByInitial(initial, btn) {
    // Update active state
    if (btn) {
        btn.parentElement.querySelectorAll('.btn-filter').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
    }

    if (!initial) {
        renderRecordingsFiltered(recordingsData);
        return;
    }

    const filtered = recordingsData.filter(s => getInitialChar(s.name) === initial);
    renderRecordingsFiltered(filtered);
}

function renderRecordingsFiltered(series) {
    const container = document.getElementById('recordings-list');
    if (!series || series.length === 0) {
        container.innerHTML = '<p style="color:var(--text-muted)">該当する録画がありません</p>';
        return;
    }
    container.innerHTML = _buildSeriesHtml(series);
}

function toggleSeries(idx) {
    const files = document.getElementById('series-files-' + idx);
    const arrow = document.getElementById('series-arrow-' + idx);
    if (!files) return;
    if (files.style.display === 'none') {
        files.style.display = '';
        arrow.innerHTML = '<i class="ph ph-caret-down"></i>';
    } else {
        files.style.display = 'none';
        arrow.innerHTML = '<i class="ph ph-caret-right"></i>';
    }
}

function filterRecordings() {
    const query = (document.getElementById('recordings-search').value || '').toLowerCase();
    if (!query) {
        renderRecordings(recordingsData);
        return;
    }
    const filtered = recordingsData
        .map(s => {
            if (s.name.toLowerCase().includes(query)) return s;
            const matchedFiles = s.files.filter(f => f.name.toLowerCase().includes(query));
            if (matchedFiles.length === 0) return null;
            return { ...s, files: matchedFiles, file_count: matchedFiles.length, total_size: matchedFiles.reduce((a, f) => a + f.size, 0) };
        })
        .filter(Boolean);
    renderRecordings(filtered);
}

let recordingPlayer = null;
let recordingBaseTime = 0;
let recordingDuration = 0;
let recordingPath = null;
let recordingProgramId = null;     // 選択中の program_id (null = 自動)
let recordingPrograms = [];        // /api/recording/programs の結果キャッシュ
let seekUpdateTimer = null;
let seekBarDragging = false;

function formatDuration(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
}

/* --- Fullscreen orientation helpers --- */
const _isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
               (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function _lockLandscape() {
    if (screen.orientation && screen.orientation.lock) {
        screen.orientation.lock('landscape').catch(() => {});
    }
}

function _unlockOrientation() {
    if (screen.orientation && screen.orientation.unlock) {
        try { screen.orientation.unlock(); } catch (e) {}
    }
}

function _enterFakeLandscape(el) {
    el.classList.add('fs-landscape');
    document.body.classList.add('fs-landscape-active');
}

function _exitFakeLandscape(el) {
    el.classList.remove('fs-landscape');
    document.body.classList.remove('fs-landscape-active');
}

function _isFakeLandscape(el) {
    return el && el.classList.contains('fs-landscape');
}

/* --- 録画プレイヤー カスタムコントロール --- */
const recControls = (() => {
    const HIDE_DELAY = 3000;
    const ICONS = {
        play: '<i class="ph-fill ph-play"></i>',
        pause: '<i class="ph-fill ph-pause"></i>',
        volumeOn: '<i class="ph-fill ph-speaker-high"></i>',
        volumeOff: '<i class="ph-fill ph-speaker-slash"></i>',
        pip: '<i class="ph ph-picture-in-picture"></i>',
        fullscreen: '<i class="ph ph-corners-out"></i>',
        fullscreenExit: '<i class="ph ph-corners-in"></i>',
    };

    let hideTimer = null;
    let eventsAttached = false;

    function _getVideo() { return document.getElementById('video-player'); }

    function _updatePlayIcon() {
        const btn = document.getElementById('rc-play');
        if (!btn) return;
        const video = _getVideo();
        btn.innerHTML = (video && video.paused) ? ICONS.play : ICONS.pause;
    }

    function _updateVolumeIcon() {
        const btn = document.getElementById('rc-mute');
        if (!btn) return;
        const video = _getVideo();
        const muted = video && (video.muted || video.volume === 0);
        btn.innerHTML = muted ? ICONS.volumeOff : ICONS.volumeOn;
    }

    function _updatePipIcon() {
        const btn = document.getElementById('rc-pip');
        if (!btn) return;
        btn.innerHTML = ICONS.pip;
    }

    function _isFullscreen() {
        return !!(document.fullscreenElement || document.webkitFullscreenElement)
            || _isFakeLandscape(document.querySelector('#video-modal .rec-video-wrapper'));
    }

    function _updateFullscreenIcon() {
        const btn = document.getElementById('rc-fullscreen');
        if (!btn) return;
        const isFs = _isFullscreen();
        btn.innerHTML = isFs ? ICONS.fullscreenExit : ICONS.fullscreen;
        if (!isFs) _unlockOrientation();
    }

    function _showControls() {
        const controls = document.getElementById('rec-controls');
        if (controls) controls.classList.add('visible');
        _resetHideTimer();
    }

    function _hideControls() {
        const controls = document.getElementById('rec-controls');
        if (controls) controls.classList.remove('visible');
    }

    function _resetHideTimer() {
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(_hideControls, HIDE_DELAY);
    }

    function _onMouseMove() { _showControls(); }
    function _onMouseLeave() {
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(_hideControls, 800);
    }
    function _onTouch() {
        const controls = document.getElementById('rec-controls');
        if (controls && controls.classList.contains('visible')) {
            _hideControls();
        } else {
            _showControls();
        }
    }

    return {
        init() {
            _updatePlayIcon();
            _updateVolumeIcon();
            _updatePipIcon();
            _updateFullscreenIcon();

            const pipBtn = document.getElementById('rc-pip');
            if (pipBtn && 'pictureInPictureEnabled' in document && document.pictureInPictureEnabled) {
                pipBtn.style.display = '';
            }

            const video = _getVideo();
            if (video) {
                video.addEventListener('play', _updatePlayIcon);
                video.addEventListener('pause', _updatePlayIcon);
                video.addEventListener('volumechange', () => {
                    _updateVolumeIcon();
                    const slider = document.getElementById('rc-volume');
                    if (slider) slider.value = video.muted ? 0 : video.volume;
                });
                const slider = document.getElementById('rc-volume');
                if (slider) slider.value = video.volume;
            }

            if (!eventsAttached) {
                const wrapper = document.querySelector('.rec-video-wrapper');
                if (wrapper) {
                    wrapper.addEventListener('mousemove', _onMouseMove);
                    wrapper.addEventListener('mouseleave', _onMouseLeave);
                    wrapper.addEventListener('touchstart', _onTouch, { passive: true });
                }
                document.addEventListener('fullscreenchange', _updateFullscreenIcon);
                document.addEventListener('webkitfullscreenchange', _updateFullscreenIcon);
                eventsAttached = true;
            }

            _showControls();
        },

        cleanup() {
            if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
            _hideControls();
            const wrapper = document.querySelector('#video-modal .rec-video-wrapper');
            if (_isFakeLandscape(wrapper)) _exitFakeLandscape(wrapper);
            if (document.fullscreenElement || document.webkitFullscreenElement) {
                (document.exitFullscreen || document.webkitExitFullscreen).call(document).catch(() => {});
            }
            recPip.exit();
            if (document.pictureInPictureElement) {
                document.exitPictureInPicture().catch(() => {});
            }
            const pipBtn = document.getElementById('rc-pip');
            if (pipBtn) { pipBtn.classList.remove('active'); pipBtn.style.display = 'none'; }
        },

        togglePlay() {
            const video = _getVideo();
            if (!video) return;
            if (video.paused || video.ended) {
                video.play().catch(() => {
                    if (recordingPath && recordingDuration) {
                        const currentTime = recordingBaseTime + (video.currentTime || 0);
                        startRecordingStream(currentTime);
                    }
                });
            } else {
                video.pause();
            }
            _showControls();
        },

        toggleMute() {
            const video = _getVideo();
            if (!video) return;
            video.muted = !video.muted;
            _showControls();
        },

        setVolume(val) {
            const video = _getVideo();
            if (!video) return;
            video.volume = parseFloat(val);
            if (parseFloat(val) > 0 && video.muted) video.muted = false;
            _updateVolumeIcon();
            _showControls();
        },

        async togglePip() {
            // recPip が有効 (Canvas 合成中) なら委譲
            if (recPip.isActive()) {
                await recPip.toggle();
                _showControls();
                return;
            }
            // フォールバック: 直接 PiP
            if (document.pictureInPictureElement) {
                document.exitPictureInPicture().catch(() => {});
                return;
            }
            const video = _getVideo();
            if (!video) return;
            try {
                await video.requestPictureInPicture();
                const btn = document.getElementById('rc-pip');
                if (btn) btn.classList.add('active');
                video.addEventListener('leavepictureinpicture', () => {
                    const b = document.getElementById('rc-pip');
                    if (b) b.classList.remove('active');
                    if (video.paused) video.play().catch(() => {});
                }, { once: true });
            } catch (e) { /* ignore */ }
            _showControls();
        },

        switchProgram(pid) {
            recordingProgramId = pid ? parseInt(pid, 10) : null;
            if (!recordingPath) return;
            const video = _getVideo();
            const currentTime = recordingBaseTime + ((video && video.currentTime) || 0);
            startRecordingStream(currentTime);
            _showControls();
        },

        toggleFullscreen() {
            const wrapper = document.querySelector('#video-modal .rec-video-wrapper');
            if (!wrapper) return;
            if (_isFakeLandscape(wrapper)) {
                _exitFakeLandscape(wrapper);
                _updateFullscreenIcon();
            } else if (document.fullscreenElement || document.webkitFullscreenElement) {
                (document.exitFullscreen || document.webkitExitFullscreen).call(document).catch(() => {});
            } else if (_isIOS) {
                _enterFakeLandscape(wrapper);
                _updateFullscreenIcon();
            } else if (wrapper.requestFullscreen) {
                wrapper.requestFullscreen().then(() => _lockLandscape()).catch(() => {});
            } else if (wrapper.webkitRequestFullscreen) {
                wrapper.webkitRequestFullscreen();
                _lockLandscape();
            }
            _showControls();
        },
    };
})();

function playRecording(path, name, hasNicojk) {
    const modal = document.getElementById('video-modal');
    const title = document.getElementById('video-modal-title');
    title.textContent = name || '再生';

    closeRecordingPlayer();

    if (typeof mpegts !== 'undefined' && mpegts.isSupported()) {
        recordingPath = decodeURIComponent(path);
        recordingBaseTime = 0;
        recordingDuration = 0;
        recordingProgramId = null;
        recordingPrograms = [];

        // TS に複数 program がある場合のセレクタを構築
        const sel = document.getElementById('rc-program');
        if (sel) {
            sel.innerHTML = '';
            sel.style.display = 'none';
        }
        API.get(`/api/recording/programs?path=${encodeURIComponent(recordingPath)}`)
            .then(data => {
                recordingPrograms = data.programs || [];
                recordingProgramId = data.default_program_id || null;
                if (sel && recordingPrograms.length >= 2) {
                    for (const p of recordingPrograms) {
                        const opt = document.createElement('option');
                        opt.value = String(p.program_id);
                        const res = p.video ? `${p.video.width}×${p.video.height}` : '映像なし';
                        opt.textContent = `${p.name} (${res})`;
                        if (p.is_main) opt.selected = true;
                        sel.appendChild(opt);
                    }
                    sel.style.display = '';
                }
            })
            .catch(() => {});

        // 再生時間を取得してシークバー初期化
        API.get(`/api/recordings/duration?path=${encodeURIComponent(recordingPath)}`)
            .then(data => {
                if (data.duration) {
                    recordingDuration = data.duration;
                    const bar = document.getElementById('video-seek-bar');
                    bar.max = recordingDuration;
                    bar.value = 0;
                    document.getElementById('video-total-time').textContent = formatDuration(recordingDuration);
                    document.getElementById('video-current-time').textContent = '0:00';
                    document.getElementById('video-seek-container').style.display = 'block';
                }
                // .nicojk がある場合、実況コメントを読み込む (start_time を渡す)
                if (hasNicojk) {
                    const nicojkPath = encodeURIComponent(recordingPath.replace(/\.ts$/, '.nicojk')).replace(/%2F/g, '/');
                    recordingJikkyo.load(nicojkPath, data.start_time || 0)
                        .then(() => { recPip.warmUp(); });
                }
            })
            .catch(() => {});

        startRecordingStream(0);
    } else {
        const videoEl = document.getElementById('video-player');
        videoEl.src = '/recordings/' + path;
        document.getElementById('video-seek-container').style.display = 'none';
    }

    modal.classList.add('active');
    recControls.init();
}

function seekSkip(seconds) {
    if (!recordingPath || !recordingDuration) return;
    const videoEl = document.getElementById('video-player');
    const currentTime = recordingBaseTime + (videoEl.currentTime || 0);
    const newTime = Math.max(0, Math.min(currentTime + seconds, recordingDuration));
    startRecordingStream(newTime);
}

function startRecordingStream(seekTime) {
    const videoEl = document.getElementById('video-player');

    if (recordingPlayer) {
        recordingPlayer.destroy();
        recordingPlayer = null;
    }
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.load();

    recordingBaseTime = seekTime;
    recordingJikkyo.onSeek();

    let url = `/recordings/transcode?path=${encodeURIComponent(recordingPath)}&quality=${streamQuality}`;
    if (seekTime > 0) url += `&ss=${seekTime}`;
    if (recordingProgramId) url += `&program=${recordingProgramId}`;

    recordingPlayer = mpegts.createPlayer({
        type: 'mpegts',
        isLive: true,
        url: url,
    }, {
        enableWorker: false,
        liveBufferLatencyChasing: false,
        fixAudioTimestampGap: true,
        accurateSeek: true,
        autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: 30,
        autoCleanupMinBackwardDuration: 15,
    });
    recordingPlayer.on(mpegts.Events.ERROR, () => {
        const currentTime = recordingBaseTime + (videoEl.currentTime || 0);
        if (recordingPath && recordingDuration && currentTime < recordingDuration - 1) {
            startRecordingStream(currentTime);
        }
    });
    recordingPlayer.attachMediaElement(videoEl);
    recordingPlayer.load();
    videoEl.addEventListener('canplaythrough', () => {
        videoEl.play().catch(() => {});
    }, { once: true });

    // シークバー更新開始
    if (seekUpdateTimer) clearInterval(seekUpdateTimer);
    seekUpdateTimer = setInterval(updateSeekBar, 500);
}

function updateSeekBar() {
    if (seekBarDragging || !recordingDuration) return;
    const videoEl = document.getElementById('video-player');
    const currentTime = recordingBaseTime + (videoEl.currentTime || 0);
    const bar = document.getElementById('video-seek-bar');
    const currentEl = document.getElementById('video-current-time');
    if (bar) bar.value = Math.min(currentTime, recordingDuration);
    if (currentEl) currentEl.textContent = formatDuration(currentTime);
}

function closeRecordingPlayer() {
    recPip.cleanup();
    recControls.cleanup();
    if (seekUpdateTimer) {
        clearInterval(seekUpdateTimer);
        seekUpdateTimer = null;
    }
    recordingJikkyo.stop();
    const videoEl = document.getElementById('video-player');
    if (recordingPlayer) {
        recordingPlayer.destroy();
        recordingPlayer = null;
    }
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.load();
    recordingPath = null;
    recordingBaseTime = 0;
    recordingDuration = 0;
    recordingProgramId = null;
    recordingPrograms = [];
    seekBarDragging = false;
    const progSel = document.getElementById('rc-program');
    if (progSel) {
        progSel.innerHTML = '';
        progSel.style.display = 'none';
    }
    document.getElementById('video-seek-container').style.display = 'none';
}

/* --- 録画実況コメント再生 --- */

const recordingJikkyo = (() => {
    function _getDuration() { return (typeof jikkyoSettings !== 'undefined' ? jikkyoSettings.speed : 6) * 1000; }
    const LANE_COUNT_REC = 12;
    const MAX_OVERLAY_REC = 50;
    const MAX_SIDEBAR_REC = 200;
    const TICK_INTERVAL = 250; // ms

    let comments = [];       // {offset, text} sorted by offset
    let mode = localStorage.getItem('autorec-rec-jikkyo-mode') || 'overlay';
    let tickTimer = null;
    let lastTickTime = -1;
    let baseDate = 0;        // unix seconds of earliest comment
    let lanes = new Array(LANE_COUNT_REC).fill(0);
    let overlayCount = 0;
    let loaded = false;
    let activeComments = []; // Canvas PiP 用コメントデータ

    function _getOverlay() { return document.getElementById('rec-jikkyo-overlay'); }
    function _getSidebar() { return document.getElementById('rec-jikkyo-sidebar'); }
    function _getSidebarMessages() { return document.getElementById('rec-jikkyo-sidebar-messages'); }
    function _getModeSelect() { return document.getElementById('rec-jikkyo-mode-select'); }

    function _assignLane() {
        const now = performance.now();
        for (let i = 0; i < LANE_COUNT_REC; i++) {
            if (lanes[i] <= now) {
                lanes[i] = now + _getDuration();
                return i;
            }
        }
        let minIdx = 0;
        for (let i = 1; i < LANE_COUNT_REC; i++) {
            if (lanes[i] < lanes[minIdx]) minIdx = i;
        }
        lanes[minIdx] = performance.now() + _getDuration();
        return minIdx;
    }

    function _renderOverlay(text, lane) {
        const overlay = _getOverlay();
        if (!overlay) return;
        if (overlayCount >= MAX_OVERLAY_REC) return;

        const overlayWidth = overlay.clientWidth;
        const lineHeight = overlay.clientHeight / LANE_COUNT_REC;

        const span = document.createElement('span');
        span.className = 'jikkyo-comment';
        span.textContent = text;
        span.style.top = (lane * lineHeight) + 'px';
        span.style.left = overlayWidth + 'px';
        span.style.animation = 'none';
        span.style.visibility = 'hidden';
        overlay.appendChild(span);
        const totalDist = overlayWidth + span.offsetWidth;
        span.style.setProperty('--jikkyo-dist', '-' + totalDist + 'px');
        span.style.visibility = '';
        span.offsetHeight;
        span.style.animation = 'jikkyo-flow ' + _getDuration() + 'ms linear forwards';

        overlayCount++;
        span.addEventListener('animationend', () => {
            span.remove();
            overlayCount--;
        });
    }

    function _renderSidebar(text) {
        const container = _getSidebarMessages();
        if (!container) return;
        const div = document.createElement('div');
        div.className = 'jikkyo-sidebar-msg';
        div.textContent = text;
        container.insertBefore(div, container.firstChild);
        while (container.children.length > MAX_SIDEBAR_REC) {
            container.removeChild(container.lastChild);
        }
    }

    function _onComment(text) {
        const lane = _assignLane();

        // Always track for Canvas PiP regardless of mode
        activeComments.push({
            text,
            lane,
            startTime: performance.now(),
            textWidth: 0,
        });
        activeComments = activeComments.filter(c => performance.now() - c.startTime < _getDuration());

        if (mode === 'off') return;
        if (mode === 'overlay' && !(typeof recPip !== 'undefined' && recPip.isActive())) {
            _renderOverlay(text, lane);
        }
        _renderSidebar(text);
    }

    // Binary search: find first index where comments[i].offset > time
    function _upperBound(arr, time) {
        let lo = 0, hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (arr[mid].offset <= time) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    function _tick() {
        if (!loaded || comments.length === 0) return;
        const videoEl = document.getElementById('video-player');
        if (!videoEl || videoEl.paused) return;

        const currentVideoTime = recordingBaseTime + (videoEl.currentTime || 0);
        if (lastTickTime < 0) {
            lastTickTime = currentVideoTime - 0.01;
        }

        // Find comments in (lastTickTime, currentVideoTime] range
        const startIdx = _upperBound(comments, lastTickTime);
        const endIdx = _upperBound(comments, currentVideoTime);

        for (let i = startIdx; i < endIdx; i++) {
            _onComment(comments[i].text);
        }

        lastTickTime = currentVideoTime;
    }

    function _updateUI() {
        const overlay = _getOverlay();
        const sidebar = _getSidebar();
        const select = _getModeSelect();

        if (select) select.value = mode;
        if (overlay) {
            // Canvas 描画中は DOM オーバーレイを使わない (Canvas が描画を担当)
            overlay.style.display = (mode === 'overlay' && !(typeof recPip !== 'undefined' && recPip.isActive())) ? '' : 'none';
        }
        if (sidebar) {
            sidebar.style.display = (mode === 'sidebar') ? '' : 'none';
            if (mode === 'sidebar') {
                // Sync sidebar height with video
                const videoEl = document.getElementById('video-player');
                if (videoEl && sidebar) {
                    sidebar.style.height = videoEl.offsetHeight + 'px';
                }
            }
        }
    }

    function _clearDisplay() {
        const overlay = _getOverlay();
        if (overlay) overlay.innerHTML = '';
        const msgs = _getSidebarMessages();
        if (msgs) msgs.innerHTML = '';
        overlayCount = 0;
        lanes.fill(0);
    }

    return {
        async load(nicojkPath, startEpoch) {
            this.stop();
            try {
                const resp = await fetch('/recordings/' + nicojkPath);
                if (!resp.ok) return;
                const text = await resp.text();
                const lines = text.trim().split('\n');
                const parsed = [];
                let minDate = Infinity;

                for (const line of lines) {
                    try {
                        const msg = JSON.parse(line);
                        if (msg.chat && msg.chat.content && msg.chat.date) {
                            const date = Number(msg.chat.date);
                            if (date < minDate) minDate = date;
                            parsed.push({ date, text: msg.chat.content });
                        }
                    } catch (e) { /* skip invalid lines */ }
                }

                if (parsed.length === 0) return;

                baseDate = startEpoch ? startEpoch : minDate;
                comments = parsed
                    .map(p => ({ offset: p.date - baseDate, text: p.text }))
                    .sort((a, b) => a.offset - b.offset);
                loaded = true;
                lastTickTime = -1;

                // Show mode select + settings button
                const select = _getModeSelect();
                if (select) select.style.display = '';
                const settingsBtn = document.getElementById('rec-jikkyo-settings-btn');
                if (settingsBtn) settingsBtn.style.display = '';

                _updateUI();

                // Start tick timer
                tickTimer = setInterval(_tick, TICK_INTERVAL);

                console.log('[rec-jikkyo] loaded ' + comments.length + ' comments, baseDate=' + baseDate
                    + ' (startEpoch=' + startEpoch + ', minDate=' + minDate
                    + ', diff=' + (minDate - baseDate) + 's)');
            } catch (e) {
                console.log('[rec-jikkyo] load error: ' + e);
            }
        },

        onSeek() {
            _clearDisplay();
            lastTickTime = -1;
            activeComments = [];
        },

        stop() {
            if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
            comments = [];
            baseDate = 0;
            lastTickTime = -1;
            loaded = false;
            overlayCount = 0;
            lanes.fill(0);
            activeComments = [];

            _clearDisplay();

            // Hide mode select + settings button
            const select = _getModeSelect();
            if (select) select.style.display = 'none';
            const settingsBtn = document.getElementById('rec-jikkyo-settings-btn');
            if (settingsBtn) settingsBtn.style.display = 'none';
            jikkyoSettings.close();

            // Hide sidebar
            const sidebar = _getSidebar();
            if (sidebar) sidebar.style.display = 'none';

            // Hide overlay
            const overlay = _getOverlay();
            if (overlay) { overlay.style.display = 'none'; overlay.innerHTML = ''; }
        },

        setMode(newMode) {
            mode = newMode;
            localStorage.setItem('autorec-rec-jikkyo-mode', mode);
            _updateUI();
        },

        getMode() { return mode; },

        getActiveComments() {
            activeComments = activeComments.filter(c => performance.now() - c.startTime < _getDuration());
            return activeComments;
        },
    };
})();

/* --- 実況コメント設定 --- */

const jikkyoSettings = (() => {
    const DEFAULTS = { size: 1.0, opacity: 0.85, speed: 6 };
    const KEYS = {
        size: 'autorec-jikkyo-size',
        opacity: 'autorec-jikkyo-opacity',
        speed: 'autorec-jikkyo-speed',
    };

    function _load(key, fallback) {
        const v = localStorage.getItem(key);
        return v !== null ? parseFloat(v) : fallback;
    }
    let size = _load(KEYS.size, DEFAULTS.size);
    let opacity = _load(KEYS.opacity, DEFAULTS.opacity);
    let speed = _load(KEYS.speed, DEFAULTS.speed);
    let popover = null;
    let currentAnchor = null;

    function _apply() {
        // DOM overlay 用 (Canvas PiP 非使用時のブラウザ向け)
        const liveDt = (2.1 * size).toFixed(2);
        const liveMb = (0.85 * size).toFixed(2);
        const recDt = (1.6 * size).toFixed(2);
        const recMb = (1.15 * size).toFixed(2);

        const old = document.getElementById('jikkyo-settings-style');
        if (old) old.remove();
        const styleEl = document.createElement('style');
        styleEl.id = 'jikkyo-settings-style';
        document.head.appendChild(styleEl);
        const sheet = styleEl.sheet;
        sheet.insertRule('.jikkyo-comment { opacity: ' + opacity + ' !important; font-size: ' + liveDt + 'rem !important; }', 0);
        sheet.insertRule('.rec-video-wrapper .jikkyo-comment { font-size: ' + recDt + 'rem !important; }', 1);
        sheet.insertRule('@media (max-width: 768px) { .jikkyo-comment { font-size: ' + liveMb + 'rem !important; } }', 2);
        sheet.insertRule('@media (max-width: 768px) { .rec-video-wrapper .jikkyo-comment { font-size: ' + recMb + 'rem !important; } }', 3);
        // Canvas PiP パスでは _renderFrame が jikkyoSettings を直接参照するため追加処理不要
    }

    function _save() {
        localStorage.setItem(KEYS.size, size);
        localStorage.setItem(KEYS.opacity, opacity);
        localStorage.setItem(KEYS.speed, speed);
    }

    function _sizeLabel(v) {
        if (v <= 0.7) return '小';
        if (v <= 0.85) return 'やや小';
        if (v <= 1.05) return '中';
        if (v <= 1.3) return 'やや大';
        return '大';
    }

    function _createPopover(anchorId) {
        const el = document.createElement('div');
        el.className = 'jikkyo-settings';

        el.innerHTML =
            '<div class="jikkyo-settings-row">' +
                '<label>大きさ</label>' +
                '<input type="range" min="0.7" max="1.6" step="0.1" value="' + size + '" id="js-size-range">' +
                '<span class="jikkyo-settings-value" id="js-size-val">' + _sizeLabel(size) + '</span>' +
            '</div>' +
            '<div class="jikkyo-settings-row">' +
                '<label>透明度</label>' +
                '<input type="range" min="0.4" max="1.0" step="0.05" value="' + opacity + '" id="js-opacity-range">' +
                '<span class="jikkyo-settings-value" id="js-opacity-val">' + Math.round(opacity * 100) + '%</span>' +
            '</div>' +
            '<div class="jikkyo-settings-row">' +
                '<label>速度</label>' +
                '<input type="range" min="4" max="8" step="1" value="' + speed + '" id="js-speed-range">' +
                '<span class="jikkyo-settings-value" id="js-speed-val">' + speed + '秒</span>' +
            '</div>';

        el.querySelector('#js-size-range').addEventListener('input', function() {
            size = parseFloat(this.value);
            el.querySelector('#js-size-val').textContent = _sizeLabel(size);
            _apply();
            _save();
        });
        el.querySelector('#js-opacity-range').addEventListener('input', function() {
            opacity = parseFloat(this.value);
            el.querySelector('#js-opacity-val').textContent = Math.round(opacity * 100) + '%';
            _apply();
            _save();
        });
        el.querySelector('#js-speed-range').addEventListener('input', function() {
            speed = parseFloat(this.value);
            el.querySelector('#js-speed-val').textContent = speed + '秒';
            _save();
        });

        return el;
    }

    function _close() {
        if (popover) {
            popover.remove();
            popover = null;
            currentAnchor = null;
        }
    }

    // Close on outside click
    document.addEventListener('click', function(e) {
        if (!popover) return;
        const anchor = currentAnchor ? document.getElementById(currentAnchor) : null;
        if (popover.contains(e.target) || (anchor && anchor.contains(e.target))) return;
        _close();
    });

    // Apply saved settings on load
    _apply();

    return {
        get size() { return size; },
        get opacity() { return opacity; },
        get speed() { return speed; },

        toggle(anchorId) {
            if (popover && currentAnchor === anchorId) {
                _close();
                return;
            }
            _close();
            const anchor = document.getElementById(anchorId);
            if (!anchor) return;
            popover = _createPopover(anchorId);
            currentAnchor = anchorId;
            const container = anchor.closest('.live-controls') || anchor.parentElement;
            container.appendChild(popover);
        },

        close() { _close(); },
    };
})();

/* --- ライブ視聴機能 --- */

let liveCurrentCh = null;  // 現在視聴中のチャンネル番号
let liveCurrentSid = null;  // 現在のサービスID (サブチャンネル)
let liveRecScheduleId = null;  // 録画ライブ視聴時のスケジュールID
let liveRecording = false;  // ライブ録画中かどうか

/* --- NX-Jikkyo 実況コメント --- */

const JIKKYO_MAP = {
    // 地上波
    'NHK総合': 'jk1', 'NHK-Eテレ': 'jk2', '日テレ': 'jk4',
    'テレビ朝日': 'jk5', 'TBS': 'jk6', 'テレビ東京': 'jk7',
    'フジテレビ': 'jk8', 'TOKYO MX': 'jk9',
    // BS
    'NHK BS': 'jk101', 'BS日テレ': 'jk141', 'BSフジ': 'jk181',
    'BS11': 'jk211', 'BS12 トゥエルビ': 'jk222',
    'BS松竹東急': 'jk260', 'BSよしもと': 'jk265',
};

function COMMENT_DURATION() { return (typeof jikkyoSettings !== 'undefined' ? jikkyoSettings.speed : 6) * 1000; }
const LANE_COUNT = 12;         // コメントレーン数

const jikkyo = (() => {
    const JIKKYO_BASE = 'nx-jikkyo.tsukumijima.net';
    const MAX_OVERLAY = 50;
    const MAX_SIDEBAR = 200;
    const RETRY_MAX = 3;
    const RETRY_DELAY = 5000; // ms

    let mode = localStorage.getItem('autorec-jikkyo-mode') || 'overlay';
    let watchWs = null;
    let commentWs = null;
    let keepSeatTimer = null;
    let threadId = null;
    let yourPostKey = null;
    let commentWsUri = null;
    let currentJkId = null;
    let generation = 0;  // incremented on each start/cleanup to detect stale handlers
    let retryCount = 0;
    let retryTimer = null;
    let overlayCount = 0;
    let lanes = new Array(LANE_COUNT).fill(0); // timestamp when lane becomes free
    let activeComments = []; // Canvas PiP 用コメントデータ

    function _log(msg) {
        console.log('[jikkyo] ' + msg);
    }

    function _getOverlay() {
        return document.getElementById('jikkyo-overlay');
    }

    function _getSidebar() {
        return document.getElementById('jikkyo-sidebar');
    }

    function _getSidebarMessages() {
        return document.getElementById('jikkyo-sidebar-messages');
    }

    function _assignLane() {
        const now = performance.now();
        for (let i = 0; i < LANE_COUNT; i++) {
            if (lanes[i] <= now) {
                lanes[i] = now + COMMENT_DURATION();
                return i;
            }
        }
        // All lanes busy — pick the one that frees soonest
        let minIdx = 0;
        for (let i = 1; i < LANE_COUNT; i++) {
            if (lanes[i] < lanes[minIdx]) minIdx = i;
        }
        lanes[minIdx] = performance.now() + COMMENT_DURATION();
        return minIdx;
    }

    function _renderOverlay(text, lane) {
        const overlay = _getOverlay();
        if (!overlay) return;
        if (overlayCount >= MAX_OVERLAY) return;

        const overlayWidth = overlay.clientWidth;
        const lineHeight = overlay.clientHeight / LANE_COUNT;

        const span = document.createElement('span');
        span.className = 'jikkyo-comment';
        span.textContent = text;
        span.style.top = (lane * lineHeight) + 'px';
        span.style.left = overlayWidth + 'px';
        // Measure text width, then calculate full travel distance
        span.style.animation = 'none';
        span.style.visibility = 'hidden';
        overlay.appendChild(span);
        const totalDist = overlayWidth + span.offsetWidth;
        span.style.setProperty('--jikkyo-dist', '-' + totalDist + 'px');
        span.style.visibility = '';
        // Trigger reflow then start animation
        span.offsetHeight;
        span.style.animation = `jikkyo-flow ${COMMENT_DURATION()}ms linear forwards`;

        overlayCount++;
        span.addEventListener('animationend', () => {
            span.remove();
            overlayCount--;
        });
    }

    function _renderSidebar(text) {
        const container = _getSidebarMessages();
        if (!container) return;

        const div = document.createElement('div');
        div.className = 'jikkyo-sidebar-msg';
        div.textContent = text;
        container.insertBefore(div, container.firstChild);

        // Trim old messages
        while (container.children.length > MAX_SIDEBAR) {
            container.removeChild(container.lastChild);
        }
    }

    function _onComment(text) {
        const lane = _assignLane();

        // Always track for Canvas PiP regardless of mode
        activeComments.push({
            text,
            lane,
            startTime: performance.now(),
            textWidth: 0,
        });
        activeComments = activeComments.filter(c => performance.now() - c.startTime < COMMENT_DURATION());

        if (mode === 'off') return;
        if (mode === 'overlay' && !jikkyoPip.isActive()) {
            _renderOverlay(text, lane);
        }
        // Always add to sidebar buffer (shown when mode is sidebar)
        _renderSidebar(text);
    }

    function _updateUI() {
        const overlay = _getOverlay();
        const sidebar = _getSidebar();
        const select = document.getElementById('jikkyo-mode-select');

        if (select) select.value = mode;

        if (overlay) {
            // Canvas 描画中は DOM オーバーレイを使わない (Canvas が描画を担当)
            overlay.style.display = (mode === 'overlay' && !jikkyoPip.isActive()) ? '' : 'none';
        }
        if (sidebar) {
            sidebar.style.display = (mode === 'sidebar') ? '' : 'none';
            if (mode === 'sidebar') _syncSidebarHeight();
        }
    }

    function _syncSidebarHeight() {
        const container = document.querySelector('.live-player-container');
        const sidebar = _getSidebar();
        if (!container || !sidebar) return;
        sidebar.style.height = container.offsetHeight + 'px';
    }

    function _cleanup() {
        generation++;
        if (keepSeatTimer) { clearInterval(keepSeatTimer); keepSeatTimer = null; }
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
        if (commentWs) { try { commentWs.close(); } catch(e) {} commentWs = null; }
        if (watchWs) { try { watchWs.close(); } catch(e) {} watchWs = null; }
        threadId = null;
        yourPostKey = null;
        commentWsUri = null;
        currentJkId = null;
        retryCount = 0;
        overlayCount = 0;
        lanes.fill(0);
        activeComments = [];

        // Clear overlay
        const overlay = _getOverlay();
        if (overlay) overlay.innerHTML = '';
    }

    function _connectWatch(jkId) {
        currentJkId = jkId;
        const gen = generation;
        const url = `wss://${JIKKYO_BASE}/api/v1/channels/${jkId}/ws/watch`;
        _log('watch WS connecting: ' + url);

        watchWs = new WebSocket(url);

        watchWs.onopen = () => {
            if (gen !== generation) return;
            _log('watch WS connected');
            retryCount = 0;
            watchWs.send(JSON.stringify({ type: 'startWatching', data: {} }));
        };

        watchWs.onmessage = (event) => {
            if (gen !== generation) return;
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'seat' && msg.data) {
                    const interval = (msg.data.keepIntervalSec || 30) * 1000;
                    if (keepSeatTimer) clearInterval(keepSeatTimer);
                    keepSeatTimer = setInterval(() => {
                        if (watchWs && watchWs.readyState === WebSocket.OPEN) {
                            watchWs.send(JSON.stringify({ type: 'keepSeat' }));
                        }
                    }, interval);
                    _log('seat received, keepSeat interval: ' + interval + 'ms');
                } else if (msg.type === 'room' && msg.data) {
                    threadId = String(msg.data.threadId);
                    yourPostKey = msg.data.yourPostKey || '';
                    if (msg.data.messageServer && msg.data.messageServer.uri) {
                        commentWsUri = msg.data.messageServer.uri;
                    } else {
                        commentWsUri = `wss://${JIKKYO_BASE}/api/v1/channels/${jkId}/ws/comment`;
                    }
                    _log('room: threadId=' + threadId + ' uri=' + commentWsUri);
                    _connectComment();
                } else if (msg.type === 'ping') {
                    watchWs.send(JSON.stringify({ type: 'pong' }));
                } else if (msg.type === 'disconnect') {
                    _log('disconnect: ' + (msg.data && msg.data.reason));
                    _cleanup();
                } else if (msg.type === 'error') {
                    _log('error: ' + (msg.data && msg.data.message));
                }
            } catch (e) {
                _log('watch WS parse error: ' + e);
            }
        };

        watchWs.onerror = () => { _log('watch WS error'); };

        watchWs.onclose = () => {
            if (gen !== generation) return; // stale handler — ignore
            _log('watch WS closed');
            if (currentJkId && retryCount < RETRY_MAX) {
                retryCount++;
                _log('retry ' + retryCount + '/' + RETRY_MAX);
                const jk = currentJkId;
                _cleanup();
                retryTimer = setTimeout(() => _connectWatch(jk), RETRY_DELAY);
            }
        };
    }

    function _connectComment() {
        if (!threadId || !commentWsUri) return;
        const gen = generation;
        _log('comment WS connecting: ' + commentWsUri);

        commentWs = new WebSocket(commentWsUri);

        commentWs.onopen = () => {
            if (gen !== generation) return;
            _log('comment WS connected, subscribing to thread ' + threadId);
            // niwavided protocol: send subscription as a single JSON array
            const subscription = [
                { ping: { content: 'rs:0' } },
                { ping: { content: 'ps:0' } },
                { thread: {
                    version: '20061206',
                    thread: threadId,
                    threadkey: yourPostKey || '',
                    user_id: '',
                    res_from: -100,
                } },
                { ping: { content: 'pf:0' } },
                { ping: { content: 'rf:0' } },
            ];
            commentWs.send(JSON.stringify(subscription));
        };

        commentWs.onmessage = (event) => {
            if (gen !== generation) return;
            try {
                const msg = JSON.parse(event.data);
                // niwavided format: {"chat": {"content": "...", ...}}
                if (msg.chat && msg.chat.content) {
                    _onComment(msg.chat.content);
                }
                // ping and thread messages are server acks — do NOT echo back
            } catch (e) {
                // Ignore parse errors
            }
        };

        commentWs.onerror = () => { _log('comment WS error'); };
        commentWs.onclose = () => {
            if (gen !== generation) return;
            _log('comment WS closed');
        };
    }

    return {
        start(channelName) {
            this.stop();
            const jkId = JIKKYO_MAP[channelName];
            if (!jkId) {
                _log('no jikkyo mapping for: ' + channelName);
                return;
            }
            _log('starting for ' + channelName + ' → ' + jkId);
            _updateUI();
            try {
                _connectWatch(jkId);
            } catch (e) {
                _log('connection error: ' + e);
            }
        },

        stop() {
            _cleanup();
        },

        setMode(newMode) {
            mode = newMode;
            localStorage.setItem('autorec-jikkyo-mode', mode);
            _updateUI();
        },

        getMode() {
            return mode;
        },

        getActiveComments() {
            activeComments = activeComments.filter(c => performance.now() - c.startTime < COMMENT_DURATION());
            return activeComments;
        },

        initUI() {
            _updateUI();
            window.addEventListener('resize', () => {
                if (mode === 'sidebar') _syncSidebarHeight();
            });
        },
    };
})();

/* --- Canvas 合成表示 + PiP --- */
// Canvas で映像+コメントを合成してページ内に表示。
// Mac: displayVideo (Canvas 合成) で PiP → コメント付き PiP
// iOS: live-video 直接で PiP → バックグラウンド再生対応 (コメントなし)

const jikkyoPip = (() => {
    // iOS/iPadOS 判定 (Mac Safari と区別)
    const _isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    const FONT_SIZE = 28;
    const CANVAS_W = 960;
    const CANVAS_H = 540;

    let canvas = null;
    let ctx = null;
    let displayVideo = null;   // Canvas 合成映像の表示用 (ページ内表示)
    let animFrameId = null;
    let isRendering = false;

    function _setup() {
        if (canvas) return;

        const srcVideo = document.getElementById('live-video');
        const wrapper = document.querySelector('.live-video-wrapper');
        if (!srcVideo || !wrapper) return;

        // Canvas: 非表示コンポジタ (映像+コメント合成用)
        canvas = document.createElement('canvas');
        canvas.width = CANVAS_W;
        canvas.height = CANVAS_H;
        canvas.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;pointer-events:none';
        document.body.appendChild(canvas);
        ctx = canvas.getContext('2d');

        // live-video を非表示にする (Canvas の映像ソース + PiP ソースとして維持)
        // display:none ではなく位置で隠す (PiP での利用を可能にするため)
        srcVideo.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none';

        // DOM オーバーレイは Canvas 描画に統合されるため非表示
        const overlay = document.getElementById('jikkyo-overlay');
        if (overlay) overlay.style.display = 'none';

        // displayVideo: Canvas 合成映像のページ内表示用 (Mac では PiP ソースも兼ねる)
        displayVideo = document.createElement('video');
        displayVideo.id = 'live-canvas';
        displayVideo.muted = true;
        displayVideo.playsInline = true;
        displayVideo.autoplay = true;
        if (_isIOS) displayVideo.disablePictureInPicture = true;
        displayVideo.style.cssText = 'display:block;width:100%;background:#000';
        wrapper.insertBefore(displayVideo, wrapper.firstChild);

        // Canvas captureStream → displayVideo
        displayVideo.srcObject = canvas.captureStream(60);
        displayVideo.play().catch(() => {});
    }

    function _cacheComment(c, scaledFontSize, sizeScale) {
        const tmpCanvas = document.createElement('canvas');
        const tmpCtx = tmpCanvas.getContext('2d');
        tmpCtx.font = 'bold ' + scaledFontSize + 'px "Noto Sans JP", sans-serif';
        const m = tmpCtx.measureText(c.text);
        const pad = 4; // stroke 分の余白
        tmpCanvas.width = Math.ceil(m.width) + pad * 2;
        tmpCanvas.height = Math.ceil(scaledFontSize * 1.4);
        // canvas リサイズでコンテキスト設定リセットされるため再設定
        tmpCtx.font = 'bold ' + scaledFontSize + 'px "Noto Sans JP", sans-serif';
        tmpCtx.textBaseline = 'top';
        tmpCtx.strokeStyle = '#000';
        tmpCtx.lineWidth = 3;
        tmpCtx.lineJoin = 'round';
        tmpCtx.strokeText(c.text, pad, 0);
        tmpCtx.fillStyle = '#fff';
        tmpCtx.fillText(c.text, pad, 0);
        c._cache = tmpCanvas;
        c._cachePad = pad;
        c.textWidth = m.width;
        c._fontScale = sizeScale;
    }

    function _renderFrame(timestamp) {
        if (!isRendering) return;
        const srcVideo = document.getElementById('live-video');

        if (srcVideo && srcVideo.readyState >= 2) {
            ctx.drawImage(srcVideo, 0, 0, CANVAS_W, CANVAS_H);

            const comments = jikkyo.getMode() === 'overlay' ? jikkyo.getActiveComments() : [];
            if (comments.length > 0) {
                const lineHeight = CANVAS_H / LANE_COUNT;
                const sizeScale = (typeof jikkyoSettings !== 'undefined') ? jikkyoSettings.size : 1.0;
                const opacityVal = (typeof jikkyoSettings !== 'undefined') ? jikkyoSettings.opacity : 0.85;
                const scaledFontSize = Math.round(FONT_SIZE * sizeScale);

                for (let i = 0; i < comments.length; i++) {
                    const c = comments[i];
                    const elapsed = timestamp - c.startTime;
                    if (elapsed > COMMENT_DURATION()) continue;
                    const progress = elapsed / COMMENT_DURATION();

                    if (!c._cache || c._fontScale !== sizeScale) {
                        _cacheComment(c, scaledFontSize, sizeScale);
                    }

                    const x = CANVAS_W - (CANVAS_W + c.textWidth) * progress;
                    const y = c.lane * lineHeight;
                    ctx.globalAlpha = opacityVal;
                    ctx.drawImage(c._cache, x - c._cachePad, y);
                }
                ctx.globalAlpha = 1.0;
            }
        }

        animFrameId = requestAnimationFrame(_renderFrame);
    }

    function _startRenderLoop() {
        if (isRendering) return;
        isRendering = true;
        animFrameId = requestAnimationFrame(_renderFrame);
    }

    function _stopRenderLoop() {
        isRendering = false;
        if (animFrameId) {
            cancelAnimationFrame(animFrameId);
            animFrameId = null;
        }
    }

    return {
        warmUp() {
            _setup();
            _startRenderLoop();
        },

        async toggle() {
            if (document.pictureInPictureElement) {
                document.exitPictureInPicture().catch(() => {});
                return;
            }

            // Mac: displayVideo (Canvas 合成、コメント付き) で PiP
            // iOS: live-video 直接で PiP (バックグラウンド再生対応)
            const pipTarget = (_isIOS || !displayVideo)
                ? document.getElementById('live-video')
                : displayVideo;
            if (!pipTarget) return;

            try {
                await pipTarget.requestPictureInPicture();

                const btn = document.getElementById('pip-btn');
                if (btn) btn.classList.add('active');

                pipTarget.addEventListener('leavepictureinpicture', () => {
                    const b = document.getElementById('pip-btn');
                    if (b) b.classList.remove('active');
                    // ブラウザが PiP 終了時に pause するため再生を再開
                    if (pipTarget.paused) pipTarget.play().catch(() => {});
                }, { once: true });
            } catch (e) {
                const errEl = document.getElementById('live-error');
                if (errEl) errEl.textContent = 'PiP を開けませんでした: ' + e.message;
            }
        },

        exit() {
            if (document.pictureInPictureElement) {
                document.exitPictureInPicture().catch(() => {});
            }
            const btn = document.getElementById('pip-btn');
            if (btn) btn.classList.remove('active');
        },

        cleanup() {
            this.exit();
            _stopRenderLoop();

            if (displayVideo) {
                displayVideo.pause();
                displayVideo.srcObject = null;
                if (displayVideo.parentNode) displayVideo.parentNode.removeChild(displayVideo);
                displayVideo = null;
            }

            if (canvas) {
                if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
                canvas = null;
                ctx = null;
            }
            const srcVideo = document.getElementById('live-video');
            if (srcVideo) srcVideo.style.cssText = '';
            const overlay = document.getElementById('jikkyo-overlay');
            if (overlay) overlay.style.display = '';
        },

        isSupported() {
            return 'pictureInPictureEnabled' in document && document.pictureInPictureEnabled;
        },

        isActive() {
            return isRendering;
        },
    };
})();

/* --- 録画プレーヤー Canvas 合成 + PiP --- */
// Canvas で映像+コメントを合成。録画済みプレーヤー用 PiP でコメント表示。

const recPip = (() => {
    const _isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    const FONT_SIZE = 28;
    const CANVAS_W = 960;
    const CANVAS_H = 540;

    let canvas = null;
    let ctx = null;
    let displayVideo = null;
    let animFrameId = null;
    let isRendering = false;

    function _cacheComment(c, scaledFontSize, sizeScale) {
        const tmpCanvas = document.createElement('canvas');
        const tmpCtx = tmpCanvas.getContext('2d');
        tmpCtx.font = 'bold ' + scaledFontSize + 'px "Noto Sans JP", sans-serif';
        const m = tmpCtx.measureText(c.text);
        const pad = 4;
        tmpCanvas.width = Math.ceil(m.width) + pad * 2;
        tmpCanvas.height = Math.ceil(scaledFontSize * 1.4);
        tmpCtx.font = 'bold ' + scaledFontSize + 'px "Noto Sans JP", sans-serif';
        tmpCtx.textBaseline = 'top';
        tmpCtx.strokeStyle = '#000';
        tmpCtx.lineWidth = 3;
        tmpCtx.lineJoin = 'round';
        tmpCtx.strokeText(c.text, pad, 0);
        tmpCtx.fillStyle = '#fff';
        tmpCtx.fillText(c.text, pad, 0);
        c._cache = tmpCanvas;
        c._cachePad = pad;
        c.textWidth = m.width;
        c._fontScale = sizeScale;
    }

    function _getDuration() {
        return (typeof jikkyoSettings !== 'undefined' ? jikkyoSettings.speed : 6) * 1000;
    }

    function _setup() {
        if (canvas) return;

        const srcVideo = document.getElementById('video-player');
        const wrapper = document.querySelector('.rec-video-wrapper');
        if (!srcVideo || !wrapper) return;

        canvas = document.createElement('canvas');
        canvas.width = CANVAS_W;
        canvas.height = CANVAS_H;
        canvas.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;pointer-events:none';
        document.body.appendChild(canvas);
        ctx = canvas.getContext('2d');

        srcVideo.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none';

        const overlay = document.getElementById('rec-jikkyo-overlay');
        if (overlay) overlay.style.display = 'none';

        displayVideo = document.createElement('video');
        displayVideo.id = 'rec-canvas';
        displayVideo.muted = true;
        displayVideo.playsInline = true;
        displayVideo.autoplay = true;
        if (_isIOS) displayVideo.disablePictureInPicture = true;
        displayVideo.style.cssText = 'display:block;width:100%;background:#000';
        wrapper.insertBefore(displayVideo, wrapper.firstChild);

        displayVideo.srcObject = canvas.captureStream(60);
        displayVideo.play().catch(() => {});
    }

    function _renderFrame(timestamp) {
        if (!isRendering) return;
        const srcVideo = document.getElementById('video-player');

        if (srcVideo && srcVideo.readyState >= 2) {
            ctx.drawImage(srcVideo, 0, 0, CANVAS_W, CANVAS_H);

            const comments = recordingJikkyo.getMode() === 'overlay' ? recordingJikkyo.getActiveComments() : [];
            if (comments.length > 0) {
                const lineHeight = CANVAS_H / LANE_COUNT;
                const sizeScale = (typeof jikkyoSettings !== 'undefined') ? jikkyoSettings.size : 1.0;
                const opacityVal = (typeof jikkyoSettings !== 'undefined') ? jikkyoSettings.opacity : 0.85;
                const scaledFontSize = Math.round(FONT_SIZE * sizeScale);

                for (let i = 0; i < comments.length; i++) {
                    const c = comments[i];
                    const elapsed = timestamp - c.startTime;
                    if (elapsed > _getDuration()) continue;
                    const progress = elapsed / _getDuration();

                    if (!c._cache || c._fontScale !== sizeScale) {
                        _cacheComment(c, scaledFontSize, sizeScale);
                    }

                    const x = CANVAS_W - (CANVAS_W + c.textWidth) * progress;
                    const y = c.lane * lineHeight;
                    ctx.globalAlpha = opacityVal;
                    ctx.drawImage(c._cache, x - c._cachePad, y);
                }
                ctx.globalAlpha = 1.0;
            }
        }

        animFrameId = requestAnimationFrame(_renderFrame);
    }

    function _startRenderLoop() {
        if (isRendering) return;
        isRendering = true;
        animFrameId = requestAnimationFrame(_renderFrame);
    }

    function _stopRenderLoop() {
        isRendering = false;
        if (animFrameId) {
            cancelAnimationFrame(animFrameId);
            animFrameId = null;
        }
    }

    return {
        warmUp() {
            _setup();
            _startRenderLoop();
        },

        async toggle() {
            if (document.pictureInPictureElement) {
                document.exitPictureInPicture().catch(() => {});
                return;
            }

            const pipTarget = (_isIOS || !displayVideo)
                ? document.getElementById('video-player')
                : displayVideo;
            if (!pipTarget) return;

            try {
                await pipTarget.requestPictureInPicture();

                const btn = document.getElementById('rc-pip');
                if (btn) btn.classList.add('active');

                pipTarget.addEventListener('leavepictureinpicture', () => {
                    const b = document.getElementById('rc-pip');
                    if (b) b.classList.remove('active');
                    if (pipTarget.paused) pipTarget.play().catch(() => {});
                }, { once: true });
            } catch (e) { /* ignore */ }
        },

        exit() {
            if (document.pictureInPictureElement) {
                document.exitPictureInPicture().catch(() => {});
            }
            const btn = document.getElementById('rc-pip');
            if (btn) btn.classList.remove('active');
        },

        cleanup() {
            this.exit();
            _stopRenderLoop();

            if (displayVideo) {
                displayVideo.pause();
                displayVideo.srcObject = null;
                if (displayVideo.parentNode) displayVideo.parentNode.removeChild(displayVideo);
                displayVideo = null;
            }

            if (canvas) {
                if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
                canvas = null;
                ctx = null;
            }
            const srcVideo = document.getElementById('video-player');
            if (srcVideo) srcVideo.style.cssText = '';
            const overlay = document.getElementById('rec-jikkyo-overlay');
            if (overlay) overlay.style.display = '';
        },

        isSupported() {
            return 'pictureInPictureEnabled' in document && document.pictureInPictureEnabled;
        },

        isActive() {
            return isRendering;
        },
    };
})();

/* --- ライブプレーヤーコントロール --- */

const liveControls = (() => {
    const HIDE_DELAY = 3000;
    const ICONS = {
        play: '<i class="ph-fill ph-play"></i>',
        pause: '<i class="ph-fill ph-pause"></i>',
        volumeOn: '<i class="ph-fill ph-speaker-high"></i>',
        volumeOff: '<i class="ph-fill ph-speaker-slash"></i>',
        pip: '<i class="ph ph-picture-in-picture"></i>',
        fullscreen: '<i class="ph ph-corners-out"></i>',
        fullscreenExit: '<i class="ph ph-corners-in"></i>',
        record: '<i class="ph-fill ph-record"></i>',
        recordActive: '<i class="ph-fill ph-record" style="color:#ff3b30"></i>',
    };

    let hideTimer = null;
    let eventsAttached = false;

    function _getLiveVideo() { return document.getElementById('live-video'); }

    function _updatePlayIcon() {
        const btn = document.getElementById('lc-play');
        if (!btn) return;
        const video = _getLiveVideo();
        btn.innerHTML = (video && video.paused) ? ICONS.play : ICONS.pause;
    }

    function _updateVolumeIcon() {
        const btn = document.getElementById('lc-mute');
        if (!btn) return;
        const video = _getLiveVideo();
        const muted = video && (video.muted || video.volume === 0);
        btn.innerHTML = muted ? ICONS.volumeOff : ICONS.volumeOn;
    }

    function _isFullscreen() {
        return !!(document.fullscreenElement || document.webkitFullscreenElement)
            || _isFakeLandscape(document.getElementById('live-player-container'));
    }

    function _updateFullscreenIcon() {
        const btn = document.getElementById('lc-fullscreen');
        if (!btn) return;
        const isFs = _isFullscreen();
        btn.innerHTML = isFs ? ICONS.fullscreenExit : ICONS.fullscreen;
        if (!isFs) _unlockOrientation();
    }

    function _updatePipIcon() {
        const btn = document.getElementById('pip-btn');
        if (!btn) return;
        btn.innerHTML = ICONS.pip;
    }

    function _updateRecordIcon() {
        const btn = document.getElementById('lc-record');
        if (!btn) return;
        btn.innerHTML = liveRecording ? ICONS.recordActive : ICONS.record;
        btn.classList.toggle('recording', liveRecording);
    }

    function _showControls() {
        const controls = document.getElementById('live-controls');
        const container = document.getElementById('live-player-container');
        if (controls) controls.classList.add('visible');
        if (container) container.classList.add('controls-visible');
        _resetHideTimer();
    }

    function _hideControls() {
        const controls = document.getElementById('live-controls');
        const container = document.getElementById('live-player-container');
        if (controls) controls.classList.remove('visible');
        if (container) container.classList.remove('controls-visible');
    }

    function _resetHideTimer() {
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(_hideControls, HIDE_DELAY);
    }

    function _onMouseMove() { _showControls(); }
    function _onMouseLeave() {
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(_hideControls, 800);
    }
    function _onTouch() {
        const controls = document.getElementById('live-controls');
        if (controls && controls.classList.contains('visible')) {
            _hideControls();
        } else {
            _showControls();
        }
    }

    return {
        init() {
            _updatePlayIcon();
            _updateVolumeIcon();
            _updateFullscreenIcon();
            _updatePipIcon();
            _updateRecordIcon();
            const recBtn = document.getElementById('lc-record');
            if (recBtn) recBtn.style.display = '';

            const video = _getLiveVideo();
            if (video) {
                video.addEventListener('play', _updatePlayIcon);
                video.addEventListener('pause', _updatePlayIcon);
                video.addEventListener('volumechange', () => {
                    _updateVolumeIcon();
                    const slider = document.getElementById('lc-volume');
                    if (slider) slider.value = video.muted ? 0 : video.volume;
                });
                const slider = document.getElementById('lc-volume');
                if (slider) slider.value = video.volume;
            }

            if (!eventsAttached) {
                const wrapper = document.getElementById('live-video-wrapper');
                if (wrapper) {
                    wrapper.addEventListener('mousemove', _onMouseMove);
                    wrapper.addEventListener('mouseleave', _onMouseLeave);
                    wrapper.addEventListener('touchstart', _onTouch, { passive: true });
                }
                document.addEventListener('fullscreenchange', _updateFullscreenIcon);
                document.addEventListener('webkitfullscreenchange', _updateFullscreenIcon);
                eventsAttached = true;
            }

            _showControls();
        },

        cleanup() {
            if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
            _hideControls();
            const container = document.getElementById('live-player-container');
            if (_isFakeLandscape(container)) _exitFakeLandscape(container);
            liveRecording = false;
            const recBtn = document.getElementById('lc-record');
            if (recBtn) recBtn.style.display = 'none';
            if (document.fullscreenElement || document.webkitFullscreenElement) {
                (document.exitFullscreen || document.webkitExitFullscreen).call(document).catch(() => {});
            }
        },

        togglePlay() {
            const video = _getLiveVideo();
            if (!video) return;
            if (video.paused) {
                video.play().then(() => {
                    document.getElementById('live-status').innerHTML =
                        '<span class="live-indicator"></span> 再生中';
                }).catch(() => {});
            } else {
                video.pause();
            }
            _showControls();
        },

        toggleMute() {
            const video = _getLiveVideo();
            if (!video) return;
            video.muted = !video.muted;
            _showControls();
        },

        setVolume(val) {
            const video = _getLiveVideo();
            if (!video) return;
            video.volume = parseFloat(val);
            if (parseFloat(val) > 0 && video.muted) video.muted = false;
            _updateVolumeIcon();
            _showControls();
        },

        toggleFullscreen() {
            const container = document.getElementById('live-player-container');
            if (!container) return;
            if (_isFakeLandscape(container)) {
                _exitFakeLandscape(container);
                _updateFullscreenIcon();
            } else if (document.fullscreenElement || document.webkitFullscreenElement) {
                (document.exitFullscreen || document.webkitExitFullscreen).call(document).catch(() => {});
            } else if (_isIOS) {
                _enterFakeLandscape(container);
                _updateFullscreenIcon();
            } else if (container.requestFullscreen) {
                container.requestFullscreen().then(() => _lockLandscape()).catch(() => {});
            } else if (container.webkitRequestFullscreen) {
                container.webkitRequestFullscreen();
                _lockLandscape();
            }
            _showControls();
        },

        reload() {
            if (!livePlayer) return;
            const title = document.getElementById('live-player-title').textContent;
            if (liveRecScheduleId) {
                const id = liveRecScheduleId;
                stopLive(true);
                startLiveFromRecording(id, title.replace(' (録画中)', ''));
            } else if (liveCurrentCh) {
                const ch = liveCurrentCh;
                const sid = liveCurrentSid;
                stopLive(true);
                startLive(ch, title, sid);
            }
        },

        switchService(sid) {
            if (!liveCurrentCh) return;
            const chInfo = channels.find(c => c.number === liveCurrentCh);
            const svc = chInfo && chInfo.services ? chInfo.services.find(s => s.sid === sid) : null;
            const name = svc ? svc.name : document.getElementById('live-player-title').textContent;
            const ch = liveCurrentCh;
            stopLive(true);
            startLive(ch, name, sid);
        },

        async toggleRecord() {
            if (!liveCurrentCh) return;
            _showControls();
            try {
                if (liveRecording) {
                    await API.post('/api/live/record/stop', { channel: liveCurrentCh });
                    liveRecording = false;
                } else {
                    await API.post('/api/live/record/start', { channel: liveCurrentCh });
                    liveRecording = true;
                }
            } catch (err) {
                document.getElementById('live-error').textContent = '録画エラー: ' + (err.message || err);
            }
            _updateRecordIcon();
        },
    };
})();

function initLiveSection() {
    loadLiveChannelGrid();
}

async function loadLiveChannelGrid() {
    const grid = document.getElementById('live-channel-grid');
    if (!grid || channels.length === 0) return;

    // EPG・実況勢い・録画中番組を並列フェッチ
    const [nowResult, forceResult, recResult] = await Promise.allSettled([
        API.get('/api/live/now-all'),
        API.get('/api/jikkyo/force'),
        API.get('/api/recordings/active'),
    ]);

    const nowPlaying = nowResult.status === 'fulfilled' ? (nowResult.value.now_playing || {}) : {};
    const forceMap = forceResult.status === 'fulfilled' ? (forceResult.value.force || {}) : {};
    // 録画中チャンネル → schedule_id のマップ (ファイル mtime ベース判定)
    const recordingMap = {};
    if (recResult.status === 'fulfilled') {
        (recResult.value.recordings || []).forEach(s => {
            recordingMap[s.channel] = s.id;
        });
    }

    const now = new Date();
    let html = '';
    channels.forEach(ch => {
        const prog = nowPlaying[ch.name];
        const isPlaying = liveCurrentCh === ch.number;
        const jkId = JIKKYO_MAP[ch.name];
        const forceInfo = jkId ? forceMap[jkId] : null;

        const recId = recordingMap[ch.name];
        const onclick = recId
            ? `startLiveFromRecording(${recId}, '${escapeHtml(ch.name)}')`
            : `startLive('${escapeHtml(ch.number)}', '${escapeHtml(ch.name)}'${ch.sid ? `, '${ch.sid}'` : ''})`;
        html += `<div class="live-ch-card${isPlaying ? ' playing' : ''}${recId ? ' recording' : ''}" onclick="${onclick}">`;

        // ヘッダー: チャンネル名 + 勢いバッジ
        if (forceInfo && forceInfo.force != null) {
            const f = forceInfo.force;
            // 白(0) → 黄(50) → 赤(150+)
            const t = Math.min(f / 150, 1);
            const r = 255;
            const g = Math.round(255 - t * 105);  // 255→150
            const b = Math.round(Math.max(0, 255 - f * (255 / 50)));  // 255→0 at 50
            const forceColor = f <= 10 ? '' : `color:rgb(${r},${g},${b})`;
            const forceWeight = f >= 100 ? ';font-weight:700' : '';
            html += `<div class="live-ch-header">`;
            html += `<div class="live-ch-name">${escapeHtml(ch.name)}</div>`;
            html += `<div class="live-ch-force">`;
            html += `<span class="live-ch-force-value" style="${forceColor}${forceWeight}">${f}</span>`;
            html += `<span class="live-ch-force-unit">/min</span>`;
            html += `</div></div>`;
        } else {
            html += `<div class="live-ch-name">${escapeHtml(ch.name)}</div>`;
        }
        if (recId) {
            html += `<div class="live-ch-rec-badge"><i class="ph-fill ph-record"></i> 録画中</div>`;
        }

        if (prog) {
            const start = new Date(prog.start_time.replace(' ', 'T'));
            const end = new Date(prog.end_time.replace(' ', 'T'));
            const total = end - start;
            const elapsed = now - start;
            const pct = total > 0 ? Math.min(100, Math.max(0, (elapsed / total) * 100)) : 0;
            html += `<div class="live-ch-programme">`;
            html += `<div class="time">${formatTime(prog.start_time)} - ${formatTime(prog.end_time)}</div>`;
            html += `<div class="title">${escapeHtml(prog.title)}</div>`;
            if (prog.description) html += `<div class="desc">${escapeHtml(prog.description)}</div>`;
            html += `</div>`;
            html += `<div class="live-ch-progress"><div class="live-ch-progress-bar" style="width:${pct.toFixed(1)}%"></div></div>`;
        } else {
            html += `<div class="live-ch-no-info">番組情報なし</div>`;
        }
        html += '</div>';
    });
    grid.innerHTML = html;
}

function startLiveFromRecording(scheduleId, chName) {
    if (typeof mpegts === 'undefined' || !mpegts.isSupported()) {
        document.getElementById('live-error').textContent =
            'このブラウザは mpegts.js に対応していません。Chrome または Edge をお使いください。';
        return;
    }

    // 既に同じ録画を視聴中なら何もしない
    if (liveRecScheduleId === scheduleId && livePlayer) return;

    // 既に再生中なら停止
    if (livePlayer) stopLive(true);

    liveRecScheduleId = scheduleId;
    liveCurrentCh = null;

    // UI 更新
    document.getElementById('live-error').textContent = '';
    document.getElementById('live-stream-info').textContent = '';
    document.getElementById('live-player-title').textContent = chName + ' (録画中)';
    document.getElementById('live-player-area').style.display = '';
    document.getElementById('live-status').innerHTML =
        '<span class="live-indicator"></span> 接続中...';

    loadLiveChannelGrid();

    const videoEl = document.getElementById('live-video');

    livePlayer = mpegts.createPlayer({
        type: 'mpegts',
        isLive: true,
        url: `/recordings/live?schedule_id=${scheduleId}&quality=${streamQuality}`,
    }, {
        enableWorker: false,
        liveBufferLatencyChasing: true,
        liveBufferLatencyMaxLatency: 5.0,
        liveBufferLatencyMinRemain: 2.0,
        liveBufferLatencyChasingSpeed: 1.1,
        fixAudioTimestampGap: true,
        accurateSeek: true,
        autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: 30,
        autoCleanupMinBackwardDuration: 15,
    });

    livePlayer.attachMediaElement(videoEl);

    livePlayer.on(mpegts.Events.MEDIA_INFO, () => {
        document.getElementById('live-status').innerHTML =
            '<span class="live-indicator"></span> 再生中 (録画ファイル)';
    });
    livePlayer.on(mpegts.Events.ERROR, (type, detail) => {
        document.getElementById('live-error').textContent =
            'ストリームエラー: ' + (detail || type || '');
    });

    livePlayer.load();
    videoEl.addEventListener('canplaythrough', () => {
        videoEl.play().catch(() => {});
    }, { once: true });

    liveNowTimer = setInterval(loadLiveChannelGrid, 60000);

    // NX-Jikkyo 実況コメント開始
    jikkyo.initUI();
    jikkyo.start(chName);

    // PiP ボタン表示
    if (jikkyoPip.isSupported()) {
        document.getElementById('pip-btn').style.display = '';
        jikkyoPip.warmUp();
    }

    liveControls.init();
}

function startLive(chNum, chName, sid) {
    if (typeof mpegts === 'undefined' || !mpegts.isSupported()) {
        document.getElementById('live-error').textContent =
            'このブラウザは mpegts.js に対応していません。Chrome または Edge をお使いください。';
        return;
    }

    // 既に同じチャンネル・同じSIDを視聴中なら何もしない
    if (liveCurrentCh === chNum && liveCurrentSid === (sid || null) && livePlayer) return;

    // 既に別チャンネル再生中なら停止
    if (livePlayer) stopLive(true);

    liveCurrentCh = chNum;
    liveCurrentSid = sid || null;

    // サブチャンネルセレクタ更新
    const subSel = document.getElementById('lc-subchannel');
    const chInfo = channels.find(c => c.number === chNum);
    if (chInfo && chInfo.services && chInfo.services.length > 1) {
        subSel.innerHTML = chInfo.services.map(s =>
            `<option value="${s.sid || ''}"${(s.sid || '') === (sid || '') ? ' selected' : ''}>${escapeHtml(s.name)}</option>`
        ).join('');
        subSel.style.display = '';
    } else {
        subSel.style.display = 'none';
    }

    // UI 更新
    document.getElementById('live-error').textContent = '';
    document.getElementById('live-stream-info').textContent = '';
    document.getElementById('live-player-title').textContent = chName;
    document.getElementById('live-player-area').style.display = '';
    document.getElementById('live-status').innerHTML =
        '<span class="live-indicator"></span> 接続中...';

    // カードのハイライト: grid 再描画で反映
    loadLiveChannelGrid();

    const videoEl = document.getElementById('live-video');

    let streamUrl = `/live/stream?ch=${chNum}&quality=${streamQuality}`;
    if (sid) streamUrl += `&sid=${sid}`;
    livePlayer = mpegts.createPlayer({
        type: 'mpegts',
        isLive: true,
        url: streamUrl,
    }, {
        enableWorker: false,
        liveBufferLatencyChasing: true,
        liveBufferLatencyMaxLatency: 3.0,
        liveBufferLatencyMinRemain: 1.0,
        liveBufferLatencyChasingSpeed: 1.1,
        fixAudioTimestampGap: true,
        accurateSeek: true,
        autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: 30,
        autoCleanupMinBackwardDuration: 15,
    });

    livePlayer.attachMediaElement(videoEl);

    let _mediaInfoCount = 0;
    livePlayer.on(mpegts.Events.MEDIA_INFO, (info) => {
        _mediaInfoCount++;
        document.getElementById('live-status').innerHTML =
            '<span class="live-indicator"></span> 再生中';
        let infoText = '';
        if (info.videoCodec) infoText += `映像: ${info.videoCodec}`;
        if (info.width && info.height) infoText += ` ${info.width}x${info.height}`;
        if (info.audioCodec) infoText += ` / 音声: ${info.audioCodec}`;
        document.getElementById('live-stream-info').textContent = infoText;

        // 番組切り替え時: 2回目以降のMEDIA_INFOはストリーム構成変化を示す
        // バッファ末尾にシークして古いデータをスキップ
        if (_mediaInfoCount > 1) {
            const buf = videoEl.buffered;
            if (buf.length > 0) {
                videoEl.currentTime = buf.end(buf.length - 1) - 0.3;
            }
        }
    });

    livePlayer.on(mpegts.Events.ERROR, (type, detail) => {
        document.getElementById('live-error').textContent =
            `再生エラー: ${detail || type}`;
    });

    videoEl.addEventListener('playing', () => {
        document.getElementById('live-status').innerHTML =
            '<span class="live-indicator"></span> 再生中';
    }, { once: true });

    // stall後の同期修正: バッファ末尾にシークして再同期
    let stallDetected = false;
    videoEl.addEventListener('waiting', () => { stallDetected = true; });
    videoEl.addEventListener('playing', () => {
        if (stallDetected) {
            stallDetected = false;
            const buf = videoEl.buffered;
            if (buf.length > 0) {
                const liveEdge = buf.end(buf.length - 1);
                if (liveEdge - 0.5 > videoEl.currentTime) {
                    videoEl.currentTime = liveEdge - 0.5;
                }
            }
        }
    });

    // 定期的なドリフトチェック: ライブエッジから離れすぎたらシークで復帰
    videoEl.addEventListener('timeupdate', () => {
        if (videoEl.paused || videoEl.seeking) return;
        const buf = videoEl.buffered;
        if (buf.length === 0) return;
        const liveEdge = buf.end(buf.length - 1);
        const drift = liveEdge - videoEl.currentTime;
        if (drift > 3.0) {
            videoEl.currentTime = liveEdge - 0.5;
        }
    });

    livePlayer.load();
    videoEl.addEventListener('canplaythrough', () => {
        videoEl.play().catch(() => {
            document.getElementById('live-status').innerHTML =
                '<span class="live-indicator"></span> 再生ボタンを押してください';
        });
    }, { once: true });

    // 番組情報を定期更新
    if (liveNowTimer) clearInterval(liveNowTimer);
    liveNowTimer = setInterval(loadLiveChannelGrid, 60000);

    // NX-Jikkyo 実況コメント開始
    jikkyo.initUI();
    jikkyo.start(chName);

    // PiP ボタン表示
    if (jikkyoPip.isSupported()) {
        document.getElementById('pip-btn').style.display = '';
        jikkyoPip.warmUp();
    }

    // プレーヤーコントロール初期化
    liveControls.init();
}

function stopLive(keepGrid) {
    // 録画中なら自動停止
    if (liveRecording) {
        API.post('/api/live/record/stop', { channel: liveCurrentCh }).catch(() => {});
        liveRecording = false;
    }

    // コントロール停止
    liveControls.cleanup();

    // Canvas PiP 停止
    jikkyoPip.cleanup();
    document.getElementById('pip-btn').style.display = 'none';

    // NX-Jikkyo 実況コメント停止
    jikkyo.stop();

    if (livePlayer) {
        livePlayer.destroy();
        livePlayer = null;
    }
    if (liveNowTimer) {
        clearInterval(liveNowTimer);
        liveNowTimer = null;
    }

    liveCurrentCh = null;
    liveCurrentSid = null;
    liveRecScheduleId = null;

    // UI リセット
    document.getElementById('lc-subchannel').style.display = 'none';
    document.getElementById('live-player-area').style.display = 'none';
    document.getElementById('live-status').textContent = '';
    document.getElementById('live-stream-info').textContent = '';
    document.getElementById('live-error').textContent = '';

    // カードのハイライト解除
    if (!keepGrid) {
        document.querySelectorAll('.live-ch-card').forEach(c => c.classList.remove('playing'));
    }
}

/* --- 初期化 --- */

async function init() {
    // epg.html など別ページから app.js を読み込んだ場合はメインUI初期化をスキップ
    if (!document.getElementById('epg-table')) return;

    // ナビゲーションイベント (API失敗時もナビが動くよう先に登録)
    document.querySelectorAll('nav a[data-section]').forEach(a => {
        a.addEventListener('click', (e) => {
            e.preventDefault();
            switchSection(a.dataset.section);
        });
    });

    // 録画再生シークバー
    const seekBar = document.getElementById('video-seek-bar');
    if (seekBar) {
        seekBar.addEventListener('input', () => {
            seekBarDragging = true;
            document.getElementById('video-current-time').textContent =
                formatDuration(parseFloat(seekBar.value));
        });
        seekBar.addEventListener('change', () => {
            seekBarDragging = false;
            if (recordingPath && recordingDuration) {
                startRecordingStream(parseFloat(seekBar.value));
            }
        });
    }

    // 録画ルールプレビュー: debounce 付き input イベント
    let previewTimer = null;
    const ruleKeyword = document.getElementById('rule-keyword');
    if (ruleKeyword) {
        ruleKeyword.addEventListener('input', () => {
            clearTimeout(previewTimer);
            previewTimer = setTimeout(previewRule, 500);
        });
    }

    // チャンネル変更時もプレビュー更新
    const ruleChannel = document.getElementById('rule-channel');
    if (ruleChannel) {
        ruleChannel.addEventListener('change', () => {
            clearTimeout(previewTimer);
            previewTimer = setTimeout(previewRule, 300);
        });
    }

    // ジャンル変更時もプレビュー更新
    const ruleCategory = document.getElementById('rule-category');
    if (ruleCategory) {
        ruleCategory.addEventListener('change', () => {
            clearTimeout(previewTimer);
            previewTimer = setTimeout(previewRule, 300);
        });
    }

    // 品質セレクター初期化
    document.querySelectorAll('#nav-quality-select, #drawer-quality-select').forEach(sel => {
        sel.value = streamQuality;
    });

    // 初期セクション表示 (hash があればそのセクションを開く)
    const initialSection = location.hash.replace('#', '') || 'live';
    switchSection(initialSection);

    // チャンネル一覧と番組表を並列取得
    const now = nowTimestamp();
    try {
        const [chData, epgData, catData] = await Promise.all([
            API.get('/api/channels'),
            API.get(`/api/programmes?limit=10000&active_after=${encodeURIComponent(now)}`),
            API.get('/api/categories'),
        ]);

        channels = chData.channels || [];

        // チャンネルセレクトボックスを生成
        const selects = document.querySelectorAll('.channel-select');
        selects.forEach(sel => {
            const current = sel.value;
            let opts = '<option value="">全チャンネル</option>';
            channels.forEach(ch => {
                opts += `<option value="${escapeHtml(ch.name)}">${escapeHtml(ch.name)}</option>`;
            });
            sel.innerHTML = opts;
            sel.value = current;
        });

        categories = catData.categories || [];
        const catGroup = document.getElementById('epg-category');
        if (catGroup) {
            let catBtns = '<button class="btn-filter active" data-value="" onclick="setFilter(this, loadEPG)">全ジャンル</button>';
            categories.forEach(cat => {
                catBtns += `<button class="btn-filter" data-value="${escapeHtml(cat)}" onclick="setFilter(this, loadEPG)">${escapeHtml(cat)}</button>`;
            });
            catGroup.innerHTML = catBtns;
        }

        renderEPGTable(epgData.programmes);

        // チャンネルデータ取得完了後、ライブセクション表示中ならグリッド再描画
        if (document.getElementById('section-live').classList.contains('active')) {
            loadLiveChannelGrid();
        }
    } catch (err) {
        document.getElementById('epg-table').innerHTML =
            `<p style="color:var(--error)">データの読み込みに失敗しました: ${escapeHtml(err.message)}</p>`;
    }
}

document.addEventListener('DOMContentLoaded', init);
