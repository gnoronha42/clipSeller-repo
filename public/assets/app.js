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
      var token = encodeURIComponent(localStorage.getItem(TOKEN_KEY) || '');
      var balanceLabel = u.role === 'admin' ? '∞' : '…';
      root.innerHTML = '' +
        '<div class="app-shell">' +
          '<div class="app-header">' +
            '<div class="app-brand"><img src="/img/IMG_9841.PNG" alt="ClipSeller" /><span>ClipSeller</span></div>' +
            '<div class="app-actions">' +
              '<a id="creditsLink" href="/credits.html" class="credits-pill" title="Comprar / ver consumo">' +
                '<span class="cp-label">Créditos</span><span class="cp-value" id="hdrBalance">' + balanceLabel + '</span>' +
              '</a>' +
              '<span class="user-email">' + u.email + '</span>' +
              '<button id="logoutBtn">Sair</button>' +
            '</div>' +
          '</div>' +
          '<iframe class="app-frame" src="/clipseller-html?token=' + token + '" allow="clipboard-write; clipboard-read"></iframe>' +
        '</div>';

      if (u.role !== 'admin') refreshHeaderBalance();
    }

    document.getElementById('logoutBtn').addEventListener('click', function () {
      clearSession();
      renderLogin();
    });
  }

  async function refreshHeaderBalance() {
    var el = document.getElementById('hdrBalance');
    if (!el) return;
    var r = await api('/api/credits/me');
    if (r.ok) el.textContent = (r.data.balance || 0).toLocaleString('pt-BR');
  }

  // Escuta atualizações de saldo enviadas pelo iframe ClipSeller após débito.
  window.addEventListener('message', function (ev) {
    if (!ev.data || ev.data.type !== 'cs:balance') return;
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
