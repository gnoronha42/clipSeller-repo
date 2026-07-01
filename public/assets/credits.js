(function () {
  'use strict';
  var TOKEN_KEY = 'cs_token';
  var USER_KEY = 'cs_user';

  function token() { return localStorage.getItem(TOKEN_KEY); }
  function user() { try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch (_) { return null; } }
  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    var t = token();
    if (t) opts.headers.Authorization = 'Bearer ' + t;
    return fetch(path, opts).then(async function (r) {
      var data = {};
      try { data = await r.json(); } catch (_) {}
      return { status: r.status, ok: r.ok, data: data };
    });
  }
  function fmt(n) { return (n || 0).toLocaleString('pt-BR'); }
  function money(cents) { return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
  function dateTime(iso) {
    try { return new Date(iso).toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }); }
    catch (_) { return ''; }
  }

  function gate() {
    if (!token()) { location.href = '/'; return false; }
    var u = user();
    if (u) document.getElementById('userEmail').textContent = u.email;
    return true;
  }

  function handlePaymentReturn() {
    var p = new URLSearchParams(location.search).get('payment');
    if (p === 'success') document.getElementById('bannerPaymentSuccess').style.display = 'block';
    if (p === 'pending') document.getElementById('bannerPaymentPending').style.display = 'block';
    if (p === 'failure') document.getElementById('bannerPaymentFailure').style.display = 'block';
  }

  async function loadBalance() {
    var r = await api('/api/credits/me');
    if (!r.ok) return;
    var el = document.getElementById('balance');
    el.textContent = fmt(r.data.balance);
    var u = user();
    if (u && u.role === 'admin') {
      el.textContent = '∞';
      document.getElementById('balanceAdmin').textContent = 'Admin — sem débito de créditos';
    }
    renderTransactions(r.data.transactions || []);
  }

  function renderTransactions(txs) {
    var box = document.getElementById('transactions');
    if (!txs.length) { box.innerHTML = '<p class="muted">Nenhuma movimentação ainda.</p>'; return; }
    box.innerHTML = txs.map(function (t) {
      var cls = t.credits >= 0 ? 'pos' : 'neg';
      var sign = t.credits >= 0 ? '+' : '';
      var when = '<div class="when">' + dateTime(t.createdAt) + '</div>';
      var desc = '<div class="desc">' + (t.description || t.type) + '</div>';
      var delta = '<div class="delta ' + cls + '">' + sign + fmt(t.credits) + ' cr</div>';
      var bal = '<div class="bal">saldo ' + fmt(t.balanceAfter) + '</div>';
      return '<div class="tx">' + when + desc + delta + bal + '</div>';
    }).join('');
  }

  var AVULSO_CENTS = 16;
  async function loadPackages() {
    var r = await api('/api/credits/packages');
    if (!r.ok) {
      document.getElementById('packages').innerHTML = '<p class="muted">Falha ao carregar pacotes.</p>';
      return;
    }
    AVULSO_CENTS = r.data.avulsoPriceCents || AVULSO_CENTS;
    document.getElementById('avulsoNote').textContent =
      'Crédito avulso: ' + money(AVULSO_CENTS) + ' por crédito.';
    var packs = r.data.packages || [];
    var box = document.getElementById('packages');
    if (!packs.length) { box.innerHTML = '<p class="muted">Nenhum pacote disponível.</p>'; return; }
    box.innerHTML = packs.map(function (p, idx) {
      var ppc = money(Math.round(p.pricePerCredit));
      var rec = idx === 1 ? 'recommended' : '';
      var badge = idx === 1 ? '<span class="badge">Mais vendido</span>' : '';
      return ''
        + '<div class="pack-card ' + rec + '" data-slug="' + p.slug + '">' + badge
        + '  <span class="name">' + p.name + '</span>'
        + '  <span class="credits">' + fmt(p.credits) + ' cr</span>'
        + '  <span class="price">' + money(p.priceCents) + '</span>'
        + '  <span class="ppc">' + ppc + ' / crédito</span>'
        + '  <button type="button" data-slug="' + p.slug + '">Comprar agora</button>'
        + '</div>';
    }).join('');
    box.querySelectorAll('button[data-slug]').forEach(function (btn) {
      btn.addEventListener('click', function () { startCheckout({ packageSlug: btn.getAttribute('data-slug') }, btn); });
    });
  }

  async function loadFeatureCosts() {
    var r = await api('/api/credits/feature-costs');
    var box = document.getElementById('featureCosts');
    if (!r.ok || !(r.data.costs || []).length) {
      box.innerHTML = '<p class="muted">Sem dados.</p>'; return;
    }
    box.innerHTML = r.data.costs.map(function (c) {
      return ''
        + '<div class="cost-card">'
        + '  <div><div class="lbl">' + c.label + '</div><div class="cat">' + (c.category || '') + '</div></div>'
        + '  <div class="val">' + fmt(c.cost_credits) + ' cr</div>'
        + '</div>';
    }).join('');
  }

  function bindCustom() {
    var input = document.getElementById('customCredits');
    var price = document.getElementById('customPrice');
    function recalc() {
      var n = parseInt(input.value || '0', 10);
      if (!n || n <= 0) { price.textContent = '—'; return; }
      price.textContent = money(n * AVULSO_CENTS);
    }
    input.addEventListener('input', recalc);
    document.getElementById('buyCustomBtn').addEventListener('click', function (ev) {
      var btn = ev.currentTarget;
      var n = parseInt(input.value || '0', 10);
      if (!n || n < 100) { alert('Mínimo de 100 créditos.'); return; }
      startCheckout({ customCredits: n }, btn);
    });
  }

  async function startCheckout(body, btn) {
    if (btn) { btn.disabled = true; var oldText = btn.textContent; btn.textContent = 'Abrindo checkout…'; }
    var r = await api('/api/credits/checkout', { method: 'POST', body: JSON.stringify(body) });
    if (btn) { btn.disabled = false; btn.textContent = oldText || 'Comprar'; }
    if (!r.ok) { alert(r.data.error || 'Falha ao iniciar checkout.'); return; }
    if (r.data.checkoutUrl) {
      location.href = r.data.checkoutUrl;
    } else {
      alert('URL de checkout não retornada.');
    }
  }

  document.getElementById('logoutBtn').addEventListener('click', function () {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    location.href = '/';
  });

  if (!gate()) return;
  handlePaymentReturn();
  loadBalance();
  loadPackages();
  loadFeatureCosts();
  bindCustom();
  // Atualiza saldo automaticamente após retornar do MP
  setInterval(loadBalance, 15000);
})();
