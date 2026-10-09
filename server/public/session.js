/**
 * Session handling for the legacy staff pages (dashboard.html, admin.html).
 *
 * The shared front-desk token is gone: these pages now sit behind a personal
 * login. This script, loaded before the page's own script, does four things:
 *
 *   1. Resolves WHO is signed in (GET /api/auth/me) and exposes it as NW.me.
 *      Not signed in, or a sign-in step still outstanding (password change,
 *      MFA) → redirect to the staff app's login, which handles every step.
 *   2. Adds the CSRF token to every state-changing /api request, and sends the
 *      user to login on any 401 — so each page's own code needs no auth logic.
 *   3. Tells the server a PERSON is present. The server's 15-minute idle clock
 *      deliberately ignores GET requests (the grid polls itself every 30 s and
 *      must not keep an unattended screen signed in), so real input events
 *      trigger a ping instead.
 *   4. Warns at 14 minutes of inactivity and signs out at 15.
 *
 * A page declares who may use it:  <body data-roles="FRONT_DESK,ADMIN">
 */
(function () {
  'use strict';

  var LOGIN = '/app/login';
  var WARN_AFTER_MS = 14 * 60 * 1000;
  var SIGN_OUT_AFTER_MS = 15 * 60 * 1000;
  var PING_EVERY_MS = 60 * 1000;

  var nw = { me: null, csrf: null };
  window.NW = nw;

  function toLogin(reason) {
    var next = location.pathname + location.search;
    location.href = LOGIN + '?next=' + encodeURIComponent(next) + (reason ? '&reason=' + reason : '');
  }

  // ---- fetch wrapper: CSRF header out, 401 → login ------------------------
  var rawFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    init = init || {};
    var url = typeof input === 'string' ? input : input.url;
    var method = String(init.method || (typeof input !== 'string' && input.method) || 'GET').toUpperCase();
    var isApi = url.indexOf('/api/') === 0 || url.indexOf(location.origin + '/api/') === 0;

    if (isApi && method !== 'GET' && nw.csrf) {
      var headers = new Headers(init.headers || {});
      headers.set('x-csrf-token', nw.csrf);
      init = Object.assign({}, init, { headers: headers });
    }
    return rawFetch(input, init).then(function (res) {
      if (isApi && res.status === 401 && url.indexOf('/api/auth/') === -1) {
        res.clone().json().then(function (b) { toLogin(b && b.code === 'idle_timeout' ? 'idle' : ''); }).catch(function () { toLogin(''); });
      }
      return res;
    });
  };

  // ---- who am I -----------------------------------------------------------
  nw.ready = rawFetch('/api/auth/me').then(function (res) {
    if (res.status === 401) { return res.json().then(function (b) { toLogin(b && b.code === 'idle_timeout' ? 'idle' : ''); return new Promise(function () {}); }); }
    return res.json();
  }).then(function (me) {
    if (me.needs && me.needs.length) { toLogin(''); return new Promise(function () {}); }
    nw.me = me.account;
    nw.csrf = me.csrfToken;

    var allowed = (document.body.getAttribute('data-roles') || '').split(',').filter(Boolean);
    if (allowed.length && !allowed.some(function (r) { return me.account.roles.indexOf(r) !== -1; })) {
      document.body.innerHTML = '<div style="max-width:420px;margin:90px auto;padding:0 20px;font-family:sans-serif">'
        + '<h2>Not available to your role</h2><p>Your account (' + esc(me.account.displayName)
        + ') does not have access to this page.</p><p><a href="/app">Back to the staff app</a></p></div>';
      return new Promise(function () {}); // never resolves: the page's own script must not start
    }
    startIdleWatch();
    return nw;
  });

  nw.logout = function () {
    return rawFetch('/api/auth/logout', { method: 'POST', headers: { 'x-csrf-token': nw.csrf || '' } })
      .finally(function () { location.href = LOGIN; });
  };

  nw.hasRole = function () {
    var want = [].slice.call(arguments);
    return !!nw.me && want.some(function (r) { return nw.me.roles.indexOf(r) !== -1; });
  };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }

  // ---- idle watch ---------------------------------------------------------
  function startIdleWatch() {
    var lastInput = Date.now();
    var lastPing = Date.now();
    var bar = null;

    ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click'].forEach(function (ev) {
      window.addEventListener(ev, function () {
        // Once the warning is up, a stray mouse movement must not silently
        // cancel it — only an explicit "stay signed in" does.
        if (!bar) lastInput = Date.now();
      }, { passive: true });
    });

    function ping() {
      lastPing = Date.now();
      return rawFetch('/api/auth/ping', { method: 'POST', headers: { 'x-csrf-token': nw.csrf } })
        .then(function (r) { if (r.status === 401) toLogin('idle'); });
    }

    function showWarning(secondsLeft) {
      if (!bar) {
        bar = document.createElement('div');
        bar.setAttribute('role', 'alert');
        bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#7a4a1c;color:#fff;'
          + 'padding:10px 16px;font:14px sans-serif;display:flex;gap:14px;align-items:center;justify-content:center';
        bar.innerHTML = '<span></span><button style="padding:5px 12px;border:0;border-radius:5px;cursor:pointer">Stay signed in</button>';
        bar.querySelector('button').addEventListener('click', function () {
          lastInput = Date.now();
          bar.remove(); bar = null;
          ping();
        });
        document.body.appendChild(bar);
      }
      var m = Math.floor(secondsLeft / 60), s = secondsLeft % 60;
      bar.querySelector('span').textContent = 'You will be signed out in ' + m + ':' + (s < 10 ? '0' : '') + s + ' because of inactivity.';
    }

    setInterval(function () {
      var idle = Date.now() - lastInput;
      if (idle >= SIGN_OUT_AFTER_MS) { nw.logout(); return; }
      if (idle >= WARN_AFTER_MS) { showWarning(Math.max(0, Math.round((SIGN_OUT_AFTER_MS - idle) / 1000))); return; }
      // A person was active since the last ping → tell the server.
      if (lastInput > lastPing && Date.now() - lastPing >= PING_EVERY_MS) ping();
    }, 1000);
  }
})();
