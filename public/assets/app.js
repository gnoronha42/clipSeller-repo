(function () {
  'use strict';
  var TOKEN_KEY = 'cs_token';
  var USER_KEY = 'cs_user';
  var root = document.getElementById('app');

  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    var token = localStorage.getItem(TOKEN_KEY);
    if (token) opts.headers.Authorization = 'Bearer ' + token;
    return fetch(path, opts).then(async function (r) {
      var data = {};
      try { data = await r.json(); } catch (_) {}
      return { status: r.status, ok: r.ok, data: data };
    });
  }

  function setSession(token, user) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  }

  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }

  function currentUser() {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); }
    catch (_) { return null; }
  }

  function showError(form, msg) {
    var el = form.querySelector('.auth-msg');
    if (el) { el.textContent = msg; el.className = 'auth-msg error'; }
  }
  function showOk(form, msg) {
    var el = form.querySelector('.auth-msg');
    if (el) { el.textContent = msg; el.className = 'auth-msg ok'; }
  }

  function renderLogin(initialTab) {
    var tab = initialTab || 'login';
    root.innerHTML = '' +
      '<main class="auth-shell"><div class="auth-card">' +
        '<img src="/img/IMG_9841.PNG" alt="ClipSeller" class="auth-logo" />' +
        '<h1>ClipSeller</h1>' +
        '<p class="auth-sub">Estúdio de imagem e vídeo com IA.</p>' +
        '<div class="auth-tabs">' +
          '<button data-tab="login" class="' + (tab==='login'?'active':'') + '">Entrar</button>' +
          '<button data-tab="forgot" class="' + (tab==='forgot'?'active':'') + '">Esqueci minha senha</button>' +
        '</div>' +
        '<div id="tab-content"></div>' +
      '</div></main>';

    root.querySelectorAll('.auth-tabs button').forEach(function (btn) {
      btn.addEventListener('click', function () { renderLogin(btn.getAttribute('data-tab')); });
    });

    var content = document.getElementById('tab-content');
    if (tab === 'login') {
      content.innerHTML = '' +
        '<form id="loginForm" autocomplete="on">' +
          '<div class="auth-msg"></div>' +
          '<label>E-mail<input type="email" name="email" required autocomplete="email" /></label>' +
          '<label>Senha<input type="password" name="password" required autocomplete="current-password" /></label>' +
          '<button type="submit">Entrar</button>' +
        '</form>';
      var form = document.getElementById('loginForm');
      form.addEventListener('submit', async function (ev) {
        ev.preventDefault();
        var btn = form.querySelector('button[type=submit]');
        btn.disabled = true; btn.textContent = 'Entrando...';
        var fd = new FormData(form);
        var resp = await api('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email: fd.get('email'), password: fd.get('password') }),
        });
        btn.disabled = false; btn.textContent = 'Entrar';
        if (!resp.ok) return showError(form, resp.data.error || 'Não foi possível entrar.');
        setSession(resp.data.accessToken, resp.data.user);
        renderApp();
      });
    } else {
      content.innerHTML = '' +
        '<form id="forgotForm">' +
          '<div class="auth-msg"></div>' +
          '<label>E-mail<input type="email" name="email" required autocomplete="email" /></label>' +
          '<button type="submit">Receber link</button>' +
        '</form>';
      var ff = document.getElementById('forgotForm');
      ff.addEventListener('submit', async function (ev) {
        ev.preventDefault();
        var btn = ff.querySelector('button[type=submit]');
        btn.disabled = true; btn.textContent = 'Enviando...';
        var fd = new FormData(ff);
        var resp = await api('/api/auth/forgot-password', {
          method: 'POST',
          body: JSON.stringify({ email: fd.get('email') }),
        });
        btn.disabled = false; btn.textContent = 'Receber link';
        if (!resp.ok) return showError(ff, resp.data.error || 'Falha ao solicitar.');
        showOk(ff, resp.data.message || 'Verifique seu e-mail.');
      });
    }
  }

  function renderApp() {
    var u = currentUser();
    if (!u) return renderLogin();

    var canAccess = u.role === 'admin' || u.hasAccess;

    if (!canAccess) {
      root.innerHTML = '' +
        '<div class="app-shell">' +
          '<div class="app-header">' +
            '<div class="app-brand"><img src="/img/IMG_9841.PNG" alt="ClipSeller" /><span>ClipSeller</span></div>' +
            '<div class="app-actions"><span>' + u.email + '</span><button id="logoutBtn">Sair</button></div>' +
          '</div>' +
          '<div class="locked">' +
            '<h2>Sua conta ainda não tem acesso ao ClipSeller</h2>' +
            '<p>Se você comprou pela Hotmart, aguarde alguns minutos pelo e-mail de boas-vindas. Caso já tenha esperado, fale com o suporte.</p>' +
          '</div>' +
        '</div>';
    } else {
      var balanceLabel = u.role === 'admin' ? '∞' : '…';
      var adminBtn = u.role === 'admin'
        ? '<button id="adminUsersBtn" class="admin-pill" type="button">Usuários</button>'
        : '';
      root.innerHTML = '' +
        '<div class="app-shell">' +
          '<div class="app-header">' +
            '<div class="app-brand"><img src="/img/IMG_9841.PNG" alt="ClipSeller" /><span>ClipSeller</span></div>' +
            '<div class="app-actions">' +
              adminBtn +
              '<a id="creditsLink" href="/credits.html" class="credits-pill" title="Comprar / ver consumo">' +
                '<span class="cp-label">Créditos</span><span class="cp-value" id="hdrBalance">' + balanceLabel + '</span>' +
              '</a>' +
              '<span class="user-email">' + u.email + '</span>' +
              '<button id="logoutBtn">Sair</button>' +
            '</div>' +
          '</div>' +
          '<iframe class="app-frame" src="/clipseller-html" allow="clipboard-write; clipboard-read"></iframe>' +
        '</div>';

      if (u.role !== 'admin') refreshHeaderBalance();
    }

    document.getElementById('logoutBtn').addEventListener('click', async function () {
      try { await api('/api/auth/logout', { method: 'POST' }); } catch (_) {}
      clearSession();
      renderLogin();
    });
    var usersBtn = document.getElementById('adminUsersBtn');
    if (usersBtn) usersBtn.addEventListener('click', renderAdminUsers);
  }

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

  function renderUsersRows(users) {
    if (!users.length) {
      return '<tr><td colspan="7" class="admin-empty">Nenhum usuário encontrado.</td></tr>';
    }
    return users.map(function (u) {
      var roleClass = u.role === 'admin' ? 'role-admin' : 'role-user';
      return '' +
        '<tr data-user-id="' + escapeHtml(u.id) + '">' +
          '<td><strong>' + escapeHtml(u.name || '-') + '</strong><small>' + escapeHtml(u.email) + '</small></td>' +
          '<td><span class="role-badge ' + roleClass + '">' + escapeHtml(u.role) + '</span></td>' +
          '<td>' + (u.isActive ? '<span class="ok">Ativo</span>' : '<span class="bad">Inativo</span>') + '</td>' +
          '<td>' + (u.hasAccess ? '<span class="ok">Liberado</span>' : '<span class="bad">Bloqueado</span>') + '</td>' +
          '<td>' + Number(u.credits || 0).toLocaleString('pt-BR') + '</td>' +
          '<td>' + fmtDate(u.createdAt) + '</td>' +
          '<td class="admin-row-actions">' +
            '<button data-action="access" data-value="' + (!u.hasAccess) + '">' + (u.hasAccess ? 'Bloquear' : 'Liberar') + '</button>' +
            '<button data-action="active" data-value="' + (!u.isActive) + '">' + (u.isActive ? 'Desativar' : 'Ativar') + '</button>' +
          '</td>' +
        '</tr>';
    }).join('');
  }

  async function loadAdminUsers() {
    var table = document.getElementById('adminUsersTableBody');
    var status = document.getElementById('adminUsersStatus');
    if (!table) return;
    table.innerHTML = '<tr><td colspan="7" class="admin-empty">Carregando...</td></tr>';
    var resp = await api('/api/admin/users');
    if (!resp.ok) {
      table.innerHTML = '<tr><td colspan="7" class="admin-empty error">Falha ao carregar usuários.</td></tr>';
      if (status) status.textContent = resp.data.error || 'Erro ao carregar usuários.';
      return;
    }
    var users = resp.data.users || [];
    table.innerHTML = renderUsersRows(users);
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
        var out = await api(path, { method: 'PATCH', body: JSON.stringify(body) });
        btn.disabled = false;
        if (!out.ok) {
          alert(out.data.error || 'Falha ao atualizar usuário.');
          return;
        }
        loadAdminUsers();
      });
    });
  }

  function renderAdminUsers() {
    var u = currentUser();
    if (!u || u.role !== 'admin') return;
    var frame = document.querySelector('.app-frame');
    if (frame) frame.remove();
    var existing = document.getElementById('adminUsersPanel');
    if (existing) existing.remove();
    var shell = document.querySelector('.app-shell');
    if (!shell) return;
    var panel = document.createElement('main');
    panel.id = 'adminUsersPanel';
    panel.className = 'admin-panel';
    panel.innerHTML = '' +
      '<section class="admin-hero">' +
        '<div><h1>Usuários ClipSeller</h1><p>Gerencie compradores, acesso e status de conta.</p></div>' +
        '<button id="adminBackToStudio" type="button">Voltar ao estúdio</button>' +
      '</section>' +
      '<section class="admin-card">' +
        '<h2>Criar usuário comum</h2>' +
        '<form id="adminCreateUserForm" class="admin-form">' +
          '<input name="name" placeholder="Nome" autocomplete="name">' +
          '<input name="email" type="email" placeholder="E-mail" autocomplete="email" required>' +
          '<label class="admin-check"><input name="hasAccess" type="checkbox" checked> liberar acesso</label>' +
          '<label class="admin-check"><input name="sendWelcome" type="checkbox" checked> enviar e-mail para definir senha</label>' +
          '<button type="submit">Criar usuário</button>' +
        '</form>' +
        '<div id="adminCreateStatus" class="admin-status"></div>' +
      '</section>' +
      '<section class="admin-card">' +
        '<div class="admin-list-head"><h2>Lista de usuários</h2><button id="adminRefreshUsers" type="button">Atualizar</button></div>' +
        '<div id="adminUsersStatus" class="admin-status"></div>' +
        '<div class="admin-table-wrap"><table class="admin-table">' +
          '<thead><tr><th>Usuário</th><th>Tipo</th><th>Status</th><th>Acesso</th><th>Créditos</th><th>Criado em</th><th>Ações</th></tr></thead>' +
          '<tbody id="adminUsersTableBody"></tbody>' +
        '</table></div>' +
      '</section>';
    shell.appendChild(panel);
    document.getElementById('adminBackToStudio').addEventListener('click', renderApp);
    document.getElementById('adminRefreshUsers').addEventListener('click', loadAdminUsers);
    document.getElementById('adminCreateUserForm').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var form = ev.currentTarget;
      var status = document.getElementById('adminCreateStatus');
      var btn = form.querySelector('button[type=submit]');
      var fd = new FormData(form);
      btn.disabled = true;
      status.textContent = 'Criando...';
      var out = await api('/api/admin/users', {
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
        status.className = 'admin-status error';
        return;
      }
      status.textContent = 'Usuário criado. Se marcado, o e-mail de definição de senha foi enviado.';
      status.className = 'admin-status ok';
      form.reset();
      form.querySelector('input[name=hasAccess]').checked = true;
      form.querySelector('input[name=sendWelcome]').checked = true;
      loadAdminUsers();
    });
    loadAdminUsers();
  }
  window.showClipSellerAdminUsers = renderAdminUsers;

  async function refreshHeaderBalance() {
    var el = document.getElementById('hdrBalance');
    if (!el) return;
    var r = await api('/api/credits/me');
    if (r.ok) el.textContent = (r.data.balance || 0).toLocaleString('pt-BR');
  }

  // Escuta atualizações de saldo enviadas pelo iframe ClipSeller após débito.
  window.addEventListener('message', function (ev) {
    if (!ev.data) return;
    if (ev.data.type === 'cs:admin-users') {
      renderAdminUsers();
      return;
    }
    if (ev.data.type !== 'cs:balance') return;
    var el = document.getElementById('hdrBalance');
    if (!el) return;
    if (typeof ev.data.balance === 'number') {
      el.textContent = ev.data.balance.toLocaleString('pt-BR');
    }
  });

  async function init() {
    var token = localStorage.getItem(TOKEN_KEY);
    if (!token) return renderLogin();
    var resp = await api('/api/auth/me');
    if (!resp.ok) { clearSession(); return renderLogin(); }
    setSession(token, resp.data.user);
    renderApp();
  }

  init();
})();
