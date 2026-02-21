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

function todayStr() {
    return new Date().toISOString().slice(0, 10);
}

function statusBadge(status) {
    return `<span class="badge badge-${status}">${status}</span>`;
}

function levelBadge(level) {
    return `<span class="badge badge-${level}">${level}</span>`;
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
    if (livePlayer && liveCurrentCh) {
        const ch = liveCurrentCh;
        const title = document.getElementById('live-player-title').textContent;
        stopLive(true);
        startLive(ch, title);
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
    else if (name === 'logs') loadLogs();
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
    const d = new Date();
    const now = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;

    let url = `/api/programmes?limit=10000&active_after=${encodeURIComponent(now)}`;
    if (category) url += `&category=${encodeURIComponent(category)}`;

    try {
        const data = await API.get(url);
        renderEPGTable(data.programmes);
    } catch (err) {
        document.getElementById('epg-table').innerHTML =
            `<p style="color:var(--danger)">番組表の読み込みに失敗しました: ${escapeHtml(err.message)}</p>`;
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

    // リモコン番号順にソート (地上波の一般的な並び)
    const CH_ORDER = [
        'NHK総合', 'NHK-Eテレ', 'Eテレ',
        '日テレ', '日本テレビ',
        'テレビ朝日', 'テレ朝',
        'TBS',
        'テレビ東京', 'テレ東',
        'フジテレビ', 'フジ',
        'TOKYO MX', 'MX',
    ];
    const chSortKey = (name) => {
        for (let i = 0; i < CH_ORDER.length; i++) {
            if (name.includes(CH_ORDER[i])) return i;
        }
        return CH_ORDER.length;
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
            html += `<div class="epg-programme epg-cell ${catCls}" style="top:${top}px;height:${height}px" onmouseenter="showProgrammeDetail(this, ${p.idx})" onclick="showProgrammeDetail(this, ${p.idx})">`;
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

/* 番組詳細表示 */
let _detailHideTimer = null;

function showProgrammeDetail(el, idx) {
    const p = window._programmes[idx];
    const detail = document.getElementById('programme-detail');
    const isMobile = window.innerWidth < 768;

    // 非表示タイマーをキャンセル
    if (_detailHideTimer) { clearTimeout(_detailHideTimer); _detailHideTimer = null; }

    detail.innerHTML = `
        <h4>${escapeHtml(p.title)}</h4>
        <div class="meta">
            ${escapeHtml(p.channel)} | ${formatDateTime(p.start_time)} - ${formatTime(p.end_time)}
            ${p.category ? ' | ' + escapeHtml(p.category) : ''}
        </div>
        <div class="desc">${escapeHtml(p.description || '')}</div>
        <div style="margin-top:0.75rem;display:flex;gap:0.5rem;flex-wrap:wrap">
            <button class="btn btn-primary btn-sm" onclick="directSchedule(${idx})">
                録画予約
            </button>
            <button class="btn btn-secondary btn-sm" onclick="quickAddRule('${escapeHtml(p.title)}')">
                録画ルールを作成
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

function hideProgrammeDetail() {
    _detailHideTimer = setTimeout(() => {
        document.getElementById('programme-detail').classList.remove('active');
    }, 200);
}

// ポップアップ自体にマウスが入ったら非表示をキャンセル
document.addEventListener('DOMContentLoaded', () => {
    const detail = document.getElementById('programme-detail');
    if (detail) {
        detail.addEventListener('mouseenter', () => {
            if (_detailHideTimer) { clearTimeout(_detailHideTimer); _detailHideTimer = null; }
        });
        detail.addEventListener('mouseleave', () => {
            hideProgrammeDetail();
        });
    }
});

// 番組ブロックからマウスが離れたら非表示（遅延付き）
document.addEventListener('mouseout', (e) => {
    if (e.target.closest && e.target.closest('.epg-cell')) {
        const related = e.relatedTarget;
        if (!related || (!related.closest('.epg-cell') && !related.closest('.programme-detail'))) {
            hideProgrammeDetail();
        }
    }
});

// クリックで他の場所を押した場合も閉じる
document.addEventListener('click', (e) => {
    if (!e.target.closest('.epg-cell') && !e.target.closest('.programme-detail')) {
        document.getElementById('programme-detail').classList.remove('active');
    }
});

/* --- 録画ルール --- */

async function loadRules() {
    const tbody = document.getElementById('rules-table');
    const cardsEl = document.getElementById('rules-cards');
    try {
        const data = await API.get('/api/rules');
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
                <td>${escapeHtml(r.category || '-')}</td>
                <td>${r.enabled ? '<span class="badge badge-enabled">有効</span>' : '<span class="badge badge-disabled">無効</span>'}</td>
                <td>
                    <button class="btn btn-secondary btn-sm" onclick="editRule(${r.id})">編集</button>
                    <button class="btn btn-danger btn-sm" onclick="deleteRule(${r.id}, '${escapeHtml(r.name)}')">削除</button>
                </td>
            </tr>
        `).join('');

        // Card list for mobile
        if (cardsEl) {
            cardsEl.innerHTML = data.rules.map(r => `
                <div class="rule-card">
                    <div class="rule-title">${escapeHtml(r.name)}</div>
                    <div class="rule-meta">
                        キーワード: ${escapeHtml(r.keyword || '*')}
                        ${r.category ? ' | ジャンル: ' + escapeHtml(r.category) : ''}
                        | ${r.enabled ? '<span class="badge badge-enabled">有効</span>' : '<span class="badge badge-disabled">無効</span>'}
                    </div>
                    <div class="rule-actions">
                        <button class="btn btn-secondary btn-sm" onclick="editRule(${r.id})">編集</button>
                        <button class="btn btn-danger btn-sm" onclick="deleteRule(${r.id}, '${escapeHtml(r.name)}')">削除</button>
                    </div>
                </div>
            `).join('');
        }
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--danger)">読み込みに失敗しました: ${escapeHtml(err.message)}</td></tr>`;
        if (cardsEl) cardsEl.innerHTML = `<p style="padding:1rem;color:var(--danger)">読み込みに失敗しました: ${escapeHtml(err.message)}</p>`;
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

    // 編集時はキーワードまたはカテゴリがあれば即プレビュー
    if (rule && (rule.keyword || rule.category)) {
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

async function saveRule() {
    const form = document.getElementById('rule-form');
    const ruleId = form.dataset.ruleId;
    const data = {
        name: form.elements['rule-name'].value,
        keyword: form.elements['rule-keyword'].value || null,
        channel: null,
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
    const category = document.getElementById('rule-category').value;
    const preview = document.getElementById('rule-preview');
    const countEl = document.getElementById('rule-preview-count');
    const tableEl = document.getElementById('rule-preview-table');

    if (!keyword && !category) {
        preview.style.display = 'none';
        tableEl.innerHTML = '';
        countEl.textContent = '0';
        return;
    }

    preview.style.display = '';
    tableEl.innerHTML = '<p style="color:var(--text-muted)">検索中...</p>';

    try {
        let searchUrl = `/api/programmes/search?limit=30`;
        if (keyword) searchUrl += `&keyword=${encodeURIComponent(keyword)}`;
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
    const status = getFilterValue('schedule-status');
    let url = '/api/schedules?limit=200';
    if (status) url += `&status=${status}`;

    const tbody = document.getElementById('schedules-table');
    const cardsEl = document.getElementById('schedules-cards');
    try {
        const data = await API.get(url);
        if (!data.schedules || data.schedules.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted)">スケジュールなし</td></tr>';
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
                <td>${statusBadge(s.status)}</td>
                <td>${escapeHtml(s.rule_name || '-')}</td>
            </tr>
        `).join('');

        // Card list for mobile
        if (cardsEl) {
            cardsEl.innerHTML = data.schedules.map(s => `
                <div class="schedule-card">
                    <div class="schedule-title">${escapeHtml(s.title)}</div>
                    <div class="schedule-meta">${escapeHtml(s.channel)} | ${formatDateTime(s.start_time)} - ${formatTime(s.end_time)}</div>
                    ${statusBadge(s.status)}
                    ${s.rule_name ? ' <span style="font-size:0.8rem;color:var(--text-muted)">' + escapeHtml(s.rule_name) + '</span>' : ''}
                </div>
            `).join('');
        }
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--danger)">読み込みに失敗しました: ${escapeHtml(err.message)}</td></tr>`;
        if (cardsEl) cardsEl.innerHTML = `<p style="padding:1rem;color:var(--danger)">読み込みに失敗しました: ${escapeHtml(err.message)}</p>`;
    }
}

/* --- ログ --- */

async function loadLogs() {
    const level = getFilterValue('log-level');
    let url = '/api/logs?limit=200';
    if (level) url += `&level=${level}`;

    const tbody = document.getElementById('logs-table');
    const cardsEl = document.getElementById('logs-cards');
    try {
        const data = await API.get(url);
        if (!data.logs || data.logs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">ログなし</td></tr>';
            if (cardsEl) cardsEl.innerHTML = '<p style="padding:1rem;color:var(--text-muted)">ログなし</p>';
            return;
        }
        tbody.innerHTML = data.logs.map(l => `
            <tr>
                <td>${formatDateTime(l.timestamp)}</td>
                <td>${levelBadge(l.level)}</td>
                <td>${escapeHtml(l.schedule_title || '-')}</td>
                <td>${escapeHtml(l.schedule_channel || '-')}</td>
                <td>${escapeHtml(l.message)}</td>
            </tr>
        `).join('');

        // Card list for mobile
        if (cardsEl) {
            cardsEl.innerHTML = data.logs.map(l => `
                <div class="log-card">
                    <div class="log-header">
                        ${levelBadge(l.level)}
                        <span class="log-time">${formatDateTime(l.timestamp)}</span>
                    </div>
                    <div class="log-message">${escapeHtml(l.message)}</div>
                    ${(l.schedule_title || l.schedule_channel) ? '<div class="log-programme">' + escapeHtml(l.schedule_title || '') + (l.schedule_channel ? ' / ' + escapeHtml(l.schedule_channel) : '') + '</div>' : ''}
                </div>
            `).join('');
        }
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--danger)">読み込みに失敗しました: ${escapeHtml(err.message)}</td></tr>`;
        if (cardsEl) cardsEl.innerHTML = `<p style="padding:1rem;color:var(--danger)">読み込みに失敗しました: ${escapeHtml(err.message)}</p>`;
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
            `<p style="color:var(--danger)">録画一覧の読み込みに失敗しました: ${escapeHtml(err.message)}</p>`;
    }
}

function renderRecordings(series) {
    const container = document.getElementById('recordings-list');
    if (!series || series.length === 0) {
        container.innerHTML = '<p style="color:var(--text-muted)">録画ファイルがありません</p>';
        return;
    }

    let html = '';
    series.forEach((s, idx) => {
        html += `<div class="card" style="padding:0;margin-bottom:0.5rem">`;
        html += `<div class="recordings-series-header" onclick="toggleSeries(${idx})">`;
        html += `<span class="recordings-series-arrow" id="series-arrow-${idx}">&#9654;</span>`;
        html += `<strong>${escapeHtml(s.name)}</strong>`;
        html += `<span style="margin-left:auto;color:var(--text-muted);font-size:0.85rem">${s.file_count} ファイル / ${formatFileSize(s.total_size)}</span>`;
        html += `</div>`;
        html += `<div class="recordings-files" id="series-files-${idx}" style="display:none">`;
        html += `<table><thead><tr><th>ファイル名</th><th>サイズ</th><th>更新日時</th><th>操作</th></tr></thead><tbody>`;
        s.files.forEach(f => {
            const encodedPath = encodeURIComponent(f.path).replace(/%2F/g, '/');
            html += `<tr>`;
            html += `<td class="recordings-filename">${escapeHtml(f.name)}</td>`;
            html += `<td style="white-space:nowrap">${formatFileSize(f.size)}</td>`;
            html += `<td style="white-space:nowrap">${escapeHtml(f.mtime)}</td>`;
            html += `<td style="white-space:nowrap">`;
            html += `<button class="btn btn-primary btn-sm" onclick="playRecording('${encodedPath}', '${escapeHtml(f.name)}')">再生</button> `;
            html += `<a class="btn btn-secondary btn-sm" href="/recordings/${encodedPath}?download=1">ダウンロード</a>`;
            html += `</td></tr>`;
        });
        html += `</tbody></table>`;
        // Mobile card layout
        html += `<div class="recordings-file-card">`;
        s.files.forEach(f => {
            const encodedPath = encodeURIComponent(f.path).replace(/%2F/g, '/');
            html += `<div class="recordings-file-card-item">`;
            html += `<div class="recordings-file-card-name">${escapeHtml(f.name)}</div>`;
            html += `<div class="recordings-file-card-meta">${formatFileSize(f.size)} / ${escapeHtml(f.mtime)}</div>`;
            html += `<div class="recordings-file-card-actions">`;
            html += `<button class="btn btn-primary btn-sm" onclick="playRecording('${encodedPath}', '${escapeHtml(f.name)}')">再生</button>`;
            html += `<a class="btn btn-secondary btn-sm" href="/recordings/${encodedPath}?download=1">ダウンロード</a>`;
            html += `</div></div>`;
        });
        html += `</div>`;
        html += `</div></div>`;
    });

    container.innerHTML = html;

    // Generate initial letter filter pills
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
    // Render without re-generating the filter pills
    const container = document.getElementById('recordings-list');
    if (!series || series.length === 0) {
        container.innerHTML = '<p style="color:var(--text-muted)">該当する録画がありません</p>';
        return;
    }

    let html = '';
    series.forEach((s, idx) => {
        // Use global index for toggle
        const globalIdx = recordingsData.indexOf(s);
        html += `<div class="card" style="padding:0;margin-bottom:0.5rem">`;
        html += `<div class="recordings-series-header" onclick="toggleSeries(${globalIdx})">`;
        html += `<span class="recordings-series-arrow" id="series-arrow-${globalIdx}">&#9654;</span>`;
        html += `<strong>${escapeHtml(s.name)}</strong>`;
        html += `<span style="margin-left:auto;color:var(--text-muted);font-size:0.85rem">${s.file_count} ファイル / ${formatFileSize(s.total_size)}</span>`;
        html += `</div>`;
        html += `<div class="recordings-files" id="series-files-${globalIdx}" style="display:none">`;
        html += `<table><thead><tr><th>ファイル名</th><th>サイズ</th><th>更新日時</th><th>操作</th></tr></thead><tbody>`;
        s.files.forEach(f => {
            const encodedPath = encodeURIComponent(f.path).replace(/%2F/g, '/');
            html += `<tr>`;
            html += `<td class="recordings-filename">${escapeHtml(f.name)}</td>`;
            html += `<td style="white-space:nowrap">${formatFileSize(f.size)}</td>`;
            html += `<td style="white-space:nowrap">${escapeHtml(f.mtime)}</td>`;
            html += `<td style="white-space:nowrap">`;
            html += `<button class="btn btn-primary btn-sm" onclick="playRecording('${encodedPath}', '${escapeHtml(f.name)}')">再生</button> `;
            html += `<a class="btn btn-secondary btn-sm" href="/recordings/${encodedPath}?download=1">ダウンロード</a>`;
            html += `</td></tr>`;
        });
        html += `</tbody></table>`;
        // Mobile card layout
        html += `<div class="recordings-file-card">`;
        s.files.forEach(f => {
            const encodedPath = encodeURIComponent(f.path).replace(/%2F/g, '/');
            html += `<div class="recordings-file-card-item">`;
            html += `<div class="recordings-file-card-name">${escapeHtml(f.name)}</div>`;
            html += `<div class="recordings-file-card-meta">${formatFileSize(f.size)} / ${escapeHtml(f.mtime)}</div>`;
            html += `<div class="recordings-file-card-actions">`;
            html += `<button class="btn btn-primary btn-sm" onclick="playRecording('${encodedPath}', '${escapeHtml(f.name)}')">再生</button>`;
            html += `<a class="btn btn-secondary btn-sm" href="/recordings/${encodedPath}?download=1">ダウンロード</a>`;
            html += `</div></div>`;
        });
        html += `</div>`;
        html += `</div></div>`;
    });

    container.innerHTML = html;
}

function toggleSeries(idx) {
    const files = document.getElementById('series-files-' + idx);
    const arrow = document.getElementById('series-arrow-' + idx);
    if (!files) return;
    if (files.style.display === 'none') {
        files.style.display = '';
        arrow.innerHTML = '&#9660;';
    } else {
        files.style.display = 'none';
        arrow.innerHTML = '&#9654;';
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

function playRecording(path, name) {
    const modal = document.getElementById('video-modal');
    const title = document.getElementById('video-modal-title');
    title.textContent = name || '再生';

    closeRecordingPlayer();

    if (typeof mpegts !== 'undefined' && mpegts.isSupported()) {
        recordingPath = decodeURIComponent(path);
        recordingBaseTime = 0;
        recordingDuration = 0;

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
                    document.getElementById('video-seek-container').style.display = '';
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

    let url = `/recordings/transcode?path=${encodeURIComponent(recordingPath)}&quality=${streamQuality}`;
    if (seekTime > 0) url += `&ss=${seekTime}`;

    recordingPlayer = mpegts.createPlayer({
        type: 'mpegts',
        isLive: true,
        url: url,
    }, {
        enableWorker: false,
        liveBufferLatencyChasing: false,
    });
    recordingPlayer.attachMediaElement(videoEl);
    recordingPlayer.load();
    videoEl.play().catch(() => {});

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
    if (seekUpdateTimer) {
        clearInterval(seekUpdateTimer);
        seekUpdateTimer = null;
    }
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
    seekBarDragging = false;
    document.getElementById('video-seek-container').style.display = 'none';
}

/* --- ライブ視聴機能 --- */

let liveCurrentCh = null;  // 現在視聴中のチャンネル番号

/* --- NX-Jikkyo 実況コメント --- */

const JIKKYO_MAP = {
    'NHK総合': 'jk1', 'NHK-Eテレ': 'jk2', '日テレ': 'jk4',
    'テレビ朝日': 'jk5', 'TBS': 'jk6', 'テレビ東京': 'jk7',
    'フジテレビ': 'jk8', 'TOKYO MX': 'jk9',
};

const jikkyo = (() => {
    const JIKKYO_BASE = 'nx-jikkyo.tsukumijima.net';
    const MAX_OVERLAY = 50;
    const MAX_SIDEBAR = 200;
    const LANE_COUNT = 12;
    const COMMENT_DURATION = 6000; // ms
    const KEEPSEAT_INTERVAL = 30000; // ms
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
        const now = Date.now();
        for (let i = 0; i < LANE_COUNT; i++) {
            if (lanes[i] <= now) {
                lanes[i] = now + COMMENT_DURATION;
                return i;
            }
        }
        // All lanes busy — pick the one that frees soonest
        let minIdx = 0;
        for (let i = 1; i < LANE_COUNT; i++) {
            if (lanes[i] < lanes[minIdx]) minIdx = i;
        }
        lanes[minIdx] = Date.now() + COMMENT_DURATION;
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
        span.style.animation = `jikkyo-flow ${COMMENT_DURATION}ms linear forwards`;

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
        container.appendChild(div);

        // Trim old messages
        while (container.children.length > MAX_SIDEBAR) {
            container.removeChild(container.firstChild);
        }

        // Auto-scroll to bottom
        container.scrollTop = container.scrollHeight;
    }

    function _onComment(text) {
        const lane = _assignLane();

        // Always track for Canvas PiP regardless of mode
        activeComments.push({
            text,
            lane,
            startTime: Date.now(),
            textWidth: 0,
        });
        activeComments = activeComments.filter(c => Date.now() - c.startTime < COMMENT_DURATION);

        if (mode === 'off') return;
        if (mode === 'overlay') {
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
            overlay.style.display = (mode === 'overlay') ? '' : 'none';
        }
        if (sidebar) {
            sidebar.style.display = (mode === 'sidebar') ? '' : 'none';
        }
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
            activeComments = activeComments.filter(c => Date.now() - c.startTime < COMMENT_DURATION);
            return activeComments;
        },

        initUI() {
            _updateUI();
        },
    };
})();

/* --- Canvas PiP (実況コメント付き Picture-in-Picture) --- */

const jikkyoPip = (() => {
    const COMMENT_DURATION = 6000;
    const FONT_SIZE = 28;
    const LANE_COUNT = 12;

    const CANVAS_W = 960;
    const CANVAS_H = 540;

    let canvas = null;
    let ctx = null;
    let pipVideo = null;       // PiP 用 (Canvas captureStream を受ける)
    let animFrameId = null;
    let isRendering = false;

    function _setup() {
        if (canvas) return;

        const srcVideo = document.getElementById('live-video');
        const wrapper = document.querySelector('.live-video-wrapper');
        if (!srcVideo || !wrapper) return;

        // Canvas: 非表示コンポジタ (映像+コメント合成用、DOM 内に配置して captureStream を有効化)
        canvas = document.createElement('canvas');
        canvas.width = CANVAS_W;
        canvas.height = CANVAS_H;
        canvas.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;pointer-events:none';
        document.body.appendChild(canvas);
        ctx = canvas.getContext('2d');

        // live-video を非表示にする (音声ソース + Canvas の映像ソースとして維持)
        // iOS の自動 PiP を確実に抑止
        srcVideo.disablePictureInPicture = true;
        if (srcVideo.autoPictureInPicture !== undefined) srcVideo.autoPictureInPicture = false;
        srcVideo.style.display = 'none';

        // DOM オーバーレイは Canvas 描画に統合されるため非表示
        const overlay = document.getElementById('jikkyo-overlay');
        if (overlay) overlay.style.display = 'none';

        // pipVideo: メイン映像表示 + PiP ソース
        // live-video の代わりにフルサイズ表示。iOS ネイティブ PiP もこの video を対象にする
        pipVideo = document.createElement('video');
        pipVideo.id = 'live-canvas';
        pipVideo.muted = true;
        pipVideo.playsInline = true;
        pipVideo.autoplay = true;
        wrapper.insertBefore(pipVideo, wrapper.firstChild);

        // Canvas captureStream → pipVideo
        pipVideo.srcObject = canvas.captureStream(30);
        pipVideo.play().catch(() => {});
    }

    function _renderFrame() {
        if (!isRendering) return;
        const srcVideo = document.getElementById('live-video');

        if (!srcVideo || srcVideo.readyState < 2) {
            animFrameId = requestAnimationFrame(_renderFrame);
            return;
        }

        // 映像フレーム描画 (drawImage が表示アスペクト比を補正)
        ctx.drawImage(srcVideo, 0, 0, CANVAS_W, CANVAS_H);

        // コメント描画
        const comments = jikkyo.getActiveComments();
        if (comments.length > 0) {
            const now = Date.now();
            const lineHeight = CANVAS_H / LANE_COUNT;
            ctx.font = `bold ${FONT_SIZE}px "Noto Sans JP", sans-serif`;
            ctx.textBaseline = 'top';

            for (let i = 0; i < comments.length; i++) {
                const c = comments[i];
                const elapsed = now - c.startTime;
                if (elapsed > COMMENT_DURATION) continue;
                const progress = elapsed / COMMENT_DURATION;

                if (!c.textWidth) c.textWidth = ctx.measureText(c.text).width;

                const x = CANVAS_W - (CANVAS_W + c.textWidth) * progress;
                const y = c.lane * lineHeight;

                ctx.strokeStyle = '#000';
                ctx.lineWidth = 3;
                ctx.lineJoin = 'round';
                ctx.strokeText(c.text, x, y);
                ctx.fillStyle = '#fff';
                ctx.fillText(c.text, x, y);
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
        // startLive() から呼ばれる: Canvas 表示 + 描画ループ開始
        warmUp() {
            _setup();
            _startRenderLoop();
        },

        async toggle() {
            if (!pipVideo) return;

            if (document.pictureInPictureElement) {
                document.exitPictureInPicture().catch(() => {});
                return;
            }

            try {
                if (pipVideo.paused) pipVideo.play().catch(() => {});

                await pipVideo.requestPictureInPicture();

                const btn = document.getElementById('pip-btn');
                if (btn) btn.classList.add('active');

                pipVideo.addEventListener('leavepictureinpicture', () => {
                    const b = document.getElementById('pip-btn');
                    if (b) b.classList.remove('active');
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

            // pipVideo 除去
            if (pipVideo) {
                pipVideo.pause();
                pipVideo.srcObject = null;
                if (pipVideo.parentNode) pipVideo.parentNode.removeChild(pipVideo);
                pipVideo = null;
            }

            // Canvas 除去 + live-video を復元
            if (canvas) {
                if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
                canvas = null;
                ctx = null;
            }
            const srcVideo = document.getElementById('live-video');
            if (srcVideo) srcVideo.style.display = '';
            const overlay = document.getElementById('jikkyo-overlay');
            if (overlay) overlay.style.display = '';
        },

        isSupported() {
            return 'pictureInPictureEnabled' in document && document.pictureInPictureEnabled;
        },
    };
})();

function initLiveSection() {
    loadLiveChannelGrid();
}

async function loadLiveChannelGrid() {
    const grid = document.getElementById('live-channel-grid');
    if (!grid || channels.length === 0) return;

    let nowPlaying = {};
    try {
        const data = await API.get('/api/live/now-all');
        nowPlaying = data.now_playing || {};
    } catch { /* EPGデータなしでも続行 */ }

    const now = new Date();
    let html = '';
    channels.forEach(ch => {
        const prog = nowPlaying[ch.name];
        const isPlaying = liveCurrentCh === ch.number;
        html += `<div class="live-ch-card${isPlaying ? ' playing' : ''}" onclick="startLive('${escapeHtml(ch.number)}', '${escapeHtml(ch.name)}')">`;
        html += `<div class="live-ch-name">${escapeHtml(ch.name)}</div>`;
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

function startLive(chNum, chName) {
    if (typeof mpegts === 'undefined' || !mpegts.isSupported()) {
        document.getElementById('live-error').textContent =
            'このブラウザは mpegts.js に対応していません。Chrome または Edge をお使いください。';
        return;
    }

    // 既に同じチャンネルを視聴中なら何もしない
    if (liveCurrentCh === chNum && livePlayer) return;

    // 既に別チャンネル再生中なら停止
    if (livePlayer) stopLive(true);

    liveCurrentCh = chNum;

    // UI 更新
    document.getElementById('live-error').textContent = '';
    document.getElementById('live-stream-info').textContent = '';
    document.getElementById('live-player-title').textContent = chName;
    document.getElementById('live-player-area').style.display = '';
    document.getElementById('live-status').innerHTML =
        '<span class="live-indicator"></span> 接続中...';

    // カードのハイライト更新
    document.querySelectorAll('.live-ch-card').forEach(c => c.classList.remove('playing'));
    document.querySelectorAll('.live-ch-card').forEach(c => {
        if (c.onclick && c.onclick.toString().includes(`'${chNum}'`)) c.classList.add('playing');
    });
    // より確実なハイライト: grid 再描画で反映
    loadLiveChannelGrid();

    const videoEl = document.getElementById('live-video');

    livePlayer = mpegts.createPlayer({
        type: 'mpegts',
        isLive: true,
        url: `/live/stream?ch=${chNum}&quality=${streamQuality}`,
    }, {
        enableWorker: false,
        liveBufferLatencyChasing: true,
        liveBufferLatencyMaxLatency: 5.0,
        liveBufferLatencyMinRemain: 1.0,
    });

    livePlayer.attachMediaElement(videoEl);

    livePlayer.on(mpegts.Events.MEDIA_INFO, (info) => {
        document.getElementById('live-status').innerHTML =
            '<span class="live-indicator"></span> 再生中';
        let infoText = '';
        if (info.videoCodec) infoText += `映像: ${info.videoCodec}`;
        if (info.width && info.height) infoText += ` ${info.width}x${info.height}`;
        if (info.audioCodec) infoText += ` / 音声: ${info.audioCodec}`;
        document.getElementById('live-stream-info').textContent = infoText;
    });

    livePlayer.on(mpegts.Events.ERROR, (type, detail) => {
        document.getElementById('live-error').textContent =
            `再生エラー: ${detail || type}`;
    });

    livePlayer.load();
    videoEl.play().catch(() => {
        document.getElementById('live-status').innerHTML =
            '<span class="live-indicator"></span> 再生ボタンを押してください';
    });

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
}

function stopLive(keepGrid) {
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

    // UI リセット
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
    const d = new Date();
    const now = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
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
            `<p style="color:var(--danger)">データの読み込みに失敗しました: ${escapeHtml(err.message)}</p>`;
    }
}

document.addEventListener('DOMContentLoaded', init);
