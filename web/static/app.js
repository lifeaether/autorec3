/* autorec Web UI - メインアプリケーション */

const API = {
    async get(path) {
        const res = await fetch(path);
        return res.json();
    },
    async post(path, data) {
        const res = await fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
        return res.json();
    },
    async put(path, data) {
        const res = await fetch(path, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
        return res.json();
    },
    async del(path) {
        const res = await fetch(path, { method: 'DELETE' });
        return res.json();
    },
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

/* --- ナビゲーション --- */

let channels = [];

function switchSection(name) {
    document.querySelectorAll('.section').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('nav a[data-section]').forEach(el => el.classList.remove('active'));
    const section = document.getElementById('section-' + name);
    const link = document.querySelector(`nav a[data-section="${name}"]`);
    if (section) section.classList.add('active');
    if (link) link.classList.add('active');

    if (name === 'epg') loadEPG();
    else if (name === 'rules') loadRules();
    else if (name === 'schedules') loadSchedules();
    else if (name === 'logs') loadLogs();
}

/* --- 番組表 (メイン) --- */

// 番組データをグローバルに保持 (onclick軽量化)
window._programmes = [];

async function loadEPG() {
    const date = document.getElementById('epg-date').value || todayStr();
    const channel = document.getElementById('epg-channel').value;

    let url = `/api/programmes?date=${date}&limit=1000`;
    if (channel) url += `&channel=${encodeURIComponent(channel)}`;

    const data = await API.get(url);
    renderEPGTable(data.programmes, date);
}

function renderEPGTable(programmes, date) {
    const container = document.getElementById('epg-table');
    if (!programmes || programmes.length === 0) {
        container.innerHTML = '<p style="color:var(--text-muted)">番組データがありません</p>';
        return;
    }

    // 番組データをグローバル配列に格納
    window._programmes = programmes;

    // チャンネルごとにグループ化 (インデックスも記録)
    const byChannel = {};
    const channelOrder = [];
    programmes.forEach((p, idx) => {
        if (!byChannel[p.channel]) {
            byChannel[p.channel] = [];
            channelOrder.push(p.channel);
        }
        byChannel[p.channel].push({ prog: p, idx });
    });

    // renderChannelTable: ch が空文字なら全チャンネル表示
    const renderChannelTable = (ch, items) => {
        let t = `<table><thead><tr><th style="width:6em">開始</th><th style="width:6em">終了</th>`;
        if (!ch) t += `<th style="width:8em">チャンネル</th>`;
        t += `<th>番組名</th></tr></thead><tbody>`;
        items.forEach(item => {
            const p = item.prog;
            t += `<tr class="epg-cell" onclick="showProgrammeDetail(this, ${item.idx})">`;
            t += `<td class="time">${formatTime(p.start_time)}</td>`;
            t += `<td class="time">${formatTime(p.end_time)}</td>`;
            if (!ch) t += `<td>${escapeHtml(p.channel)}</td>`;
            t += `<td class="title">${escapeHtml(p.title)}</td>`;
            t += '</tr>';
        });
        t += '</tbody></table>';
        return t;
    };

    // タブ生成
    let html = '<div class="epg-tabs">';
    html += '<button class="epg-tab active" data-ch="">全チャンネル</button>';
    channelOrder.forEach(ch => {
        html += `<button class="epg-tab" data-ch="${escapeHtml(ch)}">${escapeHtml(ch)}</button>`;
    });
    html += '</div>';

    // 全チャンネルタブ (時間順) — 初回のみ描画
    const allItems = programmes.map((prog, idx) => ({ prog, idx }));
    html += '<div class="epg-tab-content active" data-ch="">';
    html += renderChannelTable('', allItems);
    html += '</div>';

    // 個別チャンネルタブ — プレースホルダのみ (遅延レンダリング)
    channelOrder.forEach(ch => {
        html += `<div class="epg-tab-content" data-ch="${escapeHtml(ch)}"></div>`;
    });

    container.innerHTML = html;

    // byChannel をコンテナに保持 (遅延レンダリング用)
    container._byChannel = byChannel;
    container._renderChannelTable = renderChannelTable;

    // タブ切り替えイベント
    container.querySelectorAll('.epg-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            container.querySelectorAll('.epg-tab').forEach(t => t.classList.remove('active'));
            container.querySelectorAll('.epg-tab-content').forEach(c => c.classList.remove('active'));
            tab.classList.add('active');
            const ch = tab.dataset.ch;
            const content = container.querySelector(`.epg-tab-content[data-ch="${ch}"]`);
            // 遅延レンダリング: 未描画なら描画
            if (ch && content && !content.innerHTML) {
                content.innerHTML = container._renderChannelTable(ch, container._byChannel[ch]);
            }
            content.classList.add('active');
        });
    });
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
    const data = await API.get('/api/rules');
    const tbody = document.getElementById('rules-table');
    if (!data.rules || data.rules.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">予約なし</td></tr>';
        return;
    }
    tbody.innerHTML = data.rules.map(r => `
        <tr>
            <td>${r.id}</td>
            <td>${escapeHtml(r.name)}</td>
            <td>${escapeHtml(r.keyword || '*')}</td>
            <td>${r.enabled ? '<span class="badge badge-enabled">有効</span>' : '<span class="badge badge-disabled">無効</span>'}</td>
            <td>
                <button class="btn btn-secondary btn-sm" onclick="editRule(${r.id})">編集</button>
                <button class="btn btn-danger btn-sm" onclick="deleteRule(${r.id}, '${escapeHtml(r.name)}')">削除</button>
            </td>
        </tr>
    `).join('');
}

