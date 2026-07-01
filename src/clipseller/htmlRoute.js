/**
 * Serve o clipseller-canvas-v43.html com patches injetados:
 *   1. Reescreve fetches diretos para APIs externas → /cs-proxy/*.
 *   2. Remove a etapa "Chaves & Config": o standalone usa as mesmas credenciais
 *      do SellerIA Club no servidor. O browser recebe apenas placeholders para
 *      passar nas validações locais do canvas.
 *   3. Conecta a cobrança de créditos ao backend standalone.
 */
import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireAuth, requireClipSellerAccess } from '../auth/middleware.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const HTML_CANDIDATES = [
  resolve(__dirname, '../../public/clipseller-html/index.html'),
  resolve(__dirname, '../../public/clipseller-html/clipseller-canvas-v31.html'),
];
const HTML_PATH = HTML_CANDIDATES.find((p) => existsSync(p)) || HTML_CANDIDATES[0];

const BRIDGE = `
<script>
(function () {
  // O ClipSeller standalone nunca pede chaves ao cliente. Estes placeholders
  // existem só para o HTML legado não bloquear a geração; o proxy troca tudo
  // pelas credenciais reais do servidor.
  var SERVER_KEYS = {
    anthropic: 'sk-ant-server-side',
    fal: 'server-side',
    kie: 'server-side',
    google: 'server-side',
    laozhang: 'server-side',
    lzSora: 'server-side',
    lzImg: 'server-side',
    lzNano: 'server-side',
    fashn: 'server-side',
    proxy: ''
  };
  try {
    if (typeof KEYS !== 'undefined') {
      Object.assign(KEYS, SERVER_KEYS);
      localStorage.removeItem('clipseller_keys');
    }
    if (typeof topdot !== 'undefined' && topdot) topdot.classList.add('on');
  } catch (_) {}

  var CS_PROXY_MAP = [
    ['https://kieai.redpandaai.co/api', '/cs-proxy/kieupload'],
    ['https://api.kie.ai', '/cs-proxy/kie'],
    ['https://api.laozhang.ai', '/cs-proxy/laozhang'],
    ['https://queue.fal.run', '/cs-proxy/falqueue'],
    ['https://fal.run', '/cs-proxy/fal'],
    ['https://rest.alpha.fal.ai', '/cs-proxy/falcdn'],
    ['https://api.fashn.ai', '/cs-proxy/fashn'],
    ['https://generativelanguage.googleapis.com', '/cs-proxy/google'],
    ['https://api.anthropic.com', '/cs-proxy/anthropic'],
    ['https://api.openai.com', '/cs-proxy/openai'],
    ['https://api.replicate.com', '/cs-proxy/replicate'],
    ['https://api.freepik.com', '/cs-proxy/freepik'],
    ['https://api.elevenlabs.io', '/cs-proxy/elevenlabs'],
  ];
  function toCsProxyUrl(u) {
    if (!u || typeof u !== 'string') return u;
    if (u.charAt(0) === '/') return u;
    for (var i = 0; i < CS_PROXY_MAP.length; i++) {
      if (u.indexOf(CS_PROXY_MAP[i][0]) === 0) {
        return CS_PROXY_MAP[i][1] + u.slice(CS_PROXY_MAP[i][0].length);
      }
    }
    return u;
  }
  var _nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    if (typeof input === 'string') return _nativeFetch(toCsProxyUrl(input), init);
    if (input && typeof input.url === 'string') {
      var proxied = toCsProxyUrl(input.url);
      if (proxied !== input.url) return _nativeFetch(proxied, init);
    }
    return _nativeFetch(input, init);
  };

  // ────────────────────────────────────────────────────────────────
  // Cobrança de créditos via backend standalone (/api/credits/charge)
  // ────────────────────────────────────────────────────────────────
  function csToken() {
    try { return (window.parent && window.parent.localStorage && window.parent.localStorage.getItem('cs_token')) || ''; }
    catch (_) { return ''; }
  }

  // Mapeia o featureKey legado do HTML para a tabela standalone (clipseller.novo.*)
  var FEATURE_MAP = {
    'clipseller.outros-3': 'clipseller.novo.img-basico',
    'clipseller.outros-5': 'clipseller.novo.img-basico',
    'clipseller.moda-3':   'clipseller.novo.moda-look',
    'clipseller.moda-5':   'clipseller.novo.moda-look',
    'clipseller.regen':    'clipseller.novo.regen',
    'clipseller.foto-inspirada': 'clipseller.novo.inspirada',
    'clipseller.edicao-livre':   'clipseller.novo.edicao-livre',
    'clipseller.trocar-modelo':  'clipseller.novo.provador',
    'clipseller.video-5s':       'clipseller.novo.vid-prod-5s',
    'clipseller.video-10s':      'clipseller.novo.vid-prod-10s',
    'clipseller.copy':           'clipseller.novo.titulo',
    'clipseller.criativos':      'clipseller.novo.img-basico',
  };
  function mapFeature(key) { return FEATURE_MAP[key] || key || 'clipseller.novo.img-basico'; }

  window.__cs_lastTxId = null;

  window.chargeCreditsBackend = async function (opts) {
    opts = opts || {};
    var featureKey = mapFeature(opts.featureKey || opts.feature);
    var token = csToken();
    if (!token) {
      alert('Sessão expirada. Faça login novamente.');
      try { window.top.location.href = '/'; } catch (_) {}
      return false;
    }
    try {
      var r = await fetch('/api/credits/charge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ featureKey: featureKey, description: opts.description || null }),
      });
      var data = {};
      try { data = await r.json(); } catch (_) {}
      if (r.status === 402) {
        alert('Créditos insuficientes (saldo: ' + (data.balance || 0) + ').\\n\\nCompre mais em "Meus créditos".');
        try { window.top.location.href = '/credits.html'; } catch (_) {}
        return false;
      }
      if (!r.ok) {
        alert(data.error || 'Não foi possível debitar créditos.');
        return false;
      }
      window.__cs_lastTxId = data.transactionId || null;
      if (typeof data.balance === 'number') {
        try { window.credits = data.balance; var c = document.getElementById('credn'); if (c) c.textContent = data.balance.toLocaleString('pt-BR'); } catch (_) {}
        try { window.parent.postMessage({ type: 'cs:balance', balance: data.balance }, '*'); } catch (_) {}
      } else if (data.admin) {
        try { var c = document.getElementById('credn'); if (c) c.textContent = '∞'; } catch (_) {}
      }
      return true;
    } catch (err) {
      console.error('[chargeCreditsBackend]', err);
      alert('Erro de conexão ao debitar créditos.');
      return false;
    }
  };

  window.__cs_refundTicket = async function () {
    var txId = window.__cs_lastTxId;
    if (!txId) return;
    var token = csToken();
    if (!token) return;
    try {
      await fetch('/api/credits/refund', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ transactionId: txId }),
      });
      window.__cs_lastTxId = null;
    } catch (_) {}
  };

  // Atualiza o saldo no header do HTML a cada 20s e no DOMContentLoaded.
  function currentUser() {
    try {
      return JSON.parse((window.parent && window.parent.localStorage && window.parent.localStorage.getItem('cs_user')) || 'null');
    } catch (_) {
      return null;
    }
  }
  async function refreshBalance() {
    var token = csToken();
    if (!token) return;
    var u = currentUser();
    if (u && u.role === 'admin') {
      try { credits = 999999; window.credits = credits; var ac = document.getElementById('credn'); if (ac) ac.textContent = '∞'; } catch (_) {}
      return;
    }
    try {
      var r = await fetch('/api/credits/me', { headers: { Authorization: 'Bearer ' + token } });
      if (!r.ok) return;
      var data = await r.json();
      try { credits = Number(data.balance || 0); } catch (_) {}
      window.credits = data.balance;
      var c = document.getElementById('credn');
      if (c) c.textContent = (data.balance || 0).toLocaleString('pt-BR');
      try { window.parent.postMessage({ type: 'cs:balance', balance: data.balance }, '*'); } catch (_) {}
    } catch (_) {}
  }

  function money(cents) {
    return (Number(cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }
  function fmt(n) { return Number(n || 0).toLocaleString('pt-BR'); }
  async function csApi(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    var token = csToken();
    if (token) opts.headers.Authorization = 'Bearer ' + token;
    var r = await fetch(path, opts);
    var data = {};
    try { data = await r.json(); } catch (_) {}
    return { ok: r.ok, status: r.status, data: data };
  }
  function txHtml(txs) {
    if (!txs || !txs.length) return '<div class="cs-muted">Nenhuma movimentação ainda.</div>';
    return txs.map(function (t) {
      var pos = Number(t.credits || 0) >= 0;
      var date = '';
      try { date = new Date(t.createdAt).toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }); } catch (_) {}
      return '<div class="cs-tx">' +
        '<span>' + date + '</span>' +
        '<b>' + (t.description || t.type || 'Movimentação') + '</b>' +
        '<strong class="' + (pos ? 'pos' : 'neg') + '">' + (pos ? '+' : '') + fmt(t.credits) + ' cr</strong>' +
        '<small>saldo ' + fmt(t.balanceAfter) + '</small>' +
      '</div>';
    }).join('');
  }
  function barRowsHtml(rows) {
    rows = rows || [];
    if (!rows.length) return '<div class="cs-muted">Ainda não há gerações no período.</div>';
    var max = rows.reduce(function (m, r) { return Math.max(m, Number(r.generations || 0)); }, 1);
    return rows.map(function (r) {
      var pct = Math.max(4, Math.round((Number(r.generations || 0) / max) * 100));
      return '<div class="cs-bar-row">' +
        '<div class="cs-bar-label"><b>' + escapeHtml(r.label || r.feature_key || 'Geração') + '</b><small>' + escapeHtml(r.category || '') + '</small></div>' +
        '<div class="cs-bar-track"><span style="width:' + pct + '%"></span></div>' +
        '<strong>' + fmt(r.generations) + '</strong>' +
        '<em>' + fmt(r.credits) + ' cr</em>' +
      '</div>';
    }).join('');
  }
  function dailyBarsHtml(rows) {
    rows = rows || [];
    if (!rows.length) return '<div class="cs-muted">Sem dados diários.</div>';
    var max = rows.reduce(function (m, r) { return Math.max(m, Number(r.generations || 0)); }, 1);
    return rows.map(function (r) {
      var h = Math.max(3, Math.round((Number(r.generations || 0) / max) * 100));
      var label = '';
      try { label = new Date(r.date + 'T00:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }); } catch (_) { label = r.date || ''; }
      return '<div class="cs-day" title="' + escapeHtml(label + ': ' + fmt(r.generations) + ' gerações') + '">' +
        '<span style="height:' + h + '%"></span><small>' + escapeHtml(label) + '</small>' +
      '</div>';
    }).join('');
  }
  function topUsersHtml(rows) {
    rows = rows || [];
    if (!rows.length) return '<div class="cs-muted">Sem ranking de usuários neste período.</div>';
    return rows.map(function (u, idx) {
      return '<div class="cs-top-user"><span>' + (idx + 1) + '</span><b>' + escapeHtml(u.name || u.email || '-') + '</b><small>' + escapeHtml(u.email || '') + '</small><strong>' + fmt(u.generations) + '</strong></div>';
    }).join('');
  }
  async function renderDashboardPanel() {
    var stageEl = document.getElementById('stage');
    var centerEl = document.getElementById('center');
    var stationEl = document.getElementById('station');
    if (stageEl) stageEl.style.display = 'none';
    if (stationEl) stationEl.classList.remove('on');
    if (!centerEl) return;
    centerEl.style.cssText = 'display:block;overflow:auto;padding:42px;background:var(--bg);';
    centerEl.innerHTML = '<div class="cs-dash-panel"><div class="cs-load">Carregando dashboard...</div></div>';
    var shell = centerEl.querySelector('.cs-dash-panel');
    try {
      var out = await csApi('/api/credits/dashboard?days=30');
      if (!out.ok) throw new Error(out.data.error || 'Falha ao carregar dashboard.');
      var data = out.data || {};
      var s = data.summary || {};
      var scope = data.scope === 'global' ? 'Todos os usuários' : 'Seu uso';
      shell.innerHTML =
        '<div class="cs-dash-head"><div><h2>Dashboard ClipSeller</h2><p>' + scope + ' nos últimos ' + fmt(data.days || 30) + ' dias.</p></div><button id="csDashRefresh">Atualizar</button></div>' +
        '<div class="cs-kpis">' +
          '<div><small>Gerações</small><b>' + fmt(s.total_generations) + '</b></div>' +
          '<div><small>Créditos consumidos</small><b>' + fmt(s.credits_consumed) + '</b></div>' +
          '<div><small>Usuários com geração</small><b>' + fmt(s.active_users) + '</b></div>' +
          '<div><small>Média por geração</small><b>' + fmt(Math.round(Number(s.avg_credits || 0))) + ' cr</b></div>' +
        '</div>' +
        '<section class="cs-dash-card"><div class="cs-dash-card-head"><h3>Gerações por tipo</h3><span>Quantidade e créditos</span></div><div class="cs-bars">' + barRowsHtml(data.byFeature || []) + '</div></section>' +
        '<section class="cs-dash-card"><div class="cs-dash-card-head"><h3>Evolução diária</h3><span>Últimos 30 dias</span></div><div class="cs-day-chart">' + dailyBarsHtml(data.daily || []) + '</div></section>' +
        (data.scope === 'global' ? '<section class="cs-dash-card"><div class="cs-dash-card-head"><h3>Top usuários</h3><span>Por volume de gerações</span></div><div class="cs-top-users">' + topUsersHtml(data.topUsers || []) + '</div></section>' : '');
      var refresh = document.getElementById('csDashRefresh');
      if (refresh) refresh.addEventListener('click', renderDashboardPanel);
    } catch (err) {
      shell.innerHTML = '<div class="err">Falha ao carregar dashboard: ' + escapeHtml((err && err.message) || err) + '</div>';
    }
  }
  window.showDashboardPanel = renderDashboardPanel;
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function fmtDate(value) {
    if (!value) return '-';
    try {
      return new Date(value).toLocaleString('pt-BR', {
        day: '2-digit', month: '2-digit', year: '2-digit',
        hour: '2-digit', minute: '2-digit',
      });
    } catch (_) {
      return '-';
    }
  }
  function usersRowsHtml(users) {
    if (!users || !users.length) return '<tr><td colspan="7" class="cs-users-empty">Nenhum usuário encontrado.</td></tr>';
    return users.map(function (u) {
      return '<tr data-user-id="' + escapeHtml(u.id) + '">' +
        '<td><strong>' + escapeHtml(u.name || '-') + '</strong><small>' + escapeHtml(u.email || '') + '</small></td>' +
        '<td><span class="cs-role ' + (u.role === 'admin' ? 'admin' : 'user') + '">' + escapeHtml(u.role || 'user') + '</span></td>' +
        '<td>' + (u.isActive ? '<span class="cs-ok">Ativo</span>' : '<span class="cs-bad">Inativo</span>') + '</td>' +
        '<td>' + (u.hasAccess ? '<span class="cs-ok">Liberado</span>' : '<span class="cs-bad">Bloqueado</span>') + '</td>' +
        '<td>' + fmt(u.credits || 0) + '</td>' +
        '<td>' + fmtDate(u.createdAt) + '</td>' +
        '<td class="cs-users-actions">' +
          '<button data-action="access" data-value="' + (!u.hasAccess) + '">' + (u.hasAccess ? 'Bloquear' : 'Liberar') + '</button>' +
          '<button data-action="active" data-value="' + (!u.isActive) + '">' + (u.isActive ? 'Desativar' : 'Ativar') + '</button>' +
        '</td>' +
      '</tr>';
    }).join('');
  }
  async function loadUsersPanel() {
    var table = document.getElementById('csUsersTableBody');
    var status = document.getElementById('csUsersStatus');
    if (!table) return;
    table.innerHTML = '<tr><td colspan="7" class="cs-users-empty">Carregando usuários...</td></tr>';
    var out = await csApi('/api/admin/users');
    if (!out.ok) {
      table.innerHTML = '<tr><td colspan="7" class="cs-users-empty err">Falha ao carregar usuários.</td></tr>';
      if (status) status.textContent = out.data.error || 'Erro ao carregar usuários.';
      return;
    }
    var users = out.data.users || [];
    table.innerHTML = usersRowsHtml(users);
    if (status) status.textContent = users.length + ' usuário(s) encontrado(s).';
    table.querySelectorAll('button[data-action]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var tr = btn.closest('tr');
        var id = tr && tr.getAttribute('data-user-id');
        var action = btn.getAttribute('data-action');
        var value = btn.getAttribute('data-value') === 'true';
        if (!id) return;
        btn.disabled = true;
        var path = action === 'access'
          ? '/api/admin/users/' + encodeURIComponent(id) + '/access'
          : '/api/admin/users/' + encodeURIComponent(id) + '/active';
        var body = action === 'access' ? { hasAccess: value } : { isActive: value };
        var resp = await csApi(path, { method: 'PATCH', body: JSON.stringify(body) });
        btn.disabled = false;
        if (!resp.ok) return alert(resp.data.error || 'Falha ao atualizar usuário.');
        loadUsersPanel();
      });
    });
  }
  async function renderUsersPanel() {
    var user = currentUser();
    if (!user || user.role !== 'admin') return alert('Apenas administradores podem consultar usuários.');
    var stageEl = document.getElementById('stage');
    var centerEl = document.getElementById('center');
    var stationEl = document.getElementById('station');
    if (stageEl) stageEl.style.display = 'none';
    if (stationEl) stationEl.classList.remove('on');
    if (!centerEl) return;
    centerEl.style.cssText = 'display:block;overflow:auto;padding:30px;background:var(--bg);';
    centerEl.innerHTML =
      '<div class="cs-users-panel">' +
        '<div class="cs-users-head"><div><h2>Users</h2><p>Consulte e gerencie os usuários sem sair da sidebar do ClipSeller.</p></div><button id="csUsersRefresh">Atualizar</button></div>' +
        '<section class="cs-users-card"><h3>Criar usuário comum</h3>' +
          '<form id="csCreateUserForm" class="cs-users-form">' +
            '<input name="name" placeholder="Nome" autocomplete="name">' +
            '<input name="email" type="email" placeholder="E-mail" autocomplete="email" required>' +
            '<label><input name="hasAccess" type="checkbox" checked> liberar acesso</label>' +
            '<label><input name="sendWelcome" type="checkbox" checked> enviar e-mail</label>' +
            '<button type="submit">Criar</button>' +
          '</form><div id="csCreateUserStatus" class="cs-users-status"></div>' +
        '</section>' +
        '<section class="cs-users-card"><div class="cs-users-list-head"><h3>Lista de usuários</h3><div id="csUsersStatus" class="cs-users-status"></div></div>' +
          '<div class="cs-users-table-wrap"><table class="cs-users-table">' +
            '<thead><tr><th>Usuário</th><th>Tipo</th><th>Status</th><th>Acesso</th><th>Créditos</th><th>Criado em</th><th>Ações</th></tr></thead>' +
            '<tbody id="csUsersTableBody"></tbody>' +
          '</table></div>' +
        '</section>' +
      '</div>';
    document.getElementById('csUsersRefresh').addEventListener('click', loadUsersPanel);
    document.getElementById('csCreateUserForm').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var form = ev.currentTarget;
      var status = document.getElementById('csCreateUserStatus');
      var btn = form.querySelector('button[type=submit]');
      var fd = new FormData(form);
      btn.disabled = true;
      status.textContent = 'Criando...';
      var out = await csApi('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          name: fd.get('name'),
          email: fd.get('email'),
          hasAccess: fd.get('hasAccess') === 'on',
          sendWelcome: fd.get('sendWelcome') === 'on',
        }),
      });
      btn.disabled = false;
      if (!out.ok) {
        status.textContent = out.data.error || 'Falha ao criar usuário.';
        status.className = 'cs-users-status err';
        return;
      }
      status.textContent = 'Usuário criado. Se marcado, o e-mail foi enviado.';
      status.className = 'cs-users-status ok';
      form.reset();
      form.querySelector('input[name=hasAccess]').checked = true;
      form.querySelector('input[name=sendWelcome]').checked = true;
      loadUsersPanel();
    });
    loadUsersPanel();
  }
  window.showUsersPanel = renderUsersPanel;
  async function renderCreditsPanel() {
    var stageEl = document.getElementById('stage');
    var centerEl = document.getElementById('center');
    var stationEl = document.getElementById('station');
    if (stageEl) stageEl.style.display = 'none';
    if (stationEl) stationEl.classList.remove('on');
    if (!centerEl) return;
    centerEl.style.cssText = 'display:block;overflow:auto;padding:30px;background:var(--bg);';
    centerEl.innerHTML = '<div class="cs-credits-panel"><div class="cs-load">Carregando créditos...</div></div>';
    var shell = centerEl.querySelector('.cs-credits-panel');
    try {
      var me = await csApi('/api/credits/me');
      var packs = await csApi('/api/credits/packages');
      var costs = await csApi('/api/credits/feature-costs');
      var user = currentUser();
      var balanceText = user && user.role === 'admin' ? '∞' : fmt(me.data.balance);
      var packages = (packs.data.packages || []).map(function (p, idx) {
        return '<div class="cs-pack ' + (idx === 1 ? 'hot' : '') + '">' +
          (idx === 1 ? '<em>Mais vendido</em>' : '') +
          '<span>' + p.name + '</span>' +
          '<b>' + fmt(p.credits) + ' cr</b>' +
          '<strong>' + money(p.priceCents) + '</strong>' +
          '<small>' + money(Math.round(p.pricePerCredit || 0)) + ' / crédito</small>' +
          '<button data-pack="' + p.slug + '">Comprar agora</button>' +
        '</div>';
      }).join('');
      var costCards = (costs.data.costs || []).map(function (c) {
        return '<div class="cs-cost"><span><b>' + c.label + '</b><small>' + (c.category || '') + '</small></span><strong>' + fmt(c.cost_credits) + ' cr</strong></div>';
      }).join('');
      shell.innerHTML =
        '<div class="cs-head"><div><h2>Meus créditos</h2><p>Compre créditos e acompanhe o consumo sem sair do ClipSeller.</p></div><div class="cs-balance"><small>Saldo atual</small><b>' + balanceText + '</b></div></div>' +
        '<h3>Comprar créditos</h3><div class="cs-packs">' + packages + '</div>' +
        '<details class="cs-custom"><summary>Comprar créditos avulsos</summary><div><input id="csCustomCredits" type="number" min="100" step="50" placeholder="Ex.: 500"><button id="csBuyCustom">Comprar avulso</button><small>Preço avulso: ' + money(packs.data.avulsoPriceCents || 16) + ' por crédito</small></div></details>' +
        '<h3>Tabela de consumo</h3><div class="cs-costs">' + costCards + '</div>' +
        '<h3>Histórico</h3><div class="cs-txs">' + txHtml(me.data.transactions || []) + '</div>';
      shell.querySelectorAll('button[data-pack]').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          btn.disabled = true; btn.textContent = 'Abrindo checkout...';
          var out = await csApi('/api/credits/checkout', { method:'POST', body: JSON.stringify({ packageSlug: btn.getAttribute('data-pack') }) });
          if (!out.ok) { alert(out.data.error || 'Falha ao abrir checkout.'); btn.disabled = false; btn.textContent = 'Comprar agora'; return; }
          window.top.location.href = out.data.checkoutUrl;
        });
      });
      var customBtn = document.getElementById('csBuyCustom');
      if (customBtn) customBtn.addEventListener('click', async function () {
        var val = parseInt((document.getElementById('csCustomCredits') || {}).value || '0', 10);
        if (!val || val < 100) return alert('Mínimo de 100 créditos.');
        customBtn.disabled = true; customBtn.textContent = 'Abrindo checkout...';
        var out = await csApi('/api/credits/checkout', { method:'POST', body: JSON.stringify({ customCredits: val }) });
        if (!out.ok) { alert(out.data.error || 'Falha ao abrir checkout.'); customBtn.disabled = false; customBtn.textContent = 'Comprar avulso'; return; }
        window.top.location.href = out.data.checkoutUrl;
      });
    } catch (err) {
      shell.innerHTML = '<div class="err">Falha ao carregar créditos: ' + ((err && err.message) || err) + '</div>';
    }
  }
  window.showCreditsPanel = renderCreditsPanel;
  function installCreditsSidebarItem() {
    if (document.getElementById('csCreditsSide')) return;
    var side = document.getElementById('side');
    if (!side) return;
    var item = document.createElement('div');
    item.className = 'si';
    item.id = 'csCreditsSide';
    item.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8"/><path d="M14.5 9.5a3 3 0 1 0 0 5"/></svg>Créditos';
    item.onclick = function () {
      document.querySelectorAll('.side .si').forEach(function (x) { x.classList.remove('on'); });
      item.classList.add('on');
      renderCreditsPanel();
    };
    var systemGroup = Array.from(side.querySelectorAll('.sgrp')).find(function (el) { return String(el.textContent || '').toLowerCase().includes('sistema'); });
    if (systemGroup && systemGroup.nextSibling) systemGroup.parentNode.insertBefore(item, systemGroup.nextSibling);
    else side.appendChild(item);
  }
  function installDashboardSidebarItem() {
    if (document.getElementById('csDashboardSide')) return;
    var side = document.getElementById('side');
    if (!side) return;
    var item = document.createElement('div');
    item.className = 'si';
    item.id = 'csDashboardSide';
    item.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><rect x="7" y="12" width="3" height="5" rx="1"/><rect x="12" y="8" width="3" height="9" rx="1"/><rect x="17" y="5" width="3" height="12" rx="1"/></svg>Dashboard';
    item.onclick = function () {
      document.querySelectorAll('.side .si').forEach(function (x) { x.classList.remove('on'); });
      item.classList.add('on');
      renderDashboardPanel();
    };
    var firstItem = side.querySelector('.si');
    if (firstItem) side.insertBefore(item, firstItem);
    else {
      side.appendChild(item);
    }
  }
  function installUsersSidebarItem() {
    if (document.getElementById('csUsersSide')) return;
    var user = currentUser();
    if (!user || user.role !== 'admin') return;
    var side = document.getElementById('side');
    if (!side) return;
    var item = document.createElement('div');
    item.className = 'si';
    item.id = 'csUsersSide';
    item.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>Users';
    item.onclick = function () {
      document.querySelectorAll('.side .si').forEach(function (x) { x.classList.remove('on'); });
      item.classList.add('on');
      renderUsersPanel();
    };
    var creditsItem = document.getElementById('csCreditsSide');
    if (creditsItem && creditsItem.nextSibling) creditsItem.parentNode.insertBefore(item, creditsItem.nextSibling);
    else if (creditsItem) creditsItem.parentNode.appendChild(item);
    else {
      var systemGroup = Array.from(side.querySelectorAll('.sgrp')).find(function (el) { return String(el.textContent || '').toLowerCase().includes('sistema'); });
      if (systemGroup && systemGroup.nextSibling) systemGroup.parentNode.insertBefore(item, systemGroup.nextSibling);
      else side.appendChild(item);
    }
  }
  var style = document.createElement('style');
  style.textContent =
    '.cs-credits-panel{max-width:1060px;margin:0 auto;color:var(--ink);font-family:Outfit,system-ui,sans-serif}' +
    '.cs-head{display:flex;justify-content:space-between;gap:20px;align-items:center;background:linear-gradient(135deg,rgba(255,77,28,.13),rgba(255,77,28,.03));border:1px solid var(--line);border-radius:16px;padding:22px;margin-bottom:22px}' +
    '.cs-head h2{margin:0 0 4px;font-size:25px}.cs-head p{margin:0;color:var(--mut);font-size:13px}.cs-balance{min-width:150px;background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:14px;text-align:center}.cs-balance small{display:block;color:var(--mut2);text-transform:uppercase;font-size:10px;letter-spacing:.08em}.cs-balance b{font-size:34px;color:var(--orange)}' +
    '.cs-credits-panel h3{margin:22px 0 10px}.cs-packs,.cs-costs{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}.cs-pack,.cs-cost,.cs-custom{background:var(--paper);border:1px solid var(--line);border-radius:13px;padding:14px;position:relative}.cs-pack.hot{border-color:var(--orange)}.cs-pack em{position:absolute;right:10px;top:-9px;background:var(--orange);color:white;border-radius:999px;padding:3px 8px;font-size:9px;font-style:normal;font-weight:800}.cs-pack span,.cs-pack small,.cs-cost small{display:block;color:var(--mut);font-size:12px}.cs-pack b{display:block;font-size:26px;margin:5px 0}.cs-pack strong{display:block;color:var(--orange);font-size:18px}.cs-pack button,.cs-custom button{width:100%;margin-top:10px;border:0;border-radius:9px;background:var(--orange);color:white;padding:10px;font-weight:800;cursor:pointer}.cs-custom summary{cursor:pointer;color:var(--mut);font-weight:700}.cs-custom input{margin:12px 8px 0 0;border:1px solid var(--line);background:var(--paper);color:var(--ink);border-radius:9px;padding:10px}.cs-cost{display:flex;justify-content:space-between;gap:8px;align-items:center}.cs-cost b{font-size:13px}.cs-cost strong{color:var(--orange)}.cs-tx{display:grid;grid-template-columns:95px 1fr auto 110px;gap:10px;align-items:center;border-bottom:1px solid var(--line);padding:9px 0;font-size:12px}.cs-tx span,.cs-tx small{color:var(--mut2)}.cs-tx .pos{color:#16a34a}.cs-tx .neg{color:#dc2626}.cs-muted{color:var(--mut);font-size:13px}.cs-load{color:var(--mut);padding:20px}' +
    '.cs-dash-panel{max-width:1480px;width:100%;font-size:15px}.cs-dash-head,.cs-dash-card{background:var(--paper)!important;border:1px solid var(--line)!important;border-radius:22px!important;padding:28px!important;margin-bottom:22px!important;box-shadow:var(--shadow,0 18px 50px rgba(0,0,0,.28))!important}.cs-dash-head{background:linear-gradient(135deg,rgba(255,77,28,.16),rgba(255,77,28,.045))!important}.cs-dash-head:before,.cs-dash-head:after{background:radial-gradient(circle,rgba(255,77,28,.18),transparent 68%)!important}.cs-dash-head h2{font-size:36px!important;letter-spacing:-.03em}.cs-dash-head p{color:var(--mut)!important;font-size:15px!important}.cs-dash-head button{background:var(--orange)!important;border-radius:13px!important;padding:13px 18px!important;box-shadow:0 12px 30px rgba(255,77,28,.28)!important}.cs-kpis{grid-template-columns:repeat(4,minmax(190px,1fr))!important;gap:18px!important;margin-bottom:22px!important}.cs-kpis div{background:var(--paper)!important;border:1px solid var(--line)!important;border-radius:20px!important;padding:24px!important}.cs-kpis div:after{background:rgba(255,77,28,.08)!important;width:110px!important;height:110px!important}.cs-kpis small{color:var(--mut)!important;font-size:11px!important}.cs-kpis b{color:var(--orange)!important;font-size:42px!important;text-shadow:none!important}.cs-dash-card h3{font-size:22px}.cs-dash-card-head span{color:var(--mut)!important;font-size:13px!important}.cs-bar-row{grid-template-columns:minmax(240px,1.1fr) minmax(260px,2fr) 90px 110px!important;gap:18px!important;padding:15px 0!important;border-bottom:1px solid var(--line)!important}.cs-bar-label small,.cs-bar-row em,.cs-day small,.cs-top-user small{color:var(--mut2)!important}.cs-bar-track{height:18px!important;background:var(--bg)!important;border:1px solid var(--line)!important}.cs-bar-track span{background:linear-gradient(90deg,var(--orange),#ff7a45)!important;box-shadow:0 0 20px rgba(255,77,28,.24)!important}.cs-bar-row strong,.cs-top-user strong{color:var(--orange)!important;font-size:16px!important}.cs-day-chart{height:280px!important;gap:8px!important;padding-top:18px!important}.cs-day span{background:linear-gradient(180deg,var(--orange),rgba(255,77,28,.38))!important;box-shadow:0 0 16px rgba(255,77,28,.18)!important}.cs-top-user{border-bottom:1px solid var(--line)!important;padding:14px 0!important;grid-template-columns:38px 1.1fr 1.5fr 90px!important}.cs-top-user span{width:30px!important;height:30px!important;background:var(--orange)!important}@media(max-width:1100px){.cs-kpis{grid-template-columns:repeat(2,1fr)!important}.cs-bar-row{grid-template-columns:1fr!important}}' +
    '.cs-dash-panel{margin:0 auto;color:var(--ink);font-family:Outfit,system-ui,sans-serif}.cs-dash-head{position:relative;overflow:hidden;display:flex;align-items:center;justify-content:space-between;gap:22px}.cs-dash-head>*{position:relative;z-index:1}.cs-dash-head h2{margin:0 0 8px}.cs-dash-head p{margin:0}.cs-kpis{display:grid}.cs-kpis small{display:block;text-transform:uppercase;letter-spacing:.08em}.cs-kpis b{display:block;margin-top:9px}.cs-dash-card{position:relative;overflow:hidden}.cs-dash-card-head{display:flex;justify-content:space-between;gap:16px;align-items:center;margin-bottom:18px}.cs-dash-card-head h3{margin:0}.cs-bar-row{display:grid;align-items:center}.cs-bar-label b,.cs-bar-label small{display:block}.cs-bar-track{border-radius:999px;overflow:hidden}.cs-bar-track span{display:block;height:100%;border-radius:999px}.cs-bar-row em{font-style:normal}.cs-day-chart{display:flex;align-items:flex-end}.cs-day{flex:1;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:8px;min-width:13px}.cs-day span{width:100%;min-height:3px;border-radius:8px 8px 2px 2px}.cs-day small{font-size:10px;writing-mode:vertical-rl;max-height:52px}.cs-top-user{display:grid;gap:12px;align-items:center}.cs-top-user span{border-radius:999px;color:white;display:grid;place-items:center;font-weight:800}.cs-top-user strong{text-align:right}' +
    '.cs-users-panel{max-width:1180px;margin:0 auto;color:var(--ink);font-family:Outfit,system-ui,sans-serif}.cs-users-head,.cs-users-card{background:var(--paper);border:1px solid var(--line);border-radius:16px;padding:20px;margin-bottom:16px}.cs-users-head{display:flex;align-items:center;justify-content:space-between;gap:16px;background:linear-gradient(135deg,rgba(255,77,28,.12),rgba(255,77,28,.03))}.cs-users-head h2,.cs-users-card h3{margin:0 0 5px}.cs-users-head p{margin:0;color:var(--mut);font-size:13px}.cs-users-head button,.cs-users-form button,.cs-users-actions button{border:0;border-radius:9px;background:var(--orange);color:white;padding:9px 12px;font-weight:800;cursor:pointer}.cs-users-form{display:grid;grid-template-columns:minmax(150px,1fr) minmax(220px,1.4fr) auto auto auto;gap:10px;align-items:center}.cs-users-form input:not([type=checkbox]){width:100%;border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:10px;padding:10px}.cs-users-form label{color:var(--mut);font-size:12px;white-space:nowrap}.cs-users-status{color:var(--mut);font-size:12px}.cs-users-status.ok{color:#16a34a}.cs-users-status.err,.cs-users-empty.err{color:#dc2626}.cs-users-list-head{display:flex;justify-content:space-between;gap:12px;align-items:center}.cs-users-table-wrap{overflow:auto;border:1px solid var(--line);border-radius:13px;margin-top:12px}.cs-users-table{width:100%;min-width:920px;border-collapse:collapse;font-size:12px}.cs-users-table th,.cs-users-table td{padding:11px 12px;border-bottom:1px solid var(--line);text-align:left}.cs-users-table th{color:var(--mut);font-size:10px;text-transform:uppercase;letter-spacing:.08em}.cs-users-table td strong{display:block}.cs-users-table td small{display:block;color:var(--mut2);margin-top:3px}.cs-role{display:inline-flex;border-radius:999px;padding:4px 8px;background:rgba(148,163,184,.16);color:var(--mut)}.cs-role.admin{background:rgba(255,77,28,.18);color:var(--orange)}.cs-ok{color:#16a34a;font-weight:800}.cs-bad{color:#dc2626;font-weight:800}.cs-users-actions{display:flex;gap:7px;flex-wrap:wrap}.cs-users-actions button{background:transparent;color:var(--ink);border:1px solid var(--line);padding:7px 9px}.cs-users-empty{text-align:center;color:var(--mut);padding:18px!important}';
  document.head.appendChild(style);
  document.addEventListener('DOMContentLoaded', refreshBalance);
  document.addEventListener('DOMContentLoaded', installCreditsSidebarItem);
  document.addEventListener('DOMContentLoaded', installDashboardSidebarItem);
  document.addEventListener('DOMContentLoaded', installUsersSidebarItem);
  setInterval(refreshBalance, 20000);
})();
</script>
`;

