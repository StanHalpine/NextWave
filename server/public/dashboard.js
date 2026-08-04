/**
 * Front desk master resource grid.
 *
 * Hand-built rather than FullCalendar: the Resource TimeGrid view that draws
 * room columns is a paid FullCalendar Premium plugin, and this view is narrow
 * enough (fixed columns, fixed 15-minute rows, one day at a time) that owning
 * the ~200 lines beats a licence and a dependency.
 *
 * Layout: one absolutely-positioned block per booking inside a per-room lane.
 * Vertical position is minutes-since-open x pixels-per-minute, so a block lines
 * up with the tick rows without needing a row per booking.
 */

(function () {
  'use strict';

  var TOKEN_KEY = 'nw.frontDeskToken';
  var ROW_H = 22;   // must match --row-h
  var STEP = 15;    // minutes per row
  var PX_PER_MIN = ROW_H / STEP;

  var state = { date: null, data: null, pending: [] };

  var $ = function (id) { return document.getElementById(id); };

  // ---- token -------------------------------------------------------------

  function token() { return localStorage.getItem(TOKEN_KEY) || ''; }

  function api(path, opts) {
    opts = opts || {};
    var headers = opts.headers || {};
    headers['x-front-desk-token'] = token();
    if (opts.body) headers['content-type'] = 'application/json';
    return fetch(path, Object.assign({}, opts, { headers: headers })).then(function (r) {
      if (r.status === 401) { signOut('Session rejected — sign in again.'); throw new Error('unauthorised'); }
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body.error || ('HTTP ' + r.status));
        return body;
      });
    });
  }

  function signOut(msg) {
    localStorage.removeItem(TOKEN_KEY);
    $('app').hidden = true;
    $('gate').hidden = false;
    if (msg) { $('gate-err').textContent = msg; $('gate-err').hidden = false; }
  }

  // ---- helpers -----------------------------------------------------------

  function toast(msg, isErr) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.className = 'toast'; }, 3200);
  }

  function hhmmToMin(s) {
    var p = s.split(':');
    return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
  }

  /** Wall-clock minutes past midnight for an instant, in the clinic's zone. */
  function localMinutes(iso, tz) {
    var parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(new Date(iso));
    var h = 0, m = 0;
    parts.forEach(function (p) {
      if (p.type === 'hour') h = parseInt(p.value, 10);
      if (p.type === 'minute') m = parseInt(p.value, 10);
    });
    return h * 60 + m;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function shiftDate(iso, days) {
    var d = new Date(iso + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  // ---- grid --------------------------------------------------------------

  function renderGrid() {
    var d = state.data;
    var grid = $('grid');
    var empty = $('grid-empty');
    grid.innerHTML = '';

    if (d.closed) {
      grid.hidden = true;
      empty.hidden = false;
      empty.textContent = 'The clinic is closed on this day.';
      return;
    }
    grid.hidden = false;
    empty.hidden = true;

    var openMin = hhmmToMin(d.open);
    var closeMin = hhmmToMin(d.close);

    // Resolve every booking to local minutes up front, because the drawn
    // window depends on them.
    d.bookings.forEach(function (b) {
      b._s = localMinutes(b.start, d.timezone);
      b._e = localMinutes(b.end, d.timezone);
      if (b._e <= b._s) b._e = 24 * 60; // ran past midnight; clamp to end of day
    });

    // The grid spans clinic hours UNION every booking on the day. A booking
    // outside opening hours — after an hours change, a timezone correction, or
    // a manual entry — must never be positioned off-grid where the front desk
    // cannot see it. Widening is always safe; hiding is not.
    var winStart = openMin;
    var winEnd = closeMin;
    d.bookings.forEach(function (b) {
      if (b._s < winStart) winStart = b._s;
      if (b._e + b.bufferMin > winEnd) winEnd = b._e + b.bufferMin;
    });
    winStart = Math.floor(winStart / STEP) * STEP;
    winEnd = Math.ceil(winEnd / STEP) * STEP;

    var outside = d.bookings.filter(function (b) {
      return b._s < openMin || b._e > closeMin;
    }).length;

    var rows = Math.ceil((winEnd - winStart) / STEP);

    // Time gutter.
    var gutter = document.createElement('div');
    gutter.className = 'col gutter';
    gutter.innerHTML = '<div class="col-head"><span class="name">Time</span>'
      + '<span class="type">' + esc(d.date) + '</span></div>';
    var gLane = document.createElement('div');
    gLane.className = 'lane';
    for (var i = 0; i < rows; i++) {
      var min = winStart + i * STEP;
      var isHour = min % 60 === 0;
      var shut = min < openMin || min >= closeMin;
      var tick = document.createElement('div');
      tick.className = 'tick' + (isHour ? ' hour' : '') + (shut ? ' closed' : '');
      tick.innerHTML = '<span class="label">'
        + String(Math.floor(min / 60)).padStart(2, '0') + ':'
        + String(min % 60).padStart(2, '0') + '</span>';
      gLane.appendChild(tick);
    }
    gutter.appendChild(gLane);
    grid.appendChild(gutter);

    if (outside) {
      toast(outside + ' booking' + (outside > 1 ? 's fall' : ' falls')
        + ' outside clinic hours — shown in the shaded rows.', true);
    }

    // Bucket bookings by room.
    var byRoom = {};
    d.bookings.forEach(function (b) {
      (byRoom[b.resourceId] = byRoom[b.resourceId] || []).push(b);
    });

    d.resources.forEach(function (room) {
      var col = document.createElement('div');
      col.className = 'col';
      col.innerHTML = '<div class="col-head"><span class="name">' + esc(room.name) + '</span>'
        + '<span class="type">' + esc(room.type)
        + (room.maxCapacity > 1 ? ' · cap ' + room.maxCapacity : '') + '</span></div>';

      var lane = document.createElement('div');
      lane.className = 'lane';
      lane.style.height = rows * ROW_H + 'px';

      for (var r = 0; r < rows; r++) {
        var rowMin = winStart + r * STEP;
        var s = document.createElement('div');
        s.className = 'slot' + (rowMin % 60 === 0 ? ' hour' : '')
          + (rowMin < openMin || rowMin >= closeMin ? ' closed' : '');
        lane.appendChild(s);
      }

      var events = byRoom[room.id] || [];

      // Side-by-side lanes when a multi-capacity room runs concurrent patients.
      // (_s / _e were resolved above, since the window depends on them.)
      var lanes = [];
      events.forEach(function (b) {
        var idx = 0;
        while (lanes[idx] != null && lanes[idx] > b._s) idx++;
        lanes[idx] = b._e + b.bufferMin;
        b._lane = idx;
      });
      var laneCount = Math.max(1, lanes.length);

      events.forEach(function (b) {
        var top = (b._s - winStart) * PX_PER_MIN;
        var h = Math.max(ROW_H - 2, (b._e - b._s) * PX_PER_MIN - 2);
        var widthPct = 100 / laneCount;
        var leftPct = b._lane * widthPct;

        if (b.bufferMin > 0) {
          var buf = document.createElement('div');
          buf.className = 'buf';
          buf.style.top = (top + h + 2) + 'px';
          buf.style.height = Math.max(3, b.bufferMin * PX_PER_MIN - 2) + 'px';
          buf.style.left = 'calc(' + leftPct + '% + 3px)';
          buf.style.width = 'calc(' + widthPct + '% - 6px)';
          lane.appendChild(buf);
        }

        var el = document.createElement('div');
        el.className = 'ev ev-' + b.status;
        el.style.top = top + 'px';
        el.style.height = h + 'px';
        el.style.left = 'calc(' + leftPct + '% + 3px)';
        el.style.width = 'calc(' + widthPct + '% - 6px)';
        // Short bookings (a 15-minute slot is ~20px) fit one line only. The
        // service name earns that line — the start time is already implied by
        // where the block sits against the gutter.
        if (h < 30) {
          el.classList.add('ev-compact');
          el.innerHTML = '<div class="s">' + esc(b.service) + '</div>';
        } else if (h < 52) {
          el.innerHTML = '<div class="s">' + esc(b.service) + '</div>'
            + '<div class="t">' + esc(b.localStart) + '–' + esc(b.localEnd) + '</div>';
        } else {
          el.innerHTML = '<div class="t">' + esc(b.localStart) + '–' + esc(b.localEnd) + '</div>'
            + '<div class="s">' + esc(b.service) + '</div>'
            + '<div class="p">' + esc(b.patient) + '</div>';
        }
        if (b.noteCount > 0) el.classList.add('has-notes');
        if (b.patientNote) el.classList.add('has-patient-note');
        el.title = b.service + (b.subOption ? ' (' + b.subOption + ')' : '')
          + (b.patientNote ? '\nPatient note: ' + b.patientNote : '')
          + (b.noteCount ? '\n' + b.noteCount + ' clinical note(s)' : '')
          + '\n' + b.patient + '\n' + b.localStart + '–' + b.localEnd
          + '\n' + b.status;
        el.addEventListener('click', function () { openDetail(b); });
        lane.appendChild(el);
      });

      col.appendChild(lane);
      grid.appendChild(col);
    });
  }

  // ---- pending queue -----------------------------------------------------

  function renderPending() {
    var box = $('pending');
    if (!state.pending.length) {
      box.innerHTML = '<p class="hint">Nothing waiting. All caught up.</p>';
      return;
    }
    box.innerHTML = '';
    state.pending.forEach(function (b) {
      var card = document.createElement('div');
      card.className = 'pending-card';
      card.innerHTML =
        '<div class="when">' + esc(b.start.slice(0, 10)) + ' · ' + esc(b.localStart) + '</div>'
        + '<div class="svc">' + esc(b.service) + (b.subOption ? ' — ' + esc(b.subOption) : '') + '</div>'
        + '<div class="who">' + esc(b.patient) + '</div>'
        + '<div class="meta">' + esc(b.resource) + (b.staff ? ' · ' + esc(b.staff) : '') + '</div>'
        + '<div class="meta">' + esc(b.phone) + ' · ' + esc(b.email) + '</div>';

      var actions = document.createElement('div');
      actions.className = 'actions';

      var ok = document.createElement('button');
      ok.className = 'btn btn-approve';
      ok.textContent = 'Approve';
      ok.addEventListener('click', function () { decide(b.id, 'CONFIRMED', ok); });

      var no = document.createElement('button');
      no.className = 'btn btn-decline';
      no.textContent = 'Decline';
      no.addEventListener('click', function () { decide(b.id, 'DECLINED', no); });

      actions.appendChild(ok);
      actions.appendChild(no);
      card.appendChild(actions);
      box.appendChild(card);
    });
  }

  function decide(id, status, btn) {
    if (btn) btn.disabled = true;
    api('/api/bookings/' + id, { method: 'PATCH', body: JSON.stringify({ status: status }) })
      .then(function () {
        toast(status === 'CONFIRMED' ? 'Booking confirmed.' : 'Booking declined.');
        var dlg = $('detail');
        if (dlg.open) dlg.close();
        return load();
      })
      .catch(function (e) {
        toast(e.message, true);
        if (btn) btn.disabled = false;
      });
  }

  // ---- detail dialog -----------------------------------------------------

  function openDetail(b) {
    $('d-title').textContent = b.service + (b.subOption ? ' — ' + b.subOption : '');
    var rows = [
      ['Status', b.status],
      ['When', b.localStart + '–' + b.localEnd],
      ['Room', b.resource || ''],
      ['Provider', b.staff || '—'],
      ['Patient', b.patient],
      ['Phone', b.phone],
      ['Email', b.email],
      ['Buffer', b.bufferMin + ' min turnaround'],
    ];
    if (b.isRecurring) rows.push(['Recurring', 'Yes']);
    if (b.holdExpiresAt) rows.push(['Hold until', new Date(b.holdExpiresAt).toLocaleTimeString()]);

    $('d-fields').innerHTML = rows.map(function (r) {
      return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>';
    }).join('');

    renderNotes(b);

    var acts = $('d-actions');
    acts.innerHTML = '';
    var add = function (label, cls, status) {
      var btn = document.createElement('button');
      btn.className = 'btn ' + cls;
      btn.textContent = label;
      btn.addEventListener('click', function () { decide(b.id, status, btn); });
      acts.appendChild(btn);
    };
    if (b.status === 'PENDING_REVIEW') {
      add('Approve', 'btn-approve', 'CONFIRMED');
      add('Decline', 'btn-decline', 'DECLINED');
    } else if (b.status === 'CONFIRMED' || b.status === 'HOLD') {
      add('Cancel booking', 'btn-decline', 'CANCELLED');
    }
    var close = document.createElement('button');
    close.className = 'btn';
    close.textContent = 'Close';
    close.addEventListener('click', function () { $('detail').close(); });
    acts.appendChild(close);

    $('detail').showModal();
  }

  // ---- clinical notes ----------------------------------------------------

  var staffCache = null;

  function loadStaff() {
    if (staffCache) return Promise.resolve(staffCache);
    return api('/api/front-desk/staff').then(function (r) {
      staffCache = r.staff;
      return staffCache;
    });
  }

  /**
   * Notes panel inside the booking dialog. Clinical notes are only offered on
   * a visit that actually happened — the API refuses them on HOLD and
   * PENDING_REVIEW, so the UI does not pretend otherwise.
   */
  function renderNotes(b) {
    var box = $('d-notes');
    box.innerHTML = '<p class="note-loading">Loading notes…</p>';

    var clinical = b.status === 'CONFIRMED' || b.status === 'CANCELLED';

    Promise.all([api('/api/bookings/' + b.id + '/notes'), clinical ? loadStaff() : []])
      .then(function (res) {
        var data = res[0];
        var staff = res[1];
        box.innerHTML = '';

        if (data.patientNote) {
          var pn = document.createElement('div');
          pn.className = 'patient-note';
          pn.innerHTML = '<span class="eyebrow">From the patient</span><p>'
            + esc(data.patientNote) + '</p>';
          box.appendChild(pn);
        }

        var head = document.createElement('div');
        head.className = 'notes-head';
        head.innerHTML = '<span class="eyebrow">Clinical notes</span>';
        box.appendChild(head);

        if (!data.notes.length) {
          var none = document.createElement('p');
          none.className = 'note-empty';
          none.textContent = clinical
            ? 'No clinical notes yet.'
            : 'Clinical notes open once the visit is confirmed.';
          box.appendChild(none);
        }

        data.notes.forEach(function (n) { box.appendChild(noteEl(n, b)); });

        if (clinical) box.appendChild(composer(b, staff));
      })
      .catch(function (e) {
        box.innerHTML = '<p class="note-empty">Could not load notes: ' + esc(e.message) + '</p>';
      });
  }

  function noteEl(n, b) {
    var el = document.createElement('div');
    el.className = 'note';
    el.innerHTML =
      '<div class="note-meta"><span class="note-kind">' + esc(n.kind) + '</span>'
      + esc(n.author.name) + ' · ' + new Date(n.createdAt).toLocaleString()
      + (n.amended ? ' <span class="note-amended">amended</span>' : '') + '</div>'
      + '<div class="note-body">' + esc(n.body) + '</div>';

    if (n.amended) {
      var toggle = document.createElement('button');
      toggle.className = 'note-history-toggle';
      toggle.textContent = 'Show ' + n.history.length + ' earlier version'
        + (n.history.length > 1 ? 's' : '');
      var hist = document.createElement('div');
      hist.className = 'note-history';
      hist.hidden = true;
      n.history.forEach(function (h) {
        var hv = document.createElement('div');
        hv.className = 'note-old';
        hv.innerHTML = '<div class="note-meta">' + esc(h.author.name) + ' · '
          + new Date(h.createdAt).toLocaleString() + '</div>'
          + '<div class="note-body">' + esc(h.body) + '</div>'
          + (h.amendReason ? '<div class="note-reason">Amended: ' + esc(h.amendReason) + '</div>' : '');
        hist.appendChild(hv);
      });
      toggle.addEventListener('click', function () {
        hist.hidden = !hist.hidden;
        toggle.textContent = (hist.hidden ? 'Show ' : 'Hide ') + n.history.length
          + ' earlier version' + (n.history.length > 1 ? 's' : '');
      });
      el.appendChild(toggle);
      el.appendChild(hist);
    }

    var amend = document.createElement('button');
    amend.className = 'note-amend-btn';
    amend.textContent = 'Amend';
    amend.addEventListener('click', function () { amendForm(n, b, el); });
    el.appendChild(amend);
    return el;
  }

  /** Amending never edits in place — it posts a new version. */
  function amendForm(n, b, anchor) {
    if (anchor.querySelector('.amend-form')) return;
    var f = document.createElement('div');
    f.className = 'amend-form';
    f.innerHTML =
      '<textarea class="note-input" rows="3">' + esc(n.body) + '</textarea>'
      + '<input class="note-reason-input" placeholder="Why is this being amended? (required)">'
      + '<select class="note-author"></select>';
    var actions = document.createElement('div');
    actions.className = 'note-actions';

    var save = document.createElement('button');
    save.className = 'btn btn-approve';
    save.textContent = 'Save amendment';
    var cancel = document.createElement('button');
    cancel.className = 'btn';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', function () { f.remove(); });
    actions.appendChild(save);
    actions.appendChild(cancel);
    f.appendChild(actions);
    anchor.appendChild(f);

    loadStaff().then(function (staff) { fillStaff(f.querySelector('.note-author'), staff); });

    save.addEventListener('click', function () {
      var body = f.querySelector('.note-input').value.trim();
      var reason = f.querySelector('.note-reason-input').value.trim();
      var authorId = f.querySelector('.note-author').value;
      if (!body) return toast('An amended note cannot be empty.', true);
      if (!reason) return toast('An amendment must say why.', true);
      save.disabled = true;
      api('/api/visit-notes/' + n.id + '/amend', {
        method: 'POST',
        body: JSON.stringify({ authorId: authorId, body: body, amendReason: reason }),
      }).then(function () {
        toast('Amendment saved. The original is preserved.');
        renderNotes(b);
        load();
      }).catch(function (e) { toast(e.message, true); save.disabled = false; });
    });
  }

  function composer(b, staff) {
    var f = document.createElement('div');
    f.className = 'note-composer';
    f.innerHTML =
      '<select class="note-kind-select">'
      + ['SUBJECTIVE', 'OBJECTIVE', 'ASSESSMENT', 'PLAN', 'GENERAL'].map(function (k) {
          return '<option value="' + k + '"' + (k === 'GENERAL' ? ' selected' : '') + '>' + k + '</option>';
        }).join('')
      + '</select><select class="note-author"></select>'
      + '<textarea class="note-input" rows="3" placeholder="Clinical note for this visit…"></textarea>';

    var actions = document.createElement('div');
    actions.className = 'note-actions';
    var add = document.createElement('button');
    add.className = 'btn btn-approve';
    add.textContent = 'Add note';
    actions.appendChild(add);
    f.appendChild(actions);

    fillStaff(f.querySelector('.note-author'), staff, b.staff);

    add.addEventListener('click', function () {
      var body = f.querySelector('.note-input').value.trim();
      if (!body) return toast('A note cannot be empty.', true);
      add.disabled = true;
      api('/api/bookings/' + b.id + '/notes', {
        method: 'POST',
        body: JSON.stringify({
          authorId: f.querySelector('.note-author').value,
          kind: f.querySelector('.note-kind-select').value,
          body: body,
        }),
      }).then(function () {
        toast('Note added.');
        renderNotes(b);
        load();
      }).catch(function (e) { toast(e.message, true); add.disabled = false; });
    });

    return f;
  }

  /** Default the author to the provider who ran the visit, when we know them. */
  function fillStaff(sel, staff, preferName) {
    sel.innerHTML = staff.map(function (s) {
      return '<option value="' + esc(s.id) + '"'
        + (preferName && s.name === preferName ? ' selected' : '')
        + '>' + esc(s.name) + '</option>';
    }).join('');
  }

  // ---- load --------------------------------------------------------------

  function load() {
    var date = state.date;
    return Promise.all([
      api('/api/front-desk/schedule?date=' + date),
      api('/api/front-desk/pending'),
    ]).then(function (res) {
      state.data = res[0];
      state.pending = res[1].bookings;
      $('tz').textContent = res[0].timezone;
      renderGrid();
      renderPending();
    }).catch(function (e) {
      if (e.message !== 'unauthorised') toast(e.message, true);
    });
  }

  function setDate(d) {
    state.date = d;
    $('date').value = d;
    load();
  }

  // ---- boot --------------------------------------------------------------

  function start() {
    $('gate').hidden = true;
    $('app').hidden = false;
    var today = new Date().toISOString().slice(0, 10);
    setDate(today);
  }

  $('gate-go').addEventListener('click', function () {
    var v = $('gate-token').value.trim();
    if (!v) return;
    localStorage.setItem(TOKEN_KEY, v);
    api('/api/front-desk/pending').then(start).catch(function () { /* signOut already ran */ });
  });
  $('gate-token').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('gate-go').click();
  });

  $('prev').addEventListener('click', function () { setDate(shiftDate(state.date, -1)); });
  $('next').addEventListener('click', function () { setDate(shiftDate(state.date, 1)); });
  $('today').addEventListener('click', function () { setDate(new Date().toISOString().slice(0, 10)); });
  $('date').addEventListener('change', function (e) { setDate(e.target.value); });
  $('refresh').addEventListener('click', load);
  $('signout').addEventListener('click', function () { signOut(null); });

  // Keep the grid honest while it sits open on the front desk screen.
  setInterval(function () { if (!$('app').hidden) load(); }, 30000);

  if (token()) {
    api('/api/front-desk/pending').then(start).catch(function () { /* gate shown */ });
  } else {
    $('gate').hidden = false;
  }
})();
