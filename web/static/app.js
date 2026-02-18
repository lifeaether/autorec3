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

async function loadEPG() {
    const date = document.getElementById('epg-date').value || todayStr();
    const channel = document.getElementById('epg-channel').value;

    let url = `/api/programmes?date=${date}&limit=500`;
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

    // チャンネルごとにグループ化
    const byChannel = {};
    const channelOrder = [];
    programmes.forEach(p => {
        if (!byChannel[p.channel]) {
            byChannel[p.channel] = [];
            channelOrder.push(p.channel);
        }
        byChannel[p.channel].push(p);
    });

    // テーブル生成
    let html = '<table><thead><tr><th>時間</th>';
    channelOrder.forEach(ch => {
        html += `<th>${escapeHtml(ch)}</th>`;
    });
    html += '</tr></thead><tbody>';

    // 時間帯スロットを生成 (30分刻み)
    const slots = [];
    for (let h = 4; h < 28; h++) {
        const hh = h % 24;
        slots.push(`${String(hh).padStart(2, '0')}:00`);
        slots.push(`${String(hh).padStart(2, '0')}:30`);
    }

    slots.forEach(slot => {
        html += `<tr><td class="time">${slot}</td>`;
        channelOrder.forEach(ch => {
            const progs = byChannel[ch] || [];
            const matching = progs.filter(p => {
                const t = formatTime(p.start_time);
                const slotMin = parseInt(slot.split(':')[0]) * 60 + parseInt(slot.split(':')[1]);
                const progMin = parseInt(t.split(':')[0]) * 60 + parseInt(t.split(':')[1]);
                return progMin >= slotMin && progMin < slotMin + 30;
            });
            if (matching.length > 0) {
                const p = matching[0];
                html += `<td class="epg-cell" onclick="showProgrammeDetail(this, ${escapeHtml(JSON.stringify(JSON.stringify(p)))})" title="${escapeHtml(p.title)}">`;
                html += `<span class="time">${formatTime(p.start_time)}</span> `;
                html += `<span class="title">${escapeHtml(p.title)}</span>`;
                html += '</td>';
            } else {
                html += '<td></td>';
            }
        });
        html += '</tr>';
    });

    html += '</tbody></table>';
    container.innerHTML = html;
}

/* 番組詳細表示 */
function showProgrammeDetail(el, jsonStr) {
    const p = JSON.parse(jsonStr);
    const detail = document.getElementById('programme-detail');
    detail.innerHTML = `
        <h4>${escapeHtml(p.title)}</h4>
        <div class="meta">
            ${escapeHtml(p.channel)} | ${formatDateTime(p.start_time)} - ${formatTime(p.end_time)}
            ${p.category ? ' | ' + escapeHtml(p.category) : ''}
        </div>
        <div class="desc">${escapeHtml(p.description || '詳細情報なし')}</div>
        <div style="margin-top:0.5rem">
            <button class="btn btn-primary btn-sm" onclick="quickAddRule('${escapeHtml(p.title)}', '${escapeHtml(p.channel)}')">
                このキーワードでルール作成
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

/* --- 録画ルール --- */

async function loadRules() {
    const data = await API.get('/api/rules');
    const tbody = document.getElementById('rules-table');
    if (!data.rules || data.rules.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-muted)">ルールなし</td></tr>';
        return;
    }
    tbody.innerHTML = data.rules.map(r => `
        <tr>
            <td>${r.id}</td>
            <td>${escapeHtml(r.name)}</td>
            <td>${escapeHtml(r.keyword || '*')}</td>
            <td>${escapeHtml(r.channel || '全ch')}</td>
            <td>${escapeHtml(r.category || '-')}</td>
            <td>${r.time_from || ''} - ${r.time_to || ''}</td>
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
    document.getElementById('rule-modal-title').textContent = rule ? 'ルール編集' : 'ルール追加';
    form.dataset.ruleId = rule ? rule.id : '';

    form.elements['rule-name'].value = rule ? rule.name : '';
    form.elements['rule-keyword'].value = rule ? (rule.keyword || '') : '';
    form.elements['rule-channel'].value = rule ? (rule.channel || '') : '';
    form.elements['rule-category'].value = rule ? (rule.category || '') : '';
    form.elements['rule-time-from'].value = rule ? (rule.time_from || '') : '';
    form.elements['rule-time-to'].value = rule ? (rule.time_to || '') : '';
    form.elements['rule-weekdays'].value = rule ? (rule.weekdays || '') : '';
    form.elements['rule-priority'].value = rule ? (rule.priority || 0) : 0;
    form.elements['rule-enabled'].checked = rule ? !!rule.enabled : true;

    overlay.classList.add('active');
}

async function editRule(id) {
    const data = await API.get('/api/rules');
    const rule = data.rules.find(r => r.id === id);
    if (rule) showRuleForm(rule);
}

async function deleteRule(id, name) {
    if (!confirm(`ルール「${name}」を削除しますか?`)) return;
    await API.del(`/api/rules/${id}`);
    loadRules();
}

async function saveRule() {
    const form = document.getElementById('rule-form');
    const ruleId = form.dataset.ruleId;
    const data = {
        name: form.elements['rule-name'].value,
        keyword: form.elements['rule-keyword'].value || null,
        channel: form.elements['rule-channel'].value || null,
        category: form.elements['rule-category'].value || null,
        time_from: form.elements['rule-time-from'].value || null,
        time_to: form.elements['rule-time-to'].value || null,
        weekdays: form.elements['rule-weekdays'].value || null,
        priority: parseInt(form.elements['rule-priority'].value) || 0,
        enabled: form.elements['rule-enabled'].checked ? 1 : 0,
    };

    if (!data.name) {
        alert('ルール名を入力してください');
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

function quickAddRule(title, channel) {
    document.getElementById('programme-detail').classList.remove('active');
    switchSection('rules');
    showRuleForm(null);
    document.getElementById('rule-form').elements['rule-name'].value = title;
    document.getElementById('rule-form').elements['rule-keyword'].value = title;
    document.getElementById('rule-form').elements['rule-channel'].value = channel;
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
    // チャンネル一覧取得
    const chData = await API.get('/api/channels');
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

    // 日付を今日に設定
    const epgDate = document.getElementById('epg-date');
    if (epgDate && !epgDate.value) {
        epgDate.value = todayStr();
    }

    // ナビゲーションイベント
    document.querySelectorAll('nav a[data-section]').forEach(a => {
        a.addEventListener('click', (e) => {
            e.preventDefault();
            switchSection(a.dataset.section);
        });
    });

    // 初期セクション表示
    switchSection('epg');
}

document.addEventListener('DOMContentLoaded', init);
