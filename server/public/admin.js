/**
 * Configuration screen — staff, shifts, rooms, service timings and prices.
 *
 * SAVING MODEL
 *
 * Typed edits are batched. Every field is directly editable; changing one
 * marks that record dirty and raises a save bar showing how many records are
 * pending. One "Save changes" commits them all. Earlier this screen had a
 * Save button per row, which made it impossible to tell what was still
 * unsaved and easy to lose an edit by scrolling past it.
 *
 * Buttons that say Add / Remove / Deactivate still act immediately, because
 * they are discrete decisions rather than typing, and batching a deletion
 * makes it unclear whether it has happened.
 *
 * Every write here changes what patients can book, so the UI makes
 * consequences visible: a provider with no shifts is flagged, a room type
 * with nothing active is flagged, and the server's refusals (lowering
 * capacity under existing bookings) are shown verbatim rather than reduced
 * to "something went wrong".
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

  /**
   * Pending edits, keyed so a second change to the same record replaces the
   * first rather than queueing twice. Each entry knows how to save itself.
   */
  var pending = {};

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
    // Refusals explain a real constraint and are worth reading.
    t._timer = setTimeout(function () { t.className = 'toast'; }, isErr ? 8000 : 3000);
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

  function money(cents) { return cents == null ? '' : (cents / 100).toFixed(0); }

  // ---- pending edits + save bar -----------------------------------------

  function markDirty(key, label, run, card) {
    pending[key] = { label: label, run: run };
    if (card) card.classList.add('dirty');
    renderSaveBar();
  }

  function pendingCount() { return Object.keys(pending).length; }

  function renderSaveBar() {
    var bar = $('save-bar');
    var n = pendingCount();
    if (n === 0) { bar.hidden = true; return; }
    bar.hidden = false;
    $('save-count').textContent = n + ' unsaved change' + (n === 1 ? '' : 's');
    $('save-what').textContent = Object.keys(pending)
      .map(function (k) { return pending[k].label; })
      .filter(function (v, i, a) { return a.indexOf(v) === i; })
      .join(', ');
  }

  /**
   * Saves every pending edit. Runs sequentially rather than in parallel: the
   * server refuses some changes (capacity below existing bookings), and a
   * serial pass means a refusal names one record instead of arriving in a
   * pile of simultaneous errors.
   */
  function saveAll() {
    var keys = Object.keys(pending);
    if (!keys.length) return;

    $('save-go').disabled = true;
    var failures = [];

    var chain = keys.reduce(function (p, k) {
      return p.then(function () {
        return pending[k].run()
          .then(function (res) {
            delete pending[k];
            // Some saves come back with a caveat worth surfacing.
            if (res && res.note) toast(res.note, true);
            if (res && res.upcomingBookings > 0) {
              toast(res.upcomingBookings + ' upcoming booking(s) were not moved — check they still fit.', true);
            }
          })
          .catch(function (e) {
            if (e.message !== 'unauthorised') failures.push(pending[k].label + ': ' + e.message);
          });
      });
    }, Promise.resolve());

    chain.then(function () {
      $('save-go').disabled = false;
      renderSaveBar();
      if (failures.length) {
        // Failed entries stay pending so nothing is silently dropped.
        toast(failures[0], true);
      } else {
        toast('Saved.');
      }
      refreshAll();
    });
  }

  function discardAll() {
    pending = {};
    renderSaveBar();
    refreshAll();
    toast('Changes discarded.');
  }

  // A config screen is exactly where someone types, gets distracted, and
  // navigates away. Do not let that happen silently.
  window.addEventListener('beforeunload', function (e) {
    if (pendingCount() === 0) return;
    e.preventDefault();
    e.returnValue = '';
  });

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
    return api('/api/admin/staff').then(function (r) {
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

    var nameInput = el('input', 'inline-name');
    nameInput.value = s.name;
    nameInput.setAttribute('aria-label', 'Name');

    var roleSel = el('select', 'inline-role',
      ROLES.map(function (r) {
        return '<option value="' + r[0] + '"' + (r[0] === s.role ? ' selected' : '') + '>' + r[1] + '</option>';
      }).join(''));

    function queueStaff() {
      markDirty('staff:' + s.id, s.name, function () {
        return api('/api/admin/staff/' + s.id, {
          method: 'PATCH',
          body: JSON.stringify({ name: nameInput.value.trim(), role: roleSel.value }),
        });
      }, card);
    }
    nameInput.addEventListener('input', queueStaff);
    roleSel.addEventListener('change', queueStaff);

    top.appendChild(nameInput);
    top.appendChild(roleSel);
    if (!s.active) top.appendChild(el('span', 'pill off', 'INACTIVE'));
    top.appendChild(el('span', 'row-meta', s.bookingCount + ' booking' + (s.bookingCount === 1 ? '' : 's')));

    var actions = el('div', 'row-actions');

    var toggle = el('button', 'btn', s.active ? 'Deactivate' : 'Reactivate');
    toggle.addEventListener('click', function () {
      api('/api/admin/staff/' + s.id, { method: 'PATCH', body: JSON.stringify({ active: !s.active }) })
        .then(function () {
          toast(s.active ? s.name + ' deactivated — takes no new bookings.' : s.name + ' reactivated.');
          refreshAll();
        }).catch(function (e) { toast(e.message, true); });
    });
    actions.appendChild(toggle);

    var del = el('button', 'btn btn-decline', 'Remove');
    del.addEventListener('click', function () {
      if (!confirm('Remove ' + s.name + '?')) return;
      api('/api/admin/staff/' + s.id, { method: 'DELETE' }).then(function (res) {
        toast(res.removed ? s.name + ' removed.' : res.reason, !res.removed);
        refreshAll();
      }).catch(function (e) { toast(e.message, true); });
    });
    actions.appendChild(del);

    top.appendChild(actions);
    card.appendChild(top);
    card.appendChild(shiftEditor(s, card));
    return card;
  }

  /** Weekly roster, edited as a set and queued as one change. */
  function shiftEditor(s, card) {
    var wrap = el('div', 'shifts');
    var rows = el('div');

    function queueShifts() {
      markDirty('shifts:' + s.id, s.name + '’s shifts', function () {
        var shifts = [].map.call(rows.querySelectorAll('.shift-row'), function (r) {
          return {
            dayOfWeek: parseInt(r.querySelector('.s-day').value, 10),
            startTime: r.querySelector('.s-start').value,
            endTime: r.querySelector('.s-end').value,
          };
        });
        return api('/api/admin/staff/' + s.id + '/shifts', {
          method: 'PUT', body: JSON.stringify({ shifts: shifts }),
        });
      }, card);
    }

    function addRow(shift) {
      var r = el('div', 'shift-row');
      r.innerHTML =
        '<select class="s-day">' + DAYS.slice(1).map(function (d, i) {
          return '<option value="' + (i + 1) + '"' + (shift && shift.dayOfWeek === i + 1 ? ' selected' : '') + '>' + d + '</option>';
        }).join('') + '</select>'
        + '<input type="time" class="s-start" value="' + esc(shift ? shift.startTime : '09:00') + '">'
        + '<span class="row-meta">to</span>'
        + '<input type="time" class="s-end" value="' + esc(shift ? shift.endTime : '17:00') + '">';
      // Labelled, not a bare "×" — a lone glyph at the end of a row of time
      // pickers is easy to miss entirely, which is how this went unnoticed.
      var del = el('button', 'shift-del', 'Remove');
      del.title = 'Remove this working day';
      del.setAttribute('aria-label', 'Remove this working day');
      del.addEventListener('click', function () { r.remove(); refreshWarning(); queueShifts(); });
      r.appendChild(del);

      [].forEach.call(r.querySelectorAll('select,input'), function (f) {
        f.addEventListener('change', queueShifts);
      });
      rows.appendChild(r);
    }

    // A provider with no shifts produces no availability at all — the single
    // most confusing way for the schedule to look broken.
    var warn = el('p', 'shift-empty');
    function refreshWarning() {
      warn.hidden = rows.children.length > 0;
      warn.textContent = 'No shifts — ' + s.name + ' offers no appointment times.';
    }

    if (s.schedules.length) s.schedules.forEach(addRow); else addRow(null);
    wrap.appendChild(warn);
    wrap.appendChild(rows);
    refreshWarning();

    var add = el('button', 'btn', '+ Add shift');
    add.addEventListener('click', function () { addRow(null); refreshWarning(); queueShifts(); });
    var tools = el('div', 'shift-tools');
    tools.appendChild(add);
    wrap.appendChild(tools);
    return wrap;
  }

  $('add-staff').addEventListener('click', function () {
    var name = prompt('Name of the new staff member:');
    if (!name || !name.trim()) return;
    api('/api/admin/staff', {
      method: 'POST',
      body: JSON.stringify({ name: name.trim(), role: 'CHIROPRACTOR' }),
    }).then(function () { toast('Added. Set their role and shifts, then save.'); refreshAll(); })
      .catch(function (e) { toast(e.message, true); });
  });

  // ---- rooms -------------------------------------------------------------

  function loadRooms() {
    return api('/api/admin/resources').then(function (r) {
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

    var nameInput = el('input', 'inline-name');
    nameInput.value = x.name;
    nameInput.setAttribute('aria-label', 'Room name');

    var typeInput = el('input', 'inline-type');
    typeInput.value = x.type;
    typeInput.setAttribute('aria-label', 'Type');

    var capWrap = el('span', 'cap-wrap', '<span class="cap-label">holds</span>');
    var capInput = el('input', 'inline-cap');
    capInput.type = 'number';
    capInput.min = '1';
    capInput.value = x.maxCapacity;
    capInput.setAttribute('aria-label', 'How many at once');
    capWrap.appendChild(capInput);

    function queueRoom() {
      markDirty('room:' + x.id, x.name, function () {
        return api('/api/admin/resources/' + x.id, {
          method: 'PATCH',
          body: JSON.stringify({
            name: nameInput.value.trim(),
            type: typeInput.value.trim().toUpperCase(),
            maxCapacity: parseInt(capInput.value, 10),
          }),
        });
      }, card);
    }
    [nameInput, typeInput, capInput].forEach(function (f) { f.addEventListener('input', queueRoom); });

    top.appendChild(nameInput);
    top.appendChild(typeInput);
    top.appendChild(capWrap);
    if (!x.active) top.appendChild(el('span', 'pill off', 'INACTIVE'));
    top.appendChild(el('span', 'row-meta', x.bookingCount + ' booking' + (x.bookingCount === 1 ? '' : 's')));

    var actions = el('div', 'row-actions');
    var toggle = el('button', 'btn', x.active ? 'Deactivate' : 'Reactivate');
    toggle.addEventListener('click', function () {
      api('/api/admin/resources/' + x.id, { method: 'PATCH', body: JSON.stringify({ active: !x.active }) })
        .then(function () { toast(x.name + (x.active ? ' deactivated.' : ' reactivated.')); refreshAll(); })
        .catch(function (e) { toast(e.message, true); });
    });
    var del = el('button', 'btn btn-decline', 'Remove');
    del.addEventListener('click', function () {
      if (!confirm('Remove ' + x.name + '?')) return;
      api('/api/admin/resources/' + x.id, { method: 'DELETE' }).then(function (res) {
        toast(res.removed ? x.name + ' removed.' : res.reason, !res.removed);
        refreshAll();
      }).catch(function (e) { toast(e.message, true); });
    });
    actions.appendChild(toggle); actions.appendChild(del);
    top.appendChild(actions);
    card.appendChild(top);
    return card;
  }

  $('add-room').addEventListener('click', function () {
    var name = prompt('Room or equipment name (e.g. "IV Chair 5"):');
    if (!name || !name.trim()) return;
    var type = prompt('Type — must match what a service asks for (e.g. IV_CHAIR):');
    if (!type || !type.trim()) return;
    api('/api/admin/resources', {
      method: 'POST',
      body: JSON.stringify({ name: name.trim(), type: type.trim().toUpperCase(), maxCapacity: 1 }),
    }).then(function () { toast('Room added.'); refreshAll(); })
      .catch(function (e) { toast(e.message, true); });
  });

  // ---- services ----------------------------------------------------------

  function loadServices() {
    return api('/api/admin/services').then(function (r) {
      var box = $('service-list');
      box.innerHTML = '';
      var cat = null;
      r.services.forEach(function (s) {
        if (s.category !== cat) { cat = s.category; box.appendChild(el('div', 'svc-cat', esc(cat))); }
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

    var inputs = {};
    function field(label, key, val, attrs) {
      var d = el('div', 'svc-field', '<label>' + label + '</label>');
      var i = el('input');
      i.value = val == null ? '' : val;
      Object.keys(attrs || {}).forEach(function (k) { i.setAttribute(k, attrs[k]); });
      i.addEventListener('input', queueService);
      inputs[key] = i;
      d.appendChild(i);
      return d;
    }

    function queueService() {
      markDirty('service:' + s.id, s.name, function () {
        var priceRaw = inputs.price.value.trim();
        return api('/api/admin/services/' + s.id, {
          method: 'PATCH',
          body: JSON.stringify({
            durationMin: parseInt(inputs.dur.value, 10),
            bufferMin: parseInt(inputs.buf.value, 10),
            // Empty means "no single price", not zero — peptide therapy and
            // the option-priced services genuinely have none.
            priceCents: priceRaw === '' ? null : Math.round(parseFloat(priceRaw) * 100),
          }),
        });
      }, card);
    }

    grid.appendChild(field('Minutes', 'dur', s.durationMin, { type: 'number', min: '5' }));
    grid.appendChild(field('Buffer', 'buf', s.bufferMin, { type: 'number', min: '0' }));
    grid.appendChild(field('Price $', 'price', money(s.priceCents), { type: 'number', min: '0' }));

    card.appendChild(grid);
    return card;
  }

  // ---- boot --------------------------------------------------------------

  function refreshAll() {
    return Promise.all([loadStaff(), loadRooms(), loadServices()]).then(loadDangerZone);
  }

  function loadDangerZone() {
    return api('/api/admin/purge').then(function (r) {
      var box = $('danger-zone');
      if (!r.allowed) { box.hidden = true; return; }
      box.hidden = false;

      var d = r.wouldDelete;
      var total = d.bookings + d.patients + d.visitNotes;
      box.innerHTML =
        '<div class="danger">'
        + '<h2>Clear all booking data</h2>'
        + '<p>Deletes every booking, patient record and clinical note. Services, '
        + 'rooms, staff and shifts are kept. <strong>This cannot be undone.</strong></p>'
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
        api('/api/admin/purge', { method: 'POST', body: JSON.stringify({ confirm: input.value.trim() }) })
          .then(function (res) {
            toast('Cleared ' + res.deleted.bookings + ' bookings, '
              + res.deleted.patients + ' patients, ' + res.deleted.visitNotes + ' notes.');
            refreshAll();
          }).catch(function (e) { toast(e.message, true); });
      });
      row.appendChild(input); row.appendChild(go);
      box.querySelector('.danger').appendChild(row);
    }).catch(function () { $('danger-zone').hidden = true; });
  }

  function start() {
    $('gate').hidden = true;
    $('app').hidden = false;
    refreshAll();
  }

  $('save-go').addEventListener('click', saveAll);
  $('save-discard').addEventListener('click', discardAll);

  $('gate-go').addEventListener('click', function () {
    var v = $('gate-token').value.trim();
    if (!v) return;
    localStorage.setItem(TOKEN_KEY, v);
    api('/api/admin/staff').then(start).catch(function () { /* signOut already ran */ });
  });
  $('gate-token').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('gate-go').click();
  });
  $('signout').addEventListener('click', function () {
    if (pendingCount() && !confirm('You have unsaved changes. Sign out anyway?')) return;
    signOut(null);
  });

  if (token()) {
    api('/api/admin/staff').then(start).catch(function () { /* gate shown */ });
  } else {
    $('gate').hidden = false;
  }
})();