function patchHtml(raw) {
  let patched = raw;

  // Remove a dependência visual/funcional de chaves no navegador. As chaves
  // reais ficam exclusivamente no .env do VPS e são aplicadas pelo /cs-proxy.
  const serverKeysLiteral =
    '{anthropic:"sk-ant-server-side",fal:"server-side",kie:"server-side",google:"server-side",laozhang:"server-side",lzSora:"server-side",lzImg:"server-side",lzNano:"server-side",proxy:"",vidbk:"",imgbk:"",ugcbk:"",fashn:"server-side"}';

  patched = patched.replace(
    'let KEYS={anthropic:"",fal:"",kie:"",google:"",laozhang:"",lzSora:"",lzImg:"",lzNano:"",proxy:"http://localhost:8787",vidbk:"",imgbk:"",ugcbk:"",fashn:""};',
    `let KEYS=${serverKeysLiteral};`,
  );
  patched = patched.replace(
    'let KEYS={anthropic:"",fal:"",kie:"",google:"",laozhang:"",lzSora:"",lzImg:"",lzNano:"",proxy:"",vidbk:"",imgbk:"",ugcbk:"",fashn:""};',
    `let KEYS=${serverKeysLiteral};`,
  );
  patched = patched.replace(
    'const def={anthropic:"",fal:"",kie:"",google:"",laozhang:"",lzSora:"",lzImg:"",lzNano:"",proxy:"http://localhost:8787",vidbk:"",imgbk:"",ugcbk:"",fashn:""};',
    `const def=${serverKeysLiteral};`,
  );
  patched = patched.replace(
    'const def={anthropic:"",fal:"",kie:"",google:"",laozhang:"",lzSora:"",lzImg:"",lzNano:"",proxy:"",vidbk:"",imgbk:"",ugcbk:"",fashn:""};',
    `const def=${serverKeysLiteral};`,
  );
  patched = patched.replace(
    'function chargeCreditsBackend(amount,label){/* DEV: conectar ao DB de usuários e debitar aqui (amount em créditos, label = ação) */return true;}',
    'function chargeCreditsBackend(amount,label){return true;}',
  );
  patched = patched.replace(
    'KEYS=Object.assign(def,keys||d.KEYS||{});credits=',
    'KEYS=Object.assign(def,d.KEYS||{},keys||{});Object.assign(KEYS,' + serverKeysLiteral + ');credits=',
  );
  patched = patched.replace(
    'KEYS=Object.assign(def,keys||{});if(keys){try{save();}catch(_){}}return false;',
    'KEYS=Object.assign(def,keys||{});Object.assign(KEYS,' + serverKeysLiteral + ');if(keys){try{save();}catch(_){}}return false;',
  );
  patched = patched.replace(
    '<div class="log" id="log"><div class="entry"><div class="msg think">Cole suas chaves pra começar.</div></div></div>',
    '<div class="log" id="log"><div class="entry"><div class="msg think">Pronto. As chaves já estão configuradas no servidor.</div></div></div>',
  );
  patched = patched.replace(
    '<div class="foot"><span class="d" style="background:var(--mut2)"></span> Aguardando chaves</div>',
    '<div class="foot"><span class="d" style="background:var(--ok)"></span> Pronto para gerar</div>',
  );
  patched = patched
    .replaceAll('Configure a chave do Motor de Moda em Chaves & Config em Chaves & Config.', 'Motor de Moda indisponível no momento. Tente novamente em instantes.')
    .replaceAll('Configure a chave do Motor de Moda em Chaves & Config.', 'Motor de Moda indisponível no momento. Tente novamente em instantes.');
  patched = patched.replace(
    '<div class="si" onclick="goStation(\'chaves\',this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="7.5" cy="15.5" r="3.5"/><path d="m10 13 8-8M16 5l3 3M19 2l3 3"/></svg>Chaves & Config</div>',
    '',
  );
  patched = patched.replace(
    /<button class="kb" onclick="showGate\(\)">[\s\S]*?Chaves<\/button>/,
    '',
  );
  patched = patched.replace('let credits=500, theme=\'light\';', 'let credits=0, theme=\'light\';');
  patched = patched.replace(
    'function topUp(){credits+=100;updateCred();save();}',
    "function topUp(){if(window.showCreditsPanel)return window.showCreditsPanel();try{window.top.location.href='/credits.html';}catch(_){location.href='/credits.html';}}",
  );
  patched = patched.replace(
    /function needCred\(c,label\)\{[\s\S]*?\nfunction showGate/,
    `function needCred(c,label){
  if(credits<c){alert('Créditos insuficientes ('+c+'). Abra "Meus créditos" para recarregar.');topUp();return false;}
  credits-=c;updateCred();save();
  const l=String(label||'').toLowerCase();
  let featureKey='clipseller.novo.img-basico';
  if(l.includes('inspirada'))featureKey='clipseller.novo.inspirada';
  else if(l.includes('moda')&&l.includes('provador'))featureKey='clipseller.novo.provador';
  else if(l.includes('provador'))featureKey='clipseller.novo.provador';
  else if(l.includes('moda')||l.includes('look'))featureKey='clipseller.novo.moda-look';
  else if(l.includes('ugc'))featureKey=(c>=100?'clipseller.novo.ugc-10s':'clipseller.novo.ugc-5s');
  else if(l.includes('vídeo')||l.includes('video')||l.includes('refazer')||l.includes('estender'))featureKey=(c>=100?'clipseller.novo.vid-prod-10s':'clipseller.novo.vid-prod-5s');
  else if(l.includes('título')||l.includes('titulo')||l.includes('seo'))featureKey='clipseller.novo.titulo';
  else if(l.includes('montagem')||l.includes('comercial'))featureKey='clipseller.novo.montagem';
  else if(l.includes('refazer foto')||l.includes('regenerar'))featureKey='clipseller.novo.regen';
  else if(l.includes('edição')||l.includes('edicao'))featureKey='clipseller.novo.edicao-livre';
  chargeCreditsBackend({featureKey,description:label||''});
  return true;
}
function showGate`,
  );
  patched = patched.replace(
    /function showGate\(\)\{[\s\S]*?\nfunction setImgMode/,
    `function showGate(){stage.style.display='none';center.style.display='grid';center.style.cssText='';
  try{Object.assign(KEYS,${serverKeysLiteral});localStorage.removeItem(KSK);topdot.classList.add('on');}catch(_){}
  center.innerHTML=\`<div class="card-c"><h3>ClipSeller pronto para gerar</h3><p>As chaves necessárias já estão configuradas no servidor, como no SellerIA Club. Você não precisa colar API key nem token.</p>
  <div class="secnote"><b>Credenciais protegidas:</b> Anthropic, fal.ai, Kie, Gemini, Fashn, Laozhang e demais motores são aplicados automaticamente pelo proxy seguro do ClipSeller.</div>
  <button class="btn acc" onclick="renderUpload()">Começar geração →</button>
  <span class="clr" onclick="wipe()">Limpar todo o canvas</span></div>\`;}
function setImgMode`,
  );
  patched = patched.replace(
    "if(S.products&&S.products.length){topdot.classList.add('on');startCanvas();}else{showGate();}",
    "if(S.products&&S.products.length){topdot.classList.add('on');startCanvas();}else{topdot.classList.add('on');logEl.innerHTML='';log('Pronto — suba o produto para gerar.','msg think');setFoot('Pronto para gerar');renderUpload();}",
  );

  // Garante que o BRIDGE rode após o HTML legado declarar suas funções/variáveis.
  if (raw.includes('</body>')) {
    return patched.replace('</body>', BRIDGE + '</body>');
  }
  return patched + BRIDGE;
}

export const clipsellerHtmlRouter = Router();

clipsellerHtmlRouter.get('/', requireAuth, requireClipSellerAccess, async (_req, res) => {
  try {
    const raw = await readFile(HTML_PATH, 'utf8');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(patchHtml(raw));
  } catch (err) {
    console.error('[clipseller-html]', err.message);
    res.status(500).send('Falha ao carregar o ClipSeller HTML.');
  }
});
