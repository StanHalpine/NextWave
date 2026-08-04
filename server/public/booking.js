/**
 * Patient booking flow.
 *
 * Service → day → slot → hold → details → request. The hold is taken the
 * moment a slot is picked, so the patient is filling the form against a slot
 * that is genuinely reserved rather than racing other patients for it.
 *
 * The hold id doubles as the session token (spec §4.2). It lives in
 * localStorage with its expiry so a refresh mid-form resumes rather than
 * abandoning the slot.
 */

(function () {
  'use strict';

  var HOLD_KEY = 'nw.booking.hold';

  var state = {
    services: [], service: null, date: null, slot: null, hold: null, timer: null,
    // Specific panel / shot chosen on a card, e.g. "Vitamin B12". Arrives via
    // ?option= and is stored on Booking.subOption so the front desk knows
    // which one was requested rather than just the parent service.
    subOption: null,
  };

  var $ = function (id) { return document.getElementById(id); };

  function api(path, opts) {
    opts = opts || {};
    var headers = {};
    if (opts.body) headers['content-type'] = 'application/json';
    return fetch(path, Object.assign({}, opts, { headers: headers })).then(function (r) {
      if (r.status === 204) return null;
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body.error || ('Something went wrong (' + r.status + ')'));
        return body;
      });
    });
  }

  function toast(msg, isErr) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.className = 'toast'; }, 3600);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function show(id, on) { $(id).hidden = !on; }

  function slug(s) { return s.toLowerCase().replace(/[^a-z]+/g, '-'); }

  /**
   * "14:30" → "2:30 PM". The API returns clinic-local wall time in 24-hour
   * form; patients read 12-hour. Formatting here rather than server-side keeps
   * the API unambiguous — the front desk grid deliberately stays on 24-hour,
   * where it is denser and staff are used to it.
   */
  function ampm(hhmm) {
    var p = hhmm.split(':');
    var h = parseInt(p[0], 10);
    var suffix = h < 12 ? 'AM' : 'PM';
    var h12 = h % 12;
    if (h12 === 0) h12 = 12;
    return h12 + ':' + p[1] + ' ' + suffix;
  }

  // ---- step 1: services --------------------------------------------------

  function loadServices() {
    api('/api/services').then(function (r) {
      state.services = r.services;
      var groups = {};
      r.services.forEach(function (s) { (groups[s.category] = groups[s.category] || []).push(s); });

      var box = $('service-groups');
      box.innerHTML = '';
      // Fixed order — the practice is organised around these three disciplines.
      ['Chiropractic', 'Functional Medicine', 'Longevity'].forEach(function (cat) {
        if (!groups[cat]) return;
        var g = document.createElement('div');
        g.className = 'service-group g-' + slug(cat);
        g.innerHTML = '<h3>' + esc(cat) + '</h3>';
        var list = document.createElement('div');
        list.className = 'service-list';
        groups[cat].forEach(function (s) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'service-btn';
          b.dataset.slug = s.slug;
          b.innerHTML = esc(s.name) + '<span class="dur">' + s.durationMin + ' min</span>';
          b.addEventListener('click', function () { pickService(s); });
          list.appendChild(b);
        });
        g.appendChild(list);
        box.appendChild(g);
      });
      applyDeepLink();
    }).catch(function (e) {
      $('service-groups').innerHTML = '<p class="muted">Could not load services: ' + esc(e.message) + '</p>';
    });
  }

  function pickService(s) {
    state.service = s;
    state.slot = null;
    [].forEach.call(document.querySelectorAll('.service-btn'), function (b) {
      b.classList.toggle('sel', b.dataset.slug === s.slug);
    });

    show('step-date', true);
    show('step-time', false);
    buildDays();
    $('step-date').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ---- deep link: "Book now" on a service page -----------------------

  /**
   * `?service=<slug>` arrives from a marketing page's "Book now" button —
   * see services/manual-adjustment.html. The slug matches the page's own
   * filename (spec §9), same convention the contact form already uses for
   * `?interest=`.
   *
   * Locks the flow to that service and skips straight to picking a day,
   * rather than making a patient who already told us what they want re-pick
   * it from a list of fifteen.
   */
  function applyDeepLink() {
    var params = new URLSearchParams(location.search);
    var wanted = params.get('service');
    if (!wanted) return;

    // ?option= names a specific panel or shot chosen from a card on the
    // service page (biomarker-testing, vitamin-shots). Trimmed and length-
    // capped to match the server's own validation on subOption.
    var opt = (params.get('option') || '').trim();
    state.subOption = opt ? opt.slice(0, 120) : null;

    var matches = state.services.filter(function (s) { return s.slug === wanted; });
    if (!matches.length) {
      toast('That service link looks out of date — choose from the list below.', true);
      state.subOption = null;
      return;
    }
    // A slug can map to more than one row (hyperbaric's 60/90-minute
    // variants share one page). Default to the shorter session; a future
    // `?duration=` param can disambiguate once that page is wired.
    matches.sort(function (a, b) { return a.durationMin - b.durationMin; });
    lockToService(matches[0]);
  }

  function lockToService(s) {
    pickService(s);
    show('service-groups', false);
    var box = $('service-locked');
    box.hidden = false;
    box.innerHTML =
      '<div class="locked-name">' + esc(s.name)
      + (state.subOption ? ' <span class="locked-option">' + esc(state.subOption) + '</span>' : '')
      + '</div>'
      + '<button type="button" class="locked-change" id="change-service-btn">Not what you meant? Choose a different service</button>';
    $('change-service-btn').addEventListener('click', function () {
      // Picking a different service invalidates the panel/shot that came with
      // the old one — carrying it over would mislabel the booking.
      state.subOption = null;
      box.hidden = true;
      show('service-groups', true);
    });
  }

  // ---- step 2: days ------------------------------------------------------

  /** Local calendar date string, avoiding the UTC shift toISOString() causes. */
  function localDateISO(d) {
    return d.getFullYear() + '-'
      + String(d.getMonth() + 1).padStart(2, '0') + '-'
      + String(d.getDate()).padStart(2, '0');
  }

  function buildDays() {
    var strip = $('day-strip');
    strip.innerHTML = '';
    var today = new Date();
    for (var i = 0; i < 14; i++) {
      var d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
      var iso = localDateISO(d);
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'day-btn' + (d.getDay() === 0 ? ' shut' : '');
      // Carry the date on the element. Deriving the index by date arithmetic
      // is off-by-one prone (a noon-vs-midnight comparison rounds up).
      b.dataset.date = iso;
      b.innerHTML = '<span class="dow">' + ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()] + '</span>'
        + '<span class="dnum">' + d.getDate() + '</span>';
      if (d.getDay() === 0) {
        b.disabled = true;
        b.title = 'Closed on Sundays';
      } else {
        b.addEventListener('click', pickDay.bind(null, iso));
      }
      strip.appendChild(b);
    }
    $('date-input').min = localDateISO(today);
  }

  function pickDay(iso) {
    state.date = iso;
    state.slot = null;
    $('date-input').value = iso;

    [].forEach.call(document.querySelectorAll('.day-btn'), function (b) {
      b.classList.toggle('sel', b.dataset.date === iso);
    });

    loadSlots();
  }

  // ---- step 3: slots -----------------------------------------------------

  function loadSlots() {
    show('step-time', true);
    var grid = $('slot-grid');
    grid.innerHTML = '';
    $('slot-note').textContent = 'Checking availability…';

    api('/api/availability?serviceId=' + encodeURIComponent(state.service.id)
        + '&date=' + encodeURIComponent(state.date))
      .then(function (d) {
        grid.innerHTML = '';
        if (!d.slots.length) {
          $('slot-note').textContent = d.closedReason || 'No times available on this day.';
          return;
        }
        $('slot-note').textContent = d.slots.length + ' open '
          + (d.slots.length === 1 ? 'time' : 'times') + ' · times shown in ' + d.timezone;

        d.slots.forEach(function (s) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'slot-btn';
          b.textContent = ampm(s.localTime);
          b.addEventListener('click', function () { takeHold(s, b); });
          grid.appendChild(b);
        });
      })
      .catch(function (e) {
        $('slot-note').textContent = e.message;
      });
    $('step-time').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ---- step 4: hold + details -------------------------------------------

  function takeHold(slot, btn) {
    [].forEach.call(document.querySelectorAll('.slot-btn'), function (b) { b.disabled = true; });
    btn.classList.add('sel');

    var payload = { serviceId: state.service.id, start: slot.start };
    if (state.subOption) payload.subOption = state.subOption;

    api('/api/holds', {
      method: 'POST',
      body: JSON.stringify(payload),
    }).then(function (h) {
      state.slot = slot;
      state.hold = h;
      localStorage.setItem(HOLD_KEY, JSON.stringify({ holdId: h.holdId, expiresAt: h.expiresAt }));
      enterDetails(h);
    }).catch(function (e) {
      toast(e.message, true);
      // Someone else took it — refresh rather than leaving a dead grid.
      loadSlots();
    });
  }

  function enterDetails(h) {
    show('step-details', true);
    show('step-time', false);
    show('step-date', false);
    show('step-service', false);

    // h.subOption comes back from the server, so what's shown is what was
    // actually stored — not the client's local copy of what it meant to send.
    $('summary').innerHTML =
      '<div class="svc">' + esc(h.service)
      + (h.subOption ? ' <span class="locked-option">' + esc(h.subOption) + '</span>' : '')
      + '</div>'
      + '<div class="when">' + esc(new Date(h.start).toLocaleString(undefined, {
          weekday: 'long', month: 'long', day: 'numeric',
          hour: 'numeric', minute: '2-digit',
        })) + '</div>'
      + '<div class="when">' + esc(h.resource) + (h.staff ? ' · ' + esc(h.staff) : '') + '</div>';

    startCountdown(new Date(h.expiresAt));
    $('step-details').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function startCountdown(expiresAt) {
    clearInterval(state.timer);
    var bar = $('hold-bar');

    function tick() {
      var left = Math.max(0, expiresAt - Date.now());
      var mins = Math.floor(left / 60000);
      var secs = Math.floor((left % 60000) / 1000);
      $('hold-clock').textContent = mins + ':' + String(secs).padStart(2, '0');

      bar.className = 'hold-bar' + (left <= 0 ? ' dead' : left < 120000 ? ' warn' : '');
      $('hold-text').textContent = left <= 0
        ? 'Your hold expired — the slot may have been taken.'
        : 'This slot is held for you';

      if (left <= 0) {
        clearInterval(state.timer);
        $('submit-btn').textContent = 'Try to submit anyway';
      }
    }
    tick();
    state.timer = setInterval(tick, 1000);
  }

  function clearHold() {
    clearInterval(state.timer);
    localStorage.removeItem(HOLD_KEY);
    state.hold = null;
  }

  $('release-btn').addEventListener('click', function () {
    if (!state.hold) return;
    var id = state.hold.holdId;
    clearHold();
    api('/api/holds/' + id, { method: 'DELETE' }).catch(function () { /* expiry handles it */ });
    toast('Slot released.');
    resetToStart();
  });

  $('details-form').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!state.hold) return;

    var f = e.target;
    var payload = {
      holdId: state.hold.holdId,
      name: f.name.value.trim(),
      email: f.email.value.trim(),
      phone: f.phone.value.trim(),
    };
    var note = f.patientNote.value.trim();
    if (note) payload.patientNote = note;

    var err = $('form-err');
    err.hidden = true;
    if (!payload.name || !payload.email || !payload.phone) {
      err.textContent = 'Name, email and phone are all required.';
      err.hidden = false;
      return;
    }

    $('submit-btn').disabled = true;
    api('/api/bookings', { method: 'POST', body: JSON.stringify(payload) })
      .then(function (b) {
        clearHold();
        show('step-details', false);
        show('step-done', true);
        $('done-detail').innerHTML = '<strong>' + esc(b.service)
          + (b.subOption ? ' — ' + esc(b.subOption) : '') + '</strong><br>'
          + esc(new Date(b.start).toLocaleString(undefined, {
              weekday: 'long', month: 'long', day: 'numeric',
              hour: 'numeric', minute: '2-digit',
            }));
        $('step-done').scrollIntoView({ behavior: 'smooth', block: 'start' });
      })
      .catch(function (e2) {
        err.textContent = e2.message;
        err.hidden = false;
        $('submit-btn').disabled = false;
      });
  });

  // ---- reset / resume ----------------------------------------------------

  function resetToStart() {
    clearHold();
    state.service = null; state.date = null; state.slot = null; state.subOption = null;
    show('step-service', true);
    show('step-date', false);
    show('step-time', false);
    show('step-details', false);
    show('step-done', false);
    [].forEach.call(document.querySelectorAll('.service-btn'), function (b) { b.classList.remove('sel'); });
    $('details-form').reset();
    $('submit-btn').disabled = false;
    $('submit-btn').textContent = 'Request appointment';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  $('again-btn').addEventListener('click', resetToStart);
  $('date-input').addEventListener('change', function (e) {
    if (e.target.value) pickDay(e.target.value);
  });

  /** A refresh mid-form should resume the hold, not silently drop it. */
  function resume() {
    var raw = localStorage.getItem(HOLD_KEY);
    if (!raw) return;
    var saved;
    try { saved = JSON.parse(raw); } catch (e) { localStorage.removeItem(HOLD_KEY); return; }

    api('/api/holds/' + saved.holdId).then(function (h) {
      if (!h.active) { localStorage.removeItem(HOLD_KEY); return; }
      state.hold = {
        holdId: h.holdId, expiresAt: h.expiresAt, start: h.start,
        service: h.service, resource: h.resource, staff: h.staff,
      };
      enterDetails(state.hold);
      toast('Resumed the slot you were holding.');
    }).catch(function () { localStorage.removeItem(HOLD_KEY); });
  }

  loadServices();
  resume();
})();