function showRuleForm(rule) {
    const overlay = document.getElementById('rule-modal');
    const form = document.getElementById('rule-form');
    document.getElementById('rule-modal-title').textContent = rule ? 'キーワード予約 編集' : 'キーワード予約';
    form.dataset.ruleId = rule ? rule.id : '';

    form.elements['rule-name'].value = rule ? rule.name : '';
    form.elements['rule-keyword'].value = rule ? (rule.keyword || '') : '';
    form.elements['rule-enabled'].checked = rule ? !!rule.enabled : true;

    overlay.classList.add('active');
}

async function editRule(id) {
    const data = await API.get('/api/rules');
    const rule = data.rules.find(r => r.id === id);
    if (rule) showRuleForm(rule);
}

async function deleteRule(id, name) {
    if (!confirm(`予約「${name}」を削除しますか?`)) return;
    await API.del(`/api/rules/${id}`);
    loadRules();
}

async function saveRule() {
    const form = document.getElementById('rule-form');
    const ruleId = form.dataset.ruleId;
    const data = {
        name: form.elements['rule-name'].value,
        keyword: form.elements['rule-keyword'].value || null,
        channel: null,
        category: null,
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

    if (ruleId) {
        await API.put(`/api/rules/${ruleId}`, data);
    } else {
        await API.post('/api/rules', data);
    }

    document.getElementById('rule-modal').classList.remove('active');
    loadRules();
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
    const res = await API.post('/api/schedules', {
        event_id: p.event_id, channel: p.channel,
        title: p.title, start_time: p.start_time, end_time: p.end_time,
    });
    if (res.error) { alert(res.error); return; }
    alert('録画予定に追加しました');
    document.getElementById('programme-detail').classList.remove('active');
}

/* --- 録画スケジュール --- */

async function loadSchedules() {
    const status = document.getElementById('schedule-status').value;
    let url = '/api/schedules?limit=200';
    if (status) url += `&status=${status}`;

    const data = await API.get(url);
    const tbody = document.getElementById('schedules-table');
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
}

/* --- ログ --- */

async function loadLogs() {
    const level = document.getElementById('log-level').value;
    let url = '/api/logs?limit=200';
    if (level) url += `&level=${level}`;

    const data = await API.get(url);
    const tbody = document.getElementById('logs-table');
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
}

/* --- 初期化 --- */

async function init() {
    // 日付を今日に設定 (API呼び出し前に設定)
    const epgDate = document.getElementById('epg-date');
    if (epgDate && !epgDate.value) {
        epgDate.value = todayStr();
    }

    // チャンネル一覧と番組表を並列取得
    const date = epgDate ? epgDate.value : todayStr();
    const [chData, epgData] = await Promise.all([
        API.get('/api/channels'),
        API.get(`/api/programmes?date=${date}&limit=1000`),
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

    // ナビゲーションイベント
    document.querySelectorAll('nav a[data-section]').forEach(a => {
        a.addEventListener('click', (e) => {
            e.preventDefault();
            switchSection(a.dataset.section);
        });
    });

    // 初期セクション表示 (既にデータがあるので直接レンダリング)
    document.querySelectorAll('.section').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('nav a[data-section]').forEach(el => el.classList.remove('active'));
    const section = document.getElementById('section-epg');
    const link = document.querySelector('nav a[data-section="epg"]');
    if (section) section.classList.add('active');
    if (link) link.classList.add('active');
    renderEPGTable(epgData.programmes, date);
}

document.addEventListener('DOMContentLoaded', init);
