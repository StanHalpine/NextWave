/**
 * Configuration screen — staff, shifts, rooms, service timings and prices.
 *
 * Every write here changes what patients can book, so the UI tries hard to
 * make consequences visible before they bite: a provider with no shifts is
 * flagged, a room type with nothing active is flagged, and the server's
 * refusals (lowering capacity under existing bookings) are surfaced verbatim
 * rather than reduced to "something went wrong".
 */

(function () {
  'use strict';

  var TOKEN_KEY = 'nw.frontDeskToken'; // shared with the front desk grid
  var DAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  var ROLES = [
    ['CHIROPRACTOR', 'Chiropractor'],
    ['NURSE_PRACTITIONER', 'Nurse Practitioner'],
    ['REGISTERED_NURSE', 'Registered Nurse'],
  ];

  var $ = function (id) { return document.getElementById(id); };

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

  function toast(msg, isErr) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(t._timer);
    // Server refusals explain a real constraint and are worth reading — give
    // them longer on screen than a success confirmation.
    t._timer = setTimeout(function () { t.className = 'toast'; }, isErr ? 7000 : 3000);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function money(cents) {
    if (cents == null) return '';
    return (cents / 100).toFixed(0);
  }

  // ---- tabs --------------------------------------------------------------

  [].forEach.call(document.querySelectorAll('.tab-btn'), function (b) {
    b.addEventListener('click', function () {
      [].forEach.call(document.querySelectorAll('.tab-btn'), function (x) {
        x.classList.toggle('active', x === b);
      });
      ['staff', 'rooms', 'services'].forEach(function (t) {
        $('tab-' + t).hidden = t !== b.dataset.tab;
      });
    });
  });

  // ---- staff -------------------------------------------------------------

  function loadStaff() {
    api('/api/admin/staff').then(function (r) {
      var box = $('staff-list');
      box.innerHTML = '';
      if (!r.staff.length) {
        box.appendChild(el('p', 'hint', 'No staff yet. Add someone to open up availability.'));
        return;
      }
      r.staff.forEach(function (s) { box.appendChild(staffCard(s)); });
    }).catch(function (e) { if (e.message !== 'unauthorised') toast(e.message, true); });
  }

  function staffCard(s) {
    var card = el('div', 'row-card' + (s.active ? '' : ' inactive'));

    var top = el('div', 'row-top');
    top.appendChild(el('span', 'row-name', esc(s.name)));
    top.appendChild(el('span', 'pill role', esc((ROLES.filter(function (r) { return r[0] === s.role; })[0] || [, s.role])[1])));
    if (!s.active) top.appendChild(el('span', 'pill off', 'INACTIVE'));
    top.appendChild(el('span', 'row-meta',
      s.schedules.length + ' shift' + (s.schedules.length === 1 ? '' : 's')
      + ' · ' + s.bookingCount + ' booking' + (s.bookingCount === 1 ? '' : 's')));

    var actions = el('div', 'row-actions');

    var edit = el('button', 'btn', 'Rename / role');
    edit.addEventListener('click', function () { toggleStaffEdit(card, s); });
    actions.appendChild(edit);

    var toggle = el('button', 'btn', s.active ? 'Deactivate' : 'Reactivate');
    toggle.addEventListener('click', function () {
      api('/api/admin/staff/' + s.id, { method: 'PATCH', body: JSON.stringify({ active: !s.active }) })
        .then(function () {
          toast(s.active ? s.name + ' deactivated — takes no new bookings.' : s.name + ' reactivated.');
          loadStaff();
        }).catch(function (e) { toast(e.message, true); });
    });
    actions.appendChild(toggle);

    var del = el('button', 'btn btn-decline', 'Remove');
    del.addEventListener('click', function () {
      api('/api/admin/staff/' + s.id, { method: 'DELETE' }).then(function (res) {
        // The server decides delete-vs-deactivate based on what history exists.
        toast(res.removed ? s.name + ' removed.' : res.reason, !res.removed);
        loadStaff();
      }).catch(function (e) { toast(e.message, true); });
    });
    actions.appendChild(del);

    top.appendChild(actions);
    card.appendChild(top);
    card.appendChild(shiftEditor(s));
    return card;
  }

  function toggleStaffEdit(card, s) {
    var existing = card.querySelector('.edit-form');
    if (existing) { existing.remove(); return; }

    var f = el('div', 'edit-form');
    f.innerHTML =
      '<div><label>Name</label><input class="f-name" value="' + esc(s.name) + '"></div>'
      + '<div><label>Role</label><select class="f-role">'
      + ROLES.map(function (r) {
          return '<option value="' + r[0] + '"' + (r[0] === s.role ? ' selected' : '') + '>' + r[1] + '</option>';
        }).join('')
      + '</select></div>';

    var acts = el('div', 'form-actions');
    var save = el('button', 'btn btn-approve', 'Save');
    save.addEventListener('click', function () {
      api('/api/admin/staff/' + s.id, {
        method: 'PATCH',
        body: JSON.stringify({
          name: f.querySelector('.f-name').value.trim(),
          role: f.querySelector('.f-role').value,
        }),
      }).then(function () { toast('Saved.'); loadStaff(); })
        .catch(function (e) { toast(e.message, true); });
    });
    var cancel = el('button', 'btn', 'Cancel');
    cancel.addEventListener('click', function () { f.remove(); });
    acts.appendChild(save); acts.appendChild(cancel);
    f.appendChild(acts);
    card.appendChild(f);
  }

  /** Weekly roster, edited as a set and saved with one PUT. */
  function shiftEditor(s) {
    var wrap = el('div', 'shifts');
    var rows = el('div');

    function addRow(shift) {
      var r = el('div', 'shift-row');
      r.innerHTML =
        '<select class="s-day">' + DAYS.slice(1).map(function (d, i) {
          return '<option value="' + (i + 1) + '"' + (shift && shift.dayOfWeek === i + 1 ? ' selected' : '') + '>' + d + '</option>';
        }).join('') + '</select>'
        + '<input type="time" class="s-start" value="' + esc(shift ? shift.startTime : '09:00') + '">'
        + '<span class="row-meta">to</span>'
        + '<input type="time" class="s-end" value="' + esc(shift ? shift.endTime : '17:00') + '">';
      var del = el('button', 'shift-del', '&times;');
      del.title = 'Remove this shift';
      del.addEventListener('click', function () { r.remove(); refreshWarning(); });
      r.appendChild(del);
      rows.appendChild(r);
    }

    // A provider with no shifts produces no availability at all — the single
    // most confusing way for the schedule to look "broken".
    var warn = el('p', 'shift-empty');
    function refreshWarning() {
      warn.hidden = rows.children.length > 0;
      warn.textContent = 'No shifts — ' + s.name + ' offers no appointment times.';
    }

    if (s.schedules.length) s.schedules.forEach(addRow); else addRow(null);
    wrap.appendChild(warn);
    wrap.appendChild(rows);
    refreshWarning();

    var tools = el('div', 'shift-tools');
    var add = el('button', 'btn', '+ Add shift');
    add.addEventListener('click', function () { addRow(null); refreshWarning(); });

    var save = el('button', 'btn btn-approve', 'Save shifts');
    save.addEventListener('click', function () {
      var shifts = [].map.call(rows.querySelectorAll('.shift-row'), function (r) {
        return {
          dayOfWeek: parseInt(r.querySelector('.s-day').value, 10),
          startTime: r.querySelector('.s-start').value,
          endTime: r.querySelector('.s-end').value,
        };
      });
      api('/api/admin/staff/' + s.id + '/shifts', { method: 'PUT', body: JSON.stringify({ shifts: shifts }) })
        .then(function (res) {
          var msg = 'Shifts saved for ' + s.name + '.';
          // Existing bookings are never auto-cancelled by a roster change;
          // say so rather than let the mismatch go unnoticed.
          if (res.upcomingBookings > 0) {
            msg += ' ' + res.upcomingBookings + ' upcoming booking(s) were not changed — check they still fit.';
          }
          toast(msg);
          loadStaff();
        }).catch(function (e) { toast(e.message, true); });
    });

    tools.appendChild(add);
    tools.appendChild(save);
    wrap.appendChild(tools);
    return wrap;
  }

  $('add-staff').addEventListener('click', function () {
    var name = prompt('Name of the new staff member:');
    if (!name || !name.trim()) return;
    api('/api/admin/staff', {
      method: 'POST',
      body: JSON.stringify({ name: name.trim(), role: 'CHIROPRACTOR' }),
    }).then(function () {
      toast('Added. Set their role and shifts below.');
      loadStaff();
    }).catch(function (e) { toast(e.message, true); });
  });

  // ---- rooms -------------------------------------------------------------

  function loadRooms() {
    api('/api/admin/resources').then(function (r) {
      var warnBox = $('room-warning');
      warnBox.innerHTML = '';

      // A service whose room type has no active room can never be booked, and
      // the booking page just shows "no availability" without explaining why.
      var activeTypes = {};
      r.resources.forEach(function (x) { if (x.active) activeTypes[x.type] = true; });
      var missing = r.requiredTypes.filter(function (t) { return !activeTypes[t]; });
      if (missing.length) {
        warnBox.appendChild(el('div', 'warn-box bad',
          '<strong>No active room for:</strong> ' + esc(missing.join(', '))
          + '. Services needing these cannot be booked at all.'));
      }

      var box = $('room-list');
      box.innerHTML = '';
      r.resources.forEach(function (x) { box.appendChild(roomCard(x)); });
    }).catch(function (e) { if (e.message !== 'unauthorised') toast(e.message, true); });
  }

  function roomCard(x) {
    var card = el('div', 'row-card' + (x.active ? '' : ' inactive'));
    var top = el('div', 'row-top');
    top.appendChild(el('span', 'row-name', esc(x.name)));
    top.appendChild(el('span', 'pill', esc(x.type)));
    top.appendChild(el('span', 'pill cap', 'holds ' + x.maxCapacity));
    if (!x.active) top.appendChild(el('span', 'pill off', 'INACTIVE'));
    top.appendChild(el('span', 'row-meta', x.bookingCount + ' booking' + (x.bookingCount === 1 ? '' : 's')));

    var actions = el('div', 'row-actions');
    var edit = el('button', 'btn', 'Edit');
    edit.addEventListener('click', function () { toggleRoomEdit(card, x); });
    var toggle = el('button', 'btn', x.active ? 'Deactivate' : 'Reactivate');
    toggle.addEventListener('click', function () {
      api('/api/admin/resources/' + x.id, { method: 'PATCH', body: JSON.stringify({ active: !x.active }) })
        .then(function () { toast(x.name + (x.active ? ' deactivated.' : ' reactivated.')); loadRooms(); })
        .catch(function (e) { toast(e.message, true); });
    });
    var del = el('button', 'btn btn-decline', 'Remove');
    del.addEventListener('click', function () {
      api('/api/admin/resources/' + x.id, { method: 'DELETE' }).then(function (res) {
        toast(res.removed ? x.name + ' removed.' : res.reason, !res.removed);
        loadRooms();
      }).catch(function (e) { toast(e.message, true); });
    });
    actions.appendChild(edit); actions.appendChild(toggle); actions.appendChild(del);
    top.appendChild(actions);
    card.appendChild(top);
    return card;
  }

  function toggleRoomEdit(card, x) {
    var existing = card.querySelector('.edit-form');
    if (existing) { existing.remove(); return; }
    var f = el('div', 'edit-form');
    f.innerHTML =
      '<div><label>Name</label><input class="f-name" value="' + esc(x.name) + '"></div>'
      + '<div><label>Type</label><input class="f-type" value="' + esc(x.type) + '"></div>'
      + '<div><label>Holds how many at once</label><input class="f-cap" type="number" min="1" value="' + x.maxCapacity + '"></div>';
    var acts = el('div', 'form-actions');
    var save = el('button', 'btn btn-approve', 'Save');
    save.addEventListener('click', function () {
      api('/api/admin/resources/' + x.id, {
        method: 'PATCH',
        body: JSON.stringify({
          name: f.querySelector('.f-name').value.trim(),
          type: f.querySelector('.f-type').value.trim().toUpperCase(),
          maxCapacity: parseInt(f.querySelector('.f-cap').value, 10),
        }),
      }).then(function () { toast('Saved.'); loadRooms(); })
        .catch(function (e) { toast(e.message, true); });
    });
    var cancel = el('button', 'btn', 'Cancel');
    cancel.addEventListener('click', function () { f.remove(); });
    acts.appendChild(save); acts.appendChild(cancel);
    f.appendChild(acts);
    card.appendChild(f);
  }

  $('add-room').addEventListener('click', function () {
    var name = prompt('Room or equipment name (e.g. "IV Chair 5"):');
    if (!name || !name.trim()) return;
    var type = prompt('Type — UPPER_SNAKE_CASE, must match what a service asks for (e.g. IV_CHAIR):');
    if (!type || !type.trim()) return;
    api('/api/admin/resources', {
      method: 'POST',
      body: JSON.stringify({ name: name.trim(), type: type.trim().toUpperCase(), maxCapacity: 1 }),
    }).then(function () { toast('Room added.'); loadRooms(); })
      .catch(function (e) { toast(e.message, true); });
  });

  // ---- services ----------------------------------------------------------

  function loadServices() {
    api('/api/admin/services').then(function (r) {
      var box = $('service-list');
      box.innerHTML = '';
      var cat = null;
      r.services.forEach(function (s) {
        if (s.category !== cat) {
          cat = s.category;
          box.appendChild(el('div', 'svc-cat', esc(cat)));
        }
        box.appendChild(serviceCard(s));
      });
    }).catch(function (e) { if (e.message !== 'unauthorised') toast(e.message, true); });
  }

  function serviceCard(s) {
    var card = el('div', 'row-card');
    var grid = el('div', 'svc-grid');

    var left = el('div');
    left.appendChild(el('div', 'row-name', esc(s.name)));
    left.appendChild(el('div', 'row-meta', esc(s.resourceType) + ' · ' + esc(s.requiredRole)));
    if (s.options.length) {
      left.appendChild(el('div', 'row-meta',
        s.options.length + ' priced options: '
        + esc(s.options.map(function (o) { return o.label + ' $' + (o.priceCents / 100).toFixed(0); }).join(', '))));
    }
    grid.appendChild(left);

    function field(label, cls, val, attrs) {
      var d = el('div', 'svc-field', '<label>' + label + '</label>');
      var i = el('input', cls);
      i.value = val == null ? '' : val;
      Object.keys(attrs || {}).forEach(function (k) { i.setAttribute(k, attrs[k]); });
      d.appendChild(i);
      return d;
    }
    grid.appendChild(field('Minutes', 'f-dur', s.durationMin, { type: 'number', min: '5' }));
    grid.appendChild(field('Buffer', 'f-buf', s.bufferMin, { type: 'number', min: '0' }));
    grid.appendChild(field('Price $', 'f-price', money(s.priceCents), { type: 'number', min: '0' }));

    var save = el('button', 'btn btn-approve', 'Save');
    save.addEventListener('click', function () {
      var priceRaw = grid.querySelector('.f-price').value.trim();
      api('/api/admin/services/' + s.id, {
        method: 'PATCH',
        body: JSON.stringify({
          durationMin: parseInt(grid.querySelector('.f-dur').value, 10),
          bufferMin: parseInt(grid.querySelector('.f-buf').value, 10),
          // Empty means "no single price", not zero — peptide therapy and the
          // option-priced services genuinely have none.
          priceCents: priceRaw === '' ? null : Math.round(parseFloat(priceRaw) * 100),
        }),
      }).then(function (res) {
        toast(res.note ? 'Saved. ' + res.note : 'Saved.', !!res.note);
        loadServices();
      }).catch(function (e) { toast(e.message, true); });
    });
    grid.appendChild(save);

    card.appendChild(grid);
    return card;
  }

  // ---- boot --------------------------------------------------------------

  function start() {
    $('gate').hidden = true;
    $('app').hidden = false;
    loadStaff();
    loadRooms();
    loadServices();
    loadDangerZone();
  }

  /**
   * Purge controls, shown only when the server reports demo mode. The server
   * refuses regardless of what the UI does — this just avoids offering a
   * button that cannot work.
   */
  function loadDangerZone() {
    api('/api/admin/purge').then(function (r) {
      var box = $('danger-zone');
      if (!r.allowed) { box.hidden = true; return; }
      box.hidden = false;

      var d = r.wouldDelete;
      var total = d.bookings + d.patients + d.visitNotes;
      box.innerHTML =
        '<div class="danger">'
        + '<h2>Clear all booking data</h2>'
        + '<p>Deletes every booking, patient record and clinical note. Services, '
        + 'rooms, staff and shifts are kept. <strong>This cannot be undone.</strong> '
        + 'Only possible while BOOKING_MODE is <code>demo</code>.</p>'
        + '<div class="counts">' + d.bookings + ' bookings · ' + d.patients
        + ' patients · ' + d.visitNotes + ' clinical notes</div>'
        + (total === 0 ? '<p class="counts">Nothing to clear.</p>' : '')
        + '</div>';

      if (total === 0) return;

      var row = document.createElement('div');
      var input = document.createElement('input');
      input.placeholder = 'Type DELETE ALL BOOKINGS';
      var go = el('button', 'btn btn-decline', 'Clear everything');
      go.addEventListener('click', function () {
        api('/api/admin/purge', {
          method: 'POST',
          body: JSON.stringify({ confirm: input.value.trim() }),
        }).then(function (res) {
          toast('Cleared ' + res.deleted.bookings + ' bookings, '
            + res.deleted.patients + ' patients, ' + res.deleted.visitNotes + ' notes.');
          loadDangerZone();
          loadStaff();
          loadRooms();
        }).catch(function (e) { toast(e.message, true); });
      });
      row.appendChild(input);
      row.appendChild(go);
      box.querySelector('.danger').appendChild(row);
    }).catch(function () { $('danger-zone').hidden = true; });
  }

  $('gate-go').addEventListener('click', function () {
    var v = $('gate-token').value.trim();
    if (!v) return;
    localStorage.setItem(TOKEN_KEY, v);
    api('/api/admin/staff').then(start).catch(function () { /* signOut already ran */ });
  });
  $('gate-token').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('gate-go').click();
  });
  $('signout').addEventListener('click', function () { signOut(null); });

  if (token()) {
    api('/api/admin/staff').then(start).catch(function () { /* gate shown */ });
  } else {
    $('gate').hidden = false;
  }
})();
