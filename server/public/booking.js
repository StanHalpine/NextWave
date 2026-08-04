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
    // Whether the 'first visit?' question has been answered this session.
    newPatientAnswered: false,
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

  /** 105000 → "$1,050". Whole dollars: every price on the site is round. */
  function money(cents) {
    if (cents == null) return null;
    return '$' + (cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });
  }

  /**
   * What this booking costs, as far as we can state it. An option's price
   * beats the service price — a B12 shot is $35 even though Vitamin Shots
   * has no headline price. Returns null when genuinely unknown (peptide
   * therapy), so the UI can say so rather than imply free.
   */
  function priceFor(service, optionLabel) {
    if (!service) return null;
    if (optionLabel && service.options) {
      for (var i = 0; i < service.options.length; i++) {
        if (service.options[i].label === optionLabel) return money(service.options[i].priceCents);
      }
    }
    return money(service.priceCents);
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
          var p = priceFor(s, null);
          // Services whose price depends on the option show "From $x" rather
          // than nothing, so the list never looks like some things are free.
          if (!p && s.options && s.options.length) {
            var lowest = s.options.reduce(function (m, o) {
              return o.priceCents < m ? o.priceCents : m;
            }, s.options[0].priceCents);
            p = 'From ' + money(lowest);
          }
          b.innerHTML = esc(s.name)
            + '<span class="dur">' + s.durationMin + ' min'
            + (p ? ' · <strong>' + esc(p) + '</strong>' : '') + '</span>';
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

    // Some services assume a prior visit. Ask before showing days, so a
    // first-timer is redirected instead of booking something they are not
    // eligible for and being corrected by phone.
    if (s.newPatientSlug && !state.newPatientAnswered) {
      askNewPatient(s);
      return;
    }
    proceedToDays();
  }

  function proceedToDays() {
    show('new-patient-check', false);
    show('step-date', true);
    show('step-time', false);
    buildDays();
    $('step-date').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function askNewPatient(s) {
    var target = state.services.filter(function (x) { return x.slug === s.newPatientSlug; })[0];
    // If the prerequisite service is missing from the catalogue, do not block
    // the booking — let it through and let the front desk sort it out.
    if (!target) { state.newPatientAnswered = true; proceedToDays(); return; }

    show('step-date', false);
    var box = $('new-patient-check');
    box.hidden = false;
    box.innerHTML =
      '<p class="np-q">Have you been to NextWave before?</p>'
      + '<p class="np-why">' + esc(s.name) + ' is for patients who have already completed a '
      + esc(target.name) + '.</p>';

    var row = document.createElement('div');
    row.className = 'np-row';

    var yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'btn btn-primary';
    yes.textContent = "Yes, I'm an existing patient";
    yes.addEventListener('click', function () {
      state.newPatientAnswered = true;
      proceedToDays();
    });

    var no = document.createElement('button');
    no.type = 'button';
    no.className = 'btn btn-ghost';
    no.textContent = 'No, this is my first visit';
    no.addEventListener('click', function () {
      state.newPatientAnswered = true;
      state.subOption = null; // belonged to the service we are leaving
      toast('Starting you with a ' + target.name + ' instead.');
      lockToService(target);
    });

    row.appendChild(yes);
    row.appendChild(no);
    box.appendChild(row);
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
    matches.sort(function (a, b) { return a.durationMin - b.durationMin; });

    // One slug, several services — hyperbaric sells a 60- and a 90-minute
    // session off a single page at different prices. Silently taking the
    // shorter one books the wrong thing, so ask.
    if (matches.length > 1) {
      offerVariants(matches);
      return;
    }
    lockToService(matches[0]);
  }

  function offerVariants(list) {
    show('service-groups', false);
    var box = $('variant-choice');
    box.hidden = false;
    box.innerHTML = '<p class="variant-q">Which session would you like?</p>';

    var row = document.createElement('div');
    row.className = 'variant-row';
    list.forEach(function (s) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'variant-btn';
      var p = priceFor(s, null);
      b.innerHTML = '<span class="variant-dur">' + s.durationMin + ' minutes</span>'
        + (p ? '<span class="variant-price">' + esc(p) + '</span>' : '');
      b.addEventListener('click', function () {
        box.hidden = true;
        lockToService(s);
      });
      row.appendChild(b);
    });
    box.appendChild(row);
  }

  function lockToService(s) {
    pickService(s);
    show('service-groups', false);
    var box = $('service-locked');
    box.hidden = false;
    var lp = priceFor(s, state.subOption);
    box.innerHTML =
      '<div class="locked-name">' + esc(s.name)
      + (state.subOption ? ' <span class="locked-option">' + esc(state.subOption) + '</span>' : '')
      + (lp ? ' <span class="locked-price">' + esc(lp) + '</span>' : '')
      + (s.priceNote && !state.subOption ? '<div class="locked-note">' + esc(s.priceNote) + '</div>' : '')
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

  var DAY_COUNT = 14;

  /**
   * The day strip, greyed out to match reality.
   *
   * Which days are bookable depends on the SERVICE — a chiropractor working
   * Monday to Thursday means no chiropractic on Friday, even though the clinic
   * is open and other services are available. This used to hard-code Sunday as
   * the only closed day, so the calendar offered Fridays it would then refuse.
   *
   * Rendered enabled-but-pending first so the strip appears immediately, then
   * corrected when the server answers. Days are never enabled by that pass,
   * only disabled, so a slow reply cannot briefly offer a closed day.
   */
  function buildDays() {
    var strip = $('day-strip');
    strip.innerHTML = '';
    var today = new Date();

    for (var i = 0; i < DAY_COUNT; i++) {
      var d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
      var iso = localDateISO(d);
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'day-btn pending';
      b.dataset.date = iso;
      b.innerHTML = '<span class="dow">' + ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()] + '</span>'
        + '<span class="dnum">' + d.getDate() + '</span>';
      b.addEventListener('click', pickDay.bind(null, iso));
      strip.appendChild(b);
    }
    $('date-input').min = localDateISO(today);

    if (!state.service) return;
    api('/api/availability/days?serviceId=' + encodeURIComponent(state.service.id)
        + '&days=' + DAY_COUNT)
      .then(function (r) {
        var byDate = {};
        r.days.forEach(function (x) { byDate[x.date] = x; });

        [].forEach.call(strip.querySelectorAll('.day-btn'), function (btn) {
          var info = byDate[btn.dataset.date];
          btn.classList.remove('pending');
          if (!info || info.open) return;
          btn.classList.add('shut');
          btn.disabled = true;
          btn.title = info.reason || 'No appointments available on this day.';
        });

        var openCount = r.days.filter(function (x) { return x.open; }).length;
        if (openCount === 0) {
          $('slot-note').textContent =
            'No appointments available in the next two weeks for this service.';
          show('step-time', true);
        }
      })
      .catch(function () {
        // Leave every day clickable rather than wrongly closing them; picking
        // a closed day still shows the reason on the next step.
        [].forEach.call(strip.querySelectorAll('.day-btn'), function (btn) {
          btn.classList.remove('pending');
        });
      });
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

        // 45 slots in one list is a long scroll on a phone. Grouping by part
        // of day lets someone jump to the window they actually want.
        var parts = [
          { name: 'Morning', from: 0, to: 12, slots: [] },
          { name: 'Afternoon', from: 12, to: 17, slots: [] },
          { name: 'Evening', from: 17, to: 24, slots: [] },
        ];
        d.slots.forEach(function (s) {
          var hour = parseInt(s.localTime.split(':')[0], 10);
          for (var i = 0; i < parts.length; i++) {
            if (hour >= parts[i].from && hour < parts[i].to) { parts[i].slots.push(s); break; }
          }
        });

        parts.forEach(function (part) {
          if (!part.slots.length) return;
          var h = document.createElement('h3');
          h.className = 'slot-part';
          h.innerHTML = esc(part.name) + ' <span>' + part.slots.length + '</span>';
          grid.appendChild(h);

          var row = document.createElement('div');
          row.className = 'slot-row';
          part.slots.forEach(function (s) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'slot-btn';
            b.textContent = ampm(s.localTime);
            b.addEventListener('click', function () { takeHold(s, b); });
            row.appendChild(b);
          });
          grid.appendChild(row);
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
      + '<div class="when">' + esc(h.resource) + (h.staff ? ' · ' + esc(h.staff) : '') + '</div>'
      + (function () {
          var p = priceFor(state.service, h.subOption);
          if (p) return '<div class="summary-price">' + esc(p) + '</div>';
          // Never leave price silently blank — say it is confirmed later.
          return '<div class="summary-price muted">Price confirmed at your visit</div>';
        })();

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
          + (b.subOption ? ' — ' + esc(b.subOption) : '')
          + (function () { var p = priceFor(state.service, b.subOption); return p ? ' · ' + esc(p) : ''; })()
          + '</strong><br>'
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
    state.newPatientAnswered = false;
    show('variant-choice', false);
    show('new-patient-check', false);
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

  /**
   * The banner is driven by BOOKING_MODE on the server, not hard-coded here,
   * so a test deployment cannot silently present itself as the real thing.
   * Fails closed: if the mode cannot be fetched, show the demo warning rather
   * than nothing, because wrongly claiming "real" is the costlier error.
   */
  function applyMode() {
    var el = $('mode-banner');
    var COPY = {
      demo: '<strong>DEMO</strong> — sample data only. Nothing booked here is a real appointment.',
      beta: '<strong>BETA</strong> — online booking is new. Your request is reviewed by our '
          + 'front desk, who will confirm by phone or email before it is final.',
      live: null,
    };

    // The preview key travels with every request the page makes, so a staff
    // member testing a coming-soon deployment stays in preview across steps.
    var preview = new URLSearchParams(location.search).get('preview');

    return api('/api/config' + (preview ? '?preview=' + encodeURIComponent(preview) : ''))
      .then(function (c) {
        if (c.mode === 'coming_soon') {
          // Hide the flow entirely rather than letting someone fill in a form
          // that cannot result in an appointment.
          show('booking-flow', false);
          show('coming-soon', true);
          $('cs-when').textContent = c.openingWhen
            ? 'We expect to open in ' + c.openingWhen + '.'
            : '';
          el.hidden = true;
          return false;
        }

        if (c.previewing) {
          el.innerHTML = '<strong>STAFF PREVIEW</strong> — the public sees a '
            + '“coming soon” page. Bookings you make here are real rows in the database.';
          el.hidden = false;
        } else {
          var copy = COPY[c.mode];
          el.innerHTML = copy || '';
          el.hidden = !copy;
        }
        return true;
      })
      .catch(function () {
        // Fail closed: if the mode is unknown, warn rather than imply the
        // booking is real.
        el.innerHTML = COPY.demo;
        el.hidden = false;
        return true;
      });
  }

  // Services are only loaded once the mode says the flow should exist.
  applyMode().then(function (open) {
    if (!open) return;
    loadServices();
    resume();
  });
})();
