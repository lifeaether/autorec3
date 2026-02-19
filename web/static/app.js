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

/* --- ナビゲーション --- */

let channels = [];
let categories = [];

function switchSection(name) {
    // セクション切替時、ライブ視聴中なら停止
    if (name !== 'live' && livePlayer) stopLive();

    document.querySelectorAll('.section').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('nav a[data-section]').forEach(el => el.classList.remove('active'));
    const section = document.getElementById('section-' + name);
    const link = document.querySelector(`nav a[data-section="${name}"]`);
    if (section) section.classList.add('active');
    if (link) link.classList.add('active');

    if (name === 'epg') loadEPG();
    else if (name === 'rules') loadRules();
    else if (name === 'schedules') loadSchedules();
    else if (name === 'recordings') loadRecordings();
    else if (name === 'live') initLiveSection();
    else if (name === 'logs') loadLogs();
}

/* --- 番組表 (メイン) --- */

// 番組データをグローバルに保持 (onclick軽量化)
window._programmes = [];

async function loadEPG() {
    const category = document.getElementById('epg-category').value;
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

function renderEPGTable(programmes) {
    const container = document.getElementById('epg-table');
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
    const channelOrder = [];
    parsed.forEach(p => {
        if (!byChannel[p.channel]) {
            byChannel[p.channel] = [];
            channelOrder.push(p.channel);
        }
        byChannel[p.channel].push(p);
    });

    // グリッド時間範囲を計算
    const now = new Date();
    let gridStart = new Date(now); gridStart.setMinutes(0, 0, 0);
    let gridEnd = new Date(now); gridEnd.setHours(gridEnd.getHours() + 6, 0, 0, 0);

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

    // 時刻軸
    let html = '<div class="epg-grid">';
    html += '<div class="epg-time-axis">';
    html += `<div class="epg-time-axis-header">${dateLabelOf(gridStart)}</div>`;
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

    // チャンネル列
    channelOrder.forEach(ch => {
        html += '<div class="epg-channel">';
        html += `<div class="epg-channel-header">${escapeHtml(ch)}</div>`;
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

    html += '</div>';
    container.innerHTML = html;

    // 現在時刻線 & 自動スクロール
    const grid = container.querySelector('.epg-grid');
    const updateNowLine = () => {
        const n = new Date();
        const px = timeToPx(n);
        // 範囲外なら非表示
        grid.querySelectorAll('.epg-now-line').forEach(el => el.remove());
        if (px < 0 || px > totalPx) return;

        // 各チャンネル列 + 時刻軸にライン追加
        grid.querySelectorAll('.epg-channel-body, .epg-time-axis-body').forEach(body => {
            const line = document.createElement('div');
            line.className = 'epg-now-line';
            line.style.top = px + 'px';
            body.appendChild(line);
        });
    };
    updateNowLine();

    // 現在位置へ自動スクロール
    const nowPx = timeToPx(now);
    if (nowPx > 0 && nowPx < totalPx) {
        // ヘッダー分のオフセットを考慮して、現在時刻が上寄りに見えるように
        grid.scrollTop = Math.max(0, nowPx - 60);
    }

    // 60秒ごとに現在時刻線を更新
    _epgNowTimer = setInterval(updateNowLine, 60000);
}

/* 番組詳細表示 */
function showProgrammeDetail(el, idx) {
    const p = window._programmes[idx];
    const detail = document.getElementById('programme-detail');
    detail.innerHTML = `
        <h4>${escapeHtml(p.title)}</h4>
        <div class="meta">
            ${escapeHtml(p.channel)} | ${formatDateTime(p.start_time)} - ${formatTime(p.end_time)}
            ${p.category ? ' | ' + escapeHtml(p.category) : ''}
        </div>
        <div class="desc">${escapeHtml(p.description || '')}</div>
        <div style="margin-top:0.5rem;display:flex;gap:0.5rem;flex-wrap:wrap">
            <button class="btn btn-primary btn-sm" onclick="directSchedule(${idx})">
                この番組を録画する
            </button>
            <button class="btn btn-secondary btn-sm" onclick="quickAddRule('${escapeHtml(p.title)}')">
                このキーワードで予約作成
            </button>
        </div>
    `;
    const rect = el.getBoundingClientRect();
    detail.style.top = Math.min(rect.bottom + 5, window.innerHeight - 300) + 'px';
    detail.style.left = Math.min(rect.left, window.innerWidth - 420) + 'px';
    detail.classList.add('active');
}

document.addEventListener('click', (e) => {
    if (!e.target.closest('.epg-cell') && !e.target.closest('.programme-detail')) {
        document.getElementById('programme-detail').classList.remove('active');
    }
});

/* --- 録画予約 --- */

async function loadRules() {
    const tbody = document.getElementById('rules-table');
    try {
        const data = await API.get('/api/rules');
        if (!data.rules || data.rules.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">予約なし</td></tr>';
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
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--danger)">読み込みに失敗しました: ${escapeHtml(err.message)}</td></tr>`;
    }
}

function showRuleForm(rule) {
    const overlay = document.getElementById('rule-modal');
    const form = document.getElementById('rule-form');
    document.getElementById('rule-modal-title').textContent = rule ? 'キーワード予約 編集' : 'キーワード予約';
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
    if (!confirm(`予約「${name}」を削除しますか?`)) return;
    try {
        await API.del(`/api/rules/${id}`);
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
        alert('予約名を入力してください');
        return;
    }

    try {
        if (ruleId) {
            await API.put(`/api/rules/${ruleId}`, data);
        } else {
            await API.post('/api/rules', data);
        }
        document.getElementById('rule-modal').classList.remove('active');
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
    if (!confirm(`「${p.title}」を録画予定に追加しますか？`)) return;
    try {
        await API.post('/api/schedules', {
            event_id: p.event_id, channel: p.channel,
            title: p.title, start_time: p.start_time, end_time: p.end_time,
        });
        alert('録画予定に追加しました');
        document.getElementById('programme-detail').classList.remove('active');
    } catch (err) {
        alert(err.message);
    }
}

/* --- 録画スケジュール --- */

async function loadSchedules() {
    const status = document.getElementById('schedule-status').value;
    let url = '/api/schedules?limit=200';
    if (status) url += `&status=${status}`;

    const tbody = document.getElementById('schedules-table');
    try {
        const data = await API.get(url);
        if (!data.schedules || data.schedules.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted)">スケジュールなし</td></tr>';
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
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--danger)">読み込みに失敗しました: ${escapeHtml(err.message)}</td></tr>`;
    }
}

/* --- ログ --- */

async function loadLogs() {
    const level = document.getElementById('log-level').value;
    let url = '/api/logs?limit=200';
    if (level) url += `&level=${level}`;

    const tbody = document.getElementById('logs-table');
    try {
        const data = await API.get(url);
        if (!data.logs || data.logs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">ログなし</td></tr>';
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
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--danger)">読み込みに失敗しました: ${escapeHtml(err.message)}</td></tr>`;
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
            html += `<a class="btn btn-secondary btn-sm" href="/recordings/${encodedPath}?download=1" style="text-decoration:none;display:inline-block">DL</a>`;
            html += `</td></tr>`;
        });
        html += `</tbody></table></div></div>`;
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

    let url = `/recordings/transcode?path=${encodeURIComponent(recordingPath)}`;
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

function initLiveSection() {
    const select = document.getElementById('live-channel');
    if (select && select.options.length <= 1 && channels.length > 0) {
        channels.forEach(ch => {
            const opt = document.createElement('option');
            opt.value = ch.number;
            opt.textContent = ch.name;
            select.appendChild(opt);
        });
    }
}

function startLive() {
    const select = document.getElementById('live-channel');
    const ch = select.value;
    if (!ch) {
        alert('チャンネルを選択してください');
        return;
    }

    if (typeof mpegts === 'undefined' || !mpegts.isSupported()) {
        document.getElementById('live-error').textContent =
            'このブラウザは mpegts.js に対応していません。Chrome または Edge をお使いください。';
        return;
    }

    // UI 更新
    document.getElementById('live-error').textContent = '';
    document.getElementById('live-stream-info').textContent = '';
    document.getElementById('live-start-btn').style.display = 'none';
    document.getElementById('live-stop-btn').style.display = '';
    select.disabled = true;
    document.getElementById('live-status').innerHTML =
        '<span class="live-indicator"></span> 接続中...';

    const videoEl = document.getElementById('live-video');

    livePlayer = mpegts.createPlayer({
        type: 'mpegts',
        isLive: true,
        url: `/live/stream?ch=${ch}`,
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

    livePlayer.on(mpegts.Events.ERROR, (type, detail, info) => {
        document.getElementById('live-error').textContent =
            `再生エラー: ${detail || type}`;
    });

    livePlayer.load();
    videoEl.play().catch(() => {
        document.getElementById('live-status').innerHTML =
            '<span class="live-indicator"></span> 再生ボタンを押してください';
    });

    // 番組情報を取得 (チャンネル名で検索)
    const chName = select.options[select.selectedIndex].textContent;
    loadLiveNowPlaying(chName);
    liveNowTimer = setInterval(() => loadLiveNowPlaying(chName), 60000);
}

function stopLive() {
    if (livePlayer) {
        livePlayer.destroy();
        livePlayer = null;
    }
    if (liveNowTimer) {
        clearInterval(liveNowTimer);
        liveNowTimer = null;
    }

    // UI リセット
    document.getElementById('live-start-btn').style.display = '';
    document.getElementById('live-stop-btn').style.display = 'none';
    document.getElementById('live-channel').disabled = false;
    document.getElementById('live-status').textContent = '';
    document.getElementById('live-stream-info').textContent = '';
    document.getElementById('live-error').textContent = '';
    document.getElementById('live-now-playing').style.display = 'none';
    document.getElementById('live-now-info').textContent = '';
}

async function loadLiveNowPlaying(channelName) {
    try {
        const data = await API.get(`/api/live/now?channel=${encodeURIComponent(channelName)}`);
        const container = document.getElementById('live-now-playing');
        const info = document.getElementById('live-now-info');
        if (data.now_playing) {
            const p = data.now_playing;
            info.innerHTML = `
                <strong>${escapeHtml(p.title)}</strong><br>
                <span style="color:var(--text-muted);font-size:0.85rem">
                    ${formatTime(p.start_time)} - ${formatTime(p.end_time)}
                    ${p.category ? ' | ' + escapeHtml(p.category) : ''}
                </span>
            `;
            container.style.display = '';
        } else {
            container.style.display = 'none';
        }
    } catch {
        // 番組情報取得失敗は無視
    }
}

/* --- 初期化 --- */

async function init() {
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

    // キーワード予約プレビュー: debounce 付き input イベント
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

    // 初期セクション表示 (hash があればそのセクションを開く)
    const initialSection = location.hash.replace('#', '') || 'epg';
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
        const catSelect = document.getElementById('epg-category');
        if (catSelect) {
            let catOpts = '<option value="">全ジャンル</option>';
            categories.forEach(cat => {
                catOpts += `<option value="${escapeHtml(cat)}">${escapeHtml(cat)}</option>`;
            });
            catSelect.innerHTML = catOpts;
        }

        renderEPGTable(epgData.programmes);
    } catch (err) {
        document.getElementById('epg-table').innerHTML =
            `<p style="color:var(--danger)">データの読み込みに失敗しました: ${escapeHtml(err.message)}</p>`;
    }
}

document.addEventListener('DOMContentLoaded', init);
