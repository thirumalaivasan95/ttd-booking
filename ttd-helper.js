// ==UserScript==
// @name         TTD Booking Helper (personal)
// @namespace    personal.ttd
// @version      1.1
// @description  Fills your own members' details on the official TTD Special Entry Darshan page and retries Pay Now safely. You log in, review and pay yourself.
// @match        https://ttdevasthanams.ap.gov.in/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  if (window.__ttdHelper) {
    window.__ttdHelper.show();
    return;
  }

  /* ---------- Constants and saved settings ---------- */

  const KEY = 'ttdHelper.v1';
  const LEARNED_KEY = KEY + '.learnedFields';
  const MIN_REFRESH_SEC = 15;
  const MIN_PAY_GAP_SEC = 5;
  const MAX_PAY_TRIES = 10;
  const TTD_HOST = 'ttdevasthanams.ap.gov.in';

  const DEFAULTS = {
    count: 1, members: [], queue: '',
    contact: { email: '', city: '', state: '', country: 'India', pincode: '' },
    prefs: 'any', laddus: '10', hundi: '',
    dryRun: true, watch: false, refreshSec: 20, watchUntil: '', stage: '',
    payRetry: true, payTries: 8, payGapSec: 8, minimized: false
  };

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const MONTH_RE = new RegExp('^(' + MONTHS.join('|') + ') (\\d{4})$');
  const COLORS = {
    'rgb(163, 0, 14)': 'Quota Full',
    'rgb(204, 204, 204)': 'Not Available',
    'rgb(255, 255, 255)': 'Other month',
    'rgb(255, 191, 0)': 'Filling Fast'
  };
  const GENDERS = ['Male', 'Female', 'Transgender'];
  const ID_TYPES = ['Aadhaar Card', 'Passport', 'Voter ID', 'Driving License', 'PAN Card'];

  const SKIP_RE = /ticket|laddu|hundi|mobile|phone|otp|email|search/i;
  const KINDS = [
    ['idNo', /(id|proof|aadha?ar|passport|card).*(no|number)|number.*(id|proof)/i],
    ['idType', /(photo\s*id|id\s*proof|proof\s*type|id\s*type)/i],
    ['gender', /gender/i],
    ['age', /\bage\b/i],
    ['name', /name/i]
  ];
  const CONTACT_FIELDS = [
    ['email', /email/i],
    ['city', /city/i],
    ['state', /^state$/i],
    ['country', /country/i],
    ['pincode', /pin\s*code/i]
  ];

  const PAY_RE = /^(pay\s*now|proceed\s*to\s*pay(ment)?|make\s*payment|pay\s*(rs\.?|\u20b9)\s*[\d,.]+|confirm\s*(and|&)\s*pay)$/i;
  const REDIRECT_OK_RE = /^(ok|okay|yes|proceed|continue|redirect|confirm|go\s*to\s*payment)$/i;
  const FAIL_RE = /(try\s*again|server\s*(is\s*)?busy|too\s*many|unable\s*to|something\s*went\s*wrong|failed|time\s*d?\s*out|timeout|error|not\s*responding|high\s*traffic)/i;
  const STOP_RE = /(already|in\s*progress|pending|duplicate|session\s*expired|login\s*again|quota\s*is\s*full|no\s*tickets|sold\s*out|booking\s*(is\s*)?(confirmed|successful))/i;
  const GATEWAY_RE = /payment|gateway|billdesk|razorpay|payu|ccavenue|sbiepay/i;
  const POPUP_SEL = '[role=alert],[role=dialog],[role=alertdialog],[class*=toast i],[class*=snack i],[class*=error i],[class*=modal i],[class*=popup i],[class*=alert i]';
  const DIALOG_SEL = '[role=dialog],[role=alertdialog],[class*=modal i],[class*=popup i]';
  const BTN_SEL = 'button, a, [role="button"], input[type=submit], input[type=button]';

  const nativeConfirm = window.confirm.bind(window);

  let S = load();
  let stopFlag = false;
  let running = false;
  let filling = false;
  let payRunning = false;

  function load() {
    let s;
    try {
      s = Object.assign({}, DEFAULTS, JSON.parse(localStorage[KEY] || '{}'));
    } catch (e) {
      s = Object.assign({}, DEFAULTS);
    }
    if (!Array.isArray(s.members)) s.members = [];
    s.contact = Object.assign({}, DEFAULTS.contact, s.contact || {});
    s.count = Math.min(6, Math.max(1, parseInt(s.count, 10) || 1));
    return s;
  }

  function save() {
    try {
      localStorage[KEY] = JSON.stringify(S);
    } catch (e) {
      log('Could not save: ' + e.message);
    }
  }

  /* ---------- Helper functions ---------- */

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  async function waitFor(fn, ms) {
    const end = Date.now() + (ms || 0);
    for (;;) {
      if (stopFlag) throw new Error('Stopped by you.');
      let r = null;
      try { r = fn(); } catch (e) { r = null; }
      if (r) return r;
      if (Date.now() >= end) return null;
      await sleep(150);
    }
  }

  async function waitSec(sec) {
    for (let i = 0; i < sec * 10; i++) {
      if (stopFlag) throw new Error('Stopped by you.');
      await sleep(100);
    }
  }

  function $(sel) {
    return document.querySelector(sel);
  }

  function txt(el) {
    return el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    return el.offsetParent !== null || (cs.position === 'fixed' && el.getClientRects().length > 0);
  }

  function mine(el) {
    return !!(el && el.closest && el.closest('#ttdh'));
  }

  function leaves(regex, root) {
    return Array.from((root || document).querySelectorAll('div,span,p,li,label,td,button,h1,h2,h3,h4'))
      .filter(function (e) { return e.childElementCount === 0 && !mine(e) && regex.test(txt(e)); });
  }

  function buttons() {
    return Array.from(document.querySelectorAll(BTN_SEL))
      .filter(function (b) { return visible(b) && !mine(b); });
  }

  function btnText(b) {
    return b.tagName === 'INPUT' ? String(b.value || '').trim() : txt(b);
  }

  function click(el) {
    if (!el) return;
    try { el.scrollIntoView({ block: 'center' }); } catch (e) { el.scrollIntoView(); }
    el.click();
  }

  function deepest(el) {
    let e = el;
    while (e && e.firstElementChild) e = e.firstElementChild;
    return e || el;
  }

  function setValue(el, v) {
    let proto = HTMLInputElement.prototype;
    if (el instanceof HTMLSelectElement) proto = HTMLSelectElement.prototype;
    else if (el instanceof HTMLTextAreaElement) proto = HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(v));
    ['input', 'change', 'blur'].forEach(function (t) {
      el.dispatchEvent(new Event(t, { bubbles: true }));
    });
  }

  function norm(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function timeKey(s) {
    return norm(s).replace(/00/g, '');
  }

  function bg(el) {
    let e = el;
    for (let i = 0; i <= 3 && e; i++) {
      const c = getComputedStyle(e).backgroundColor;
      if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c;
      e = e.firstElementChild;
    }
    return null;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function log(msg) {
    const line = new Date().toLocaleTimeString() + ' ' + msg;
    console.log('[TTD Helper] ' + line);
    const el = document.getElementById('ttdh-log');
    if (el) el.textContent = line + '\n' + el.textContent.slice(0, 20000);
  }

  /* ---------- Page 1: slot page ---------- */

  function readMonth() {
    const l = leaves(MONTH_RE)[0];
    if (!l) return null;
    const m = txt(l).match(MONTH_RE);
    return { label: txt(l), month: MONTHS.indexOf(m[1]) + 1, year: parseInt(m[2], 10) };
  }

  function readDays() {
    const out = [];
    document.querySelectorAll('table td').forEach(function (td) {
      if (mine(td) || !visible(td)) return;
      const t = txt(td);
      if (!/^\d{1,2}$/.test(t)) return;
      const c = bg(td);
      if (!c) return;
      const status = COLORS[c] || 'Available';
      out.push({ day: parseInt(t, 10), el: td, status: status, bookable: status === 'Available' || status === 'Filling Fast' });
    });
    return out;
  }

  function chevrons() {
    return Array.from(document.querySelectorAll('main img'))
      .filter(function (i) { return /chevron/i.test(i.getAttribute('src') || ''); });
  }

  function arrow(which) {
    const imgs = chevrons();
    if (imgs.length < 2) return null;
    const img = which === 'next' ? imgs[imgs.length - 1] : imgs[0];
    if (/grey/i.test(img.getAttribute('src') || '')) return null;
    return img.closest('button,[role=button]') || img;
  }

  function readSlots() {
    const seen = new Set();
    const out = [];
    leaves(/^Slot Time/i).forEach(function (l) {
      let card = l;
      while (card && card !== document.body && getComputedStyle(card).cursor !== 'pointer') card = card.parentElement;
      if (!card || card === document.body) {
        card = l.parentElement || l;
      } else {
        while (card.parentElement && card.parentElement !== document.body && getComputedStyle(card.parentElement).cursor === 'pointer' && leaves(/^Slot Time/i, card.parentElement).length <= 1) card = card.parentElement;
      }
      if (seen.has(card)) return;
      seen.add(card);
      let time = txt(l).replace(/^Slot Time\s*:?\s*/i, '');
      if (!time) {
        const m = txt(card).match(/\d{1,2}(:\d{2})?\s*[ap]\.?m\.?/i);
        time = m ? m[0] : '';
      }
      const countLeaf = leaves(/^\d+$/, card)[0];
      const available = countLeaf ? parseInt(txt(countLeaf), 10) : null;
      const full = available === 0 || /quota\s*full|not\s*available|sold\s*out/i.test(txt(card));
      out.push({ card: card, time: time, available: available, full: full });
    });
    return out;
  }

  async function setTickets(n) {
    n = String(n);
    const fail = 'Could not choose ' + n + ' tickets (the site allows 1-6).';
    const inp = await waitFor(function () { return $('input[label="Number of Tickets"]'); }, 3000);
    if (!inp) throw new Error(fail);
    if (inp.value === n) return;
    click(inp);
    const li = await waitFor(function () {
      return Array.from(document.querySelectorAll('li')).find(function (l) {
        return visible(l) && !mine(l) && txt(l) === n;
      });
    }, 3000);
    if (!li) throw new Error(fail);
    click(li);
    const ok = await waitFor(function () { return inp.value === n; }, 3000);
    if (!ok) throw new Error(fail);
  }

  function parsePrefs() {
    return String(S.prefs || 'any').split(/[\n;]+/).map(function (s) { return s.trim(); }).filter(Boolean).map(function (s) {
      let m = s.match(/^any\b\s*(.*)$/i);
      if (m) return { any: true, time: m[1].trim(), text: s };
      m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s*(.*)$/);
      if (m) return { y: +m[1], m: +m[2], d: +m[3], time: m[4].trim(), text: s };
      m = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})\s*(.*)$/);
      if (m) return { y: +m[3], m: +m[2], d: +m[1], time: m[4].trim(), text: s };
      log('Skipping a line I do not understand: ' + s);
      return null;
    }).filter(Boolean);
  }

  function slotOk(s, want) {
    return !s.full && (!want || timeKey(s.time) === want) && (s.available == null || s.available >= S.count);
  }

  async function openDay(day, monLabel) {
    const d = readDays().find(function (x) { return x.day === day; });
    if (!d) return [];
    click(deepest(d.el));
    const ok = await waitFor(function () { return leaves(/^Select any 1 Slot/i)[0]; }, 5000);
    if (!ok) {
      log(day + ' ' + monLabel + ': no slots appeared');
      return [];
    }
    await setTickets(S.count);
    await sleep(400);
    const slots = readSlots();
    log(day + ' ' + monLabel + ': ' + (slots.map(function (s) {
      return s.time + ' (' + (s.available == null ? '?' : s.available) + (s.full ? ', full' : '') + ')';
    }).join(', ') || 'no slots'));
    return slots;
  }

  async function findSlotOnce() {
    const prefs = parsePrefs();
    if (!prefs.length) prefs.push({ any: true, time: '', text: 'any' });
    let moves = 0;
    for (let pass = 0; pass < 3; pass++) {
      const mon = readMonth();
      if (!mon) {
        log('I cannot see the calendar. Open the Special Entry Darshan slot page first.');
        return null;
      }
      const open = readDays().filter(function (d) { return d.bookable; });
      log(mon.label + ': open days ' + (open.map(function (d) {
        return d.day + (d.status === 'Filling Fast' ? '*' : '');
      }).join(', ') || 'none'));
      const cache = new Map();
      let current = null;
      for (const p of prefs) {
        const cands = p.any ? open : open.filter(function (d) {
          return p.y === mon.year && p.m === mon.month && d.day === p.d;
        });
        const want = p.time ? timeKey(p.time) : '';
        for (const d of cands) {
          let slots = cache.get(d.day);
          if (!slots) {
            slots = await openDay(d.day, mon.label);
            cache.set(d.day, slots);
            current = d.day;
          }
          let hit = slots.find(function (s) { return slotOk(s, want); });
          if (!hit) continue;
          if (current !== d.day) {
            slots = await openDay(d.day, mon.label);
            cache.set(d.day, slots);
            current = d.day;
            hit = slots.find(function (s) { return slotOk(s, want); });
            if (!hit) continue;
          }
          return { day: d.day, month: mon.label, slot: hit };
        }
      }
      if (pass === 2) break;
      const next = arrow('next');
      if (!next) break;
      click(next);
      moves++;
      await sleep(1200);
    }
    for (let i = 0; i < moves; i++) {
      const prev = arrow('prev');
      if (!prev) break;
      click(prev);
      await sleep(1200);
    }
    return null;
  }

  function watchEnded() {
    if (!S.watchUntil) return false;
    const parts = S.watchUntil.split(':');
    const end = new Date();
    end.setHours(parseInt(parts[0], 10) || 0, parseInt(parts[1], 10) || 0, 0, 0);
    return Date.now() > end.getTime();
  }

  function findButton(re) {
    return buttons().find(function (b) { return re.test(btnText(b)); });
  }

  async function findAndContinue() {
    if (running) {
      log('Already running. Press Stop first if you want to start again.');
      return;
    }
    running = true;
    stopFlag = false;
    try {
      readPanel();
      if (S.queue.trim()) applyQueue();
      const ans = prompt('Extra laddus (\u20b950 each). Keep 10 or type a new number:', S.laddus);
      if (ans === null) {
        log('Cancelled.');
        return;
      }
      S.laddus = String(Math.max(0, parseInt(ans, 10) || 0));
      const lb = $('#ttdh-laddus');
      if (lb) lb.value = S.laddus;
      save();
      for (let i = 0; i < S.count; i++) {
        const m = S.members[i] || {};
        if (!m.name || !m.age || !m.gender) throw new Error('Fill name, age and gender for member ' + (i + 1) + ' first.');
      }
      for (;;) {
        const found = await findSlotOnce();
        if (found) {
          click(found.slot.card);
          log('Selected ' + found.day + ' ' + found.month + ' ' + found.slot.time + ' for ' + S.count + ' member(s).');
          await sleep(300);
          const lad = $('input[label="No. of Additional Laddus"]');
          if (lad && S.laddus !== '') setValue(lad, S.laddus);
          const hundi = $('input[label="Hundi Offerings"]');
          if (hundi && S.hundi !== '') setValue(hundi, S.hundi);
          if (S.dryRun) {
            log('Dry run: stopped before Continue. Check the page, then press Continue yourself or untick "Dry run".');
            return;
          }
          S.stage = 'fill';
          save();
          const cont = findButton(/^continue$/i);
          if (!cont) throw new Error('Could not find the Continue button.');
          click(cont);
          const ok = await waitFor(function () { return pilgrimFields().length >= 2; }, 20000);
          if (ok) await fillPilgrims();
          else log('The pilgrim page did not appear yet. Press "Fill pilgrims" when it does.');
          return;
        }
        if (!S.watch) {
          log('No slot matches your dates. Tick "Wait for slots" to keep checking.');
          return;
        }
        if (watchEnded()) {
          log('Watch time ' + S.watchUntil + ' has passed. Stopped.');
          return;
        }
        const sec = Math.max(MIN_REFRESH_SEC, S.refreshSec);
        log('Nothing yet. Checking again in ' + sec + ' s...');
        await waitSec(sec);
        const r = findButton(/^refresh$/i);
        if (r) click(r);
        else log('Refresh button not found; checking the page again.');
        await sleep(1500);
      }
    } catch (e) {
      log('Stopped: ' + e.message);
    } finally {
      running = false;
    }
  }

  /* ---------- Page 2: pilgrim page ---------- */

  function labelOf(el) {
    const attrs = [el.getAttribute('label'), el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('name')];
    for (const v of attrs) if (v && v.trim()) return v.trim();
    if (el.id) {
      const l = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]');
      if (l && txt(l)) return txt(l);
    }
    let p = el.parentElement;
    for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
      const t = txt(p);
      if (t) return t.slice(0, 60);
    }
    return '';
  }

  function pilgrimFields() {
    const out = [];
    document.querySelectorAll('input, select, textarea').forEach(function (el) {
      if (mine(el) || !visible(el)) return;
      const t = String(el.type || '').toLowerCase();
      if (['hidden', 'checkbox', 'radio', 'submit', 'button'].indexOf(t) >= 0) return;
      const label = labelOf(el);
      if (SKIP_RE.test(label)) return;
      const k = KINDS.find(function (k) { return k[1].test(label); });
      if (k) out.push({ el: el, kind: k[0], label: label });
    });
    return out;
  }

  async function chooseOption(el, want) {
    const w = norm(want);
    if (!w) return false;
    if (el.tagName === 'SELECT') {
      const o = Array.from(el.options).find(function (o) { return norm(o.text).indexOf(w) === 0 || o.value === want; });
      if (!o) return false;
      setValue(el, o.value);
      return true;
    }
    if (el.readOnly) {
      click(el);
      const opt = await waitFor(function () {
        return Array.from(document.querySelectorAll('li,[role=option]')).find(function (o) {
          if (mine(o) || !visible(o)) return false;
          const t = norm(txt(o));
          return t && (t.indexOf(w) === 0 || w.indexOf(t) === 0);
        });
      }, 3000);
      if (!opt) {
        click(el);
        return false;
      }
      click(opt);
      await sleep(250);
      return true;
    }
    setValue(el, want);
    return true;
  }

  async function fillPilgrims() {
    if (filling) return;
    filling = true;
    const panel = $('#ttdh');
    let filled = 0;
    const misses = [];
    try {
      readPanel();
      if (S.queue.trim()) applyQueue();
      save();
      const fields = pilgrimFields();
      try {
        localStorage[LEARNED_KEY] = JSON.stringify({
          at: new Date().toISOString(),
          url: location.pathname,
          fields: fields.map(function (f) { return f.kind + '="' + f.label + '"'; })
        });
      } catch (e) { /* storage full or blocked */ }
      if (panel) panel.style.pointerEvents = 'none';
      const idx = {};
      for (const f of fields) {
        const n = idx[f.kind] || 0;
        idx[f.kind] = n + 1;
        if (n >= S.count) continue;
        const v = String((S.members[n] || {})[f.kind] || '');
        if (!v) continue;
        if (norm(f.el.value) === norm(v)) continue;
        let ok = true;
        if (f.kind === 'gender' || f.kind === 'idType') ok = await chooseOption(f.el, v);
        else setValue(f.el, v);
        if (ok) filled++;
        else misses.push('member ' + (n + 1) + ' ' + f.kind);
        await sleep(120);
      }
      const C = S.contact || {};
      for (const cf of CONTACT_FIELDS) {
        const v = C[cf[0]];
        if (!v) continue;
        const el = Array.from(document.querySelectorAll('input')).find(function (i) {
          return !mine(i) && visible(i) && !i.value && cf[1].test(labelOf(i));
        });
        if (!el) continue;
        let ok = true;
        if (el.readOnly) ok = await chooseOption(el, v);
        else setValue(el, v);
        if (ok) filled++;
        else misses.push(cf[0]);
        await sleep(120);
      }
    } catch (e) {
      log('Stopped: ' + e.message);
    } finally {
      if (panel) panel.style.pointerEvents = '';
      S.stage = '';
      save();
      filling = false;
    }
    log('Filled ' + filled + ' field(s).' + (misses.length ? ' Could not fill: ' + misses.join(', ') + '.' : ''));
    log('Check every detail, tick Terms and conditions, press Continue, then press Pay Now yourself. I will retry Pay Now if the site fails.');
  }

  /* ---------- Pay Now safe retry ---------- */

  function payButton() {
    return buttons().find(function (b) {
      return PAY_RE.test(btnText(b)) && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
    });
  }

  function popupTexts() {
    return Array.from(document.querySelectorAll(POPUP_SEL))
      .filter(function (e) { return visible(e) && !mine(e); })
      .map(txt)
      .filter(Boolean);
  }

  function redirectButton() {
    const dialogs = Array.from(document.querySelectorAll(DIALOG_SEL)).filter(function (d) {
      if (!visible(d) || mine(d)) return false;
      const t = txt(d);
      return !FAIL_RE.test(t) && !STOP_RE.test(t);
    });
    for (const d of dialogs) {
      const b = Array.from(d.querySelectorAll(BTN_SEL)).find(function (b) {
        return visible(b) && REDIRECT_OK_RE.test(btnText(b));
      });
      if (b) return b;
    }
    return null;
  }

  function leftTtd(startHref) {
    return location.hostname !== TTD_HOST || (GATEWAY_RE.test(location.href) && location.href !== startHref);
  }

  async function payRetryLoop() {
    payRunning = true;
    stopFlag = false;
    let tries = 1;
    const max = Math.min(MAX_PAY_TRIES, Math.max(1, parseInt(S.payTries, 10) || 1));
    const gap = Math.max(MIN_PAY_GAP_SEC, parseInt(S.payGapSec, 10) || MIN_PAY_GAP_SEC);
    const start = location.href;
    const baseline = new Set(popupTexts());
    let leaving = false;
    const onUnload = function () { leaving = true; };
    window.addEventListener('beforeunload', onUnload);
    const origConfirm = window.confirm;
    window.confirm = function (m) {
      log('Auto-accepted: ' + m);
      return true;
    };
    try {
      log('Pay Now pressed (try 1 of ' + max + ')...');
      for (;;) {
        const r = await waitFor(function () {
          if (leaving || leftTtd(start)) return { t: 'leave' };
          const rb = redirectButton();
          if (rb) return { t: 'redirect', el: rb };
          const texts = popupTexts().filter(function (t) { return !baseline.has(t); });
          const st = texts.find(function (t) { return STOP_RE.test(t); });
          if (st) return { t: 'stop', msg: st };
          const f = texts.find(function (t) { return FAIL_RE.test(t); });
          if (f) return { t: 'fail', msg: f };
          return null;
        }, 25000);
        if (r && r.t === 'leave') {
          log('Leaving TTD for the payment page. Complete the payment yourself.');
          return;
        }
        if (r && r.t === 'redirect') {
          log('Pressing "' + btnText(r.el) + '" in the site popup.');
          click(r.el);
          await sleep(1500);
          continue;
        }
        if (r && r.t === 'stop') {
          log('Stopped, the site says: "' + r.msg.slice(0, 160) + '" Check My Bookings before trying again.');
          return;
        }
        if (tries >= max) {
          log('Gave up after ' + tries + ' tries. Check My Bookings / your bank before trying again.');
          return;
        }
        log(r ? 'Site error: "' + r.msg.slice(0, 160) + '"' : 'No answer from the site in 25 s.');
        const closeBtn = findButton(/^(ok|okay|close|\u00d7|x)$/i);
        if (closeBtn) click(closeBtn);
        for (let i = 0; i < gap * 10 && !leaving; i++) {
          if (stopFlag) throw new Error('Stopped by you.');
          await sleep(100);
        }
        if (leaving || leftTtd(start)) {
          log('Leaving TTD for the payment page. Complete the payment yourself.');
          return;
        }
        const pb = payButton();
        if (!pb) {
          log('Pay Now button is gone. Not retrying. Check My Bookings.');
          return;
        }
        tries++;
        log('Retrying Pay Now (try ' + tries + ' of ' + max + ')');
        click(pb);
      }
    } catch (e) {
      log('Stopped: ' + e.message);
    } finally {
      window.confirm = origConfirm;
      window.removeEventListener('beforeunload', onUnload);
      payRunning = false;
    }
  }

  document.addEventListener('click', function (e) {
    if (!S.payRetry || payRunning || !e.isTrusted) return;
    const t = e.target;
    const b = t && t.closest ? t.closest('button, a, [role=button], input[type=submit], input[type=button]') : null;
    if (!b || mine(b) || !PAY_RE.test(btnText(b))) return;
    payRunning = true;
    setTimeout(payRetryLoop, 0);
  }, true);

  /* ---------- Quick list ---------- */

  function parseLine(line) {
    const p = line.split(/\s*[,|\t]\s*/).map(function (s) { return s.trim(); });
    const name = p[0] || '';
    const age = p[1] || '';
    const g = (p[2] || '').toLowerCase();
    const idt = p[3] || '';
    const idn = p[4] || '';
    let gender = p[2] || '';
    if (/^f/.test(g)) gender = 'Female';
    else if (/^t/.test(g)) gender = 'Transgender';
    else if (/^m/.test(g)) gender = 'Male';
    const il = idt.toLowerCase();
    let idType = idt;
    if (/^a+dh?a+r/.test(il)) idType = 'Aadhaar Card';
    else if (/^pass/.test(il)) idType = 'Passport';
    else if (/voter|epic/.test(il)) idType = 'Voter ID';
    else if (/driv|^dl$/.test(il)) idType = 'Driving License';
    else if (/^pan/.test(il)) idType = 'PAN Card';
    return { name: name, age: age.replace(/\D/g, ''), gender: gender, idType: idType, idNo: idn.replace(/\s+/g, '') };
  }

  function queueLines() {
    return String(S.queue || '').split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function applyQueue() {
    const lines = queueLines();
    if (!lines.length) {
      log('The quick list is empty.');
      return;
    }
    const use = lines.slice(0, 6);
    S.members = use.map(parseLine);
    S.count = use.length;
    save();
    log('Using ' + use.length + ' member(s) from the list; ' + (lines.length - use.length) + ' waiting.');
    const c = $('#ttdh-count');
    if (c) c.value = String(S.count);
    renderMembers();
  }

  function nextGroup() {
    readPanel();
    const lines = queueLines();
    if (lines.length <= 6) {
      log('No more members waiting');
      return;
    }
    S.queue = lines.slice(6).join('\n');
    save();
    const q = $('#ttdh-queue');
    if (q) q.value = S.queue;
    applyQueue();
  }

  /* ---------- The panel ---------- */

  const CSS_TEXT = [
    '#ttdh{position:fixed;right:8px;bottom:8px;z-index:2147483647;width:min(360px,94vw);max-height:85vh;overflow:auto;background:#fff;color:#222;border:2px solid #6a1b9a;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.35);font:14px system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;padding:10px;box-sizing:border-box;text-align:left;line-height:1.35}',
    '#ttdh *{box-sizing:border-box;font-family:inherit}',
    '#ttdh.ttdh-min{width:auto}',
    '#ttdh.ttdh-min #ttdh-body{display:none}',
    '#ttdh .ttdh-head{display:flex;justify-content:space-between;align-items:center;gap:8px}',
    '#ttdh .ttdh-head b{color:#6a1b9a;font-size:15px}',
    '#ttdh label{display:block;margin:6px 0 0}',
    '#ttdh input:not([type=checkbox]),#ttdh select,#ttdh textarea{width:100%;font-size:16px;padding:6px;margin:2px 0 4px;border:1px solid #bbb;border-radius:6px;background:#fff;color:#222}',
    '#ttdh input.ttdh-sm{width:64px;display:inline-block;margin:2px 2px}',
    '#ttdh input.ttdh-time{width:110px}',
    '#ttdh input[type=checkbox]{width:18px;height:18px;vertical-align:middle;margin:0 4px 0 0}',
    '#ttdh .ttdh-chk{margin:6px 0}',
    '#ttdh .ttdh-chk label{display:inline;margin:0}',
    '#ttdh .ttdh-row{display:flex;gap:6px}',
    '#ttdh .ttdh-row>*{flex:1;min-width:0}',
    '#ttdh fieldset{border:1px solid #ddd;border-radius:8px;padding:4px 8px;margin:6px 0}',
    '#ttdh legend{font-weight:bold;color:#6a1b9a;padding:0 4px}',
    '#ttdh button{background:#6a1b9a;color:#fff;border:0;border-radius:6px;padding:8px 10px;margin:3px 2px;font-size:14px;cursor:pointer}',
    '#ttdh button.ttdh-2{background:#777}',
    '#ttdh pre#ttdh-log{background:#f3e5f5;max-height:160px;overflow:auto;font-size:12px;white-space:pre-wrap;word-break:break-word;padding:6px;border-radius:6px;margin:6px 0 0;font-family:ui-monospace,Menlo,Consolas,monospace}'
  ].join('\n');

  function opts(list, sel, blank) {
    const all = sel && list.indexOf(sel) < 0 ? list.concat([sel]) : list;
    return (blank ? '<option value="">' + esc(blank) + '</option>' : '') + all.map(function (o) {
      return '<option value="' + esc(o) + '"' + (o === sel ? ' selected' : '') + '>' + esc(o) + '</option>';
    }).join('');
  }

  function panelHtml() {
    const c = S.contact || {};
    const counts = [1, 2, 3, 4, 5, 6].map(function (n) {
      return '<option value="' + n + '"' + (n === S.count ? ' selected' : '') + '>' + n + '</option>';
    }).join('');
    const chk = function (b) { return b ? ' checked' : ''; };
    return '<style>' + CSS_TEXT + '</style>' +
      '<div class="ttdh-head"><b>TTD Helper</b><button type="button" class="ttdh-2" id="ttdh-min" data-act="min" title="Minimise / restore">_</button></div>' +
      '<div id="ttdh-body">' +
      '<label>Quick list, one member per line<textarea id="ttdh-queue" rows="3" placeholder="Ravi Kumar, 34, M, Aadhaar, 123412341234">' + esc(S.queue) + '</textarea></label>' +
      '<button type="button" data-act="use">Use list</button><button type="button" class="ttdh-2" data-act="next">Next group</button>' +
      '<label>Members<select id="ttdh-count">' + counts + '</select></label>' +
      '<div id="ttdh-members"></div>' +
      '<label>Dates / slots in order, one per line<textarea id="ttdh-prefs" rows="3" placeholder="any&#10;2027-02-23 8:00 pm&#10;24/02/2027">' + esc(S.prefs) + '</textarea></label>' +
      '<div class="ttdh-row"><label>Extra laddus<input id="ttdh-laddus" type="number" min="0" inputmode="numeric" value="' + esc(S.laddus) + '"></label>' +
      '<label>Hundi (\u20b9)<input id="ttdh-hundi" type="number" min="0" inputmode="numeric" value="' + esc(S.hundi) + '"></label></div>' +
      '<fieldset><legend>Contact (filled once per booking)</legend>' +
      '<input id="ttdh-email" type="email" placeholder="Email" autocomplete="email" value="' + esc(c.email) + '">' +
      '<div class="ttdh-row"><input id="ttdh-city" placeholder="City" value="' + esc(c.city) + '"><input id="ttdh-state" placeholder="State" value="' + esc(c.state) + '"></div>' +
      '<div class="ttdh-row"><input id="ttdh-country" placeholder="Country" value="' + esc(c.country) + '"><input id="ttdh-pin" placeholder="Pincode" inputmode="numeric" value="' + esc(c.pincode) + '"></div>' +
      '</fieldset>' +
      '<div class="ttdh-chk"><label><input type="checkbox" id="ttdh-dry"' + chk(S.dryRun) + '>Dry run (stop before Continue)</label></div>' +
      '<div class="ttdh-chk"><label><input type="checkbox" id="ttdh-watch"' + chk(S.watch) + '>Wait for slots:</label> refresh every <input class="ttdh-sm" id="ttdh-every" type="number" min="' + MIN_REFRESH_SEC + '" value="' + esc(S.refreshSec) + '"> s until <input class="ttdh-sm ttdh-time" id="ttdh-until" type="time" value="' + esc(S.watchUntil) + '"></div>' +
      '<div class="ttdh-chk"><label><input type="checkbox" id="ttdh-pay"' + chk(S.payRetry) + '>After I press Pay Now, retry</label> up to <input class="ttdh-sm" id="ttdh-paytries" type="number" min="1" max="' + MAX_PAY_TRIES + '" value="' + esc(S.payTries) + '"> times, every <input class="ttdh-sm" id="ttdh-paygap" type="number" min="' + MIN_PAY_GAP_SEC + '" value="' + esc(S.payGapSec) + '"> s</div>' +
      '<div><button type="button" data-act="save">Save</button><button type="button" data-act="find">Find slot &amp; continue</button><button type="button" data-act="fill">Fill pilgrims</button><button type="button" class="ttdh-2" data-act="stop">Stop</button><button type="button" class="ttdh-2" data-act="clear">Clear my data</button></div>' +
      '<pre id="ttdh-log"></pre>' +
      '</div>';
  }

  function renderMembers() {
    const box = $('#ttdh-members');
    if (!box) return;
    let h = '';
    for (let i = 0; i < S.count; i++) {
      const m = S.members[i] || {};
      h += '<fieldset><legend>Member ' + (i + 1) + '</legend>' +
        '<input data-m="' + i + '" data-k="name" placeholder="Full name as on ID" value="' + esc(m.name) + '">' +
        '<div class="ttdh-row"><input data-m="' + i + '" data-k="age" type="number" min="1" max="120" inputmode="numeric" placeholder="Age" value="' + esc(m.age) + '">' +
        '<select data-m="' + i + '" data-k="gender">' + opts(GENDERS, m.gender || '', 'Gender') + '</select></div>' +
        '<select data-m="' + i + '" data-k="idType">' + opts(ID_TYPES, m.idType || 'Aadhaar Card') + '</select>' +
        '<input data-m="' + i + '" data-k="idNo" placeholder="ID number" autocomplete="off" value="' + esc(m.idNo) + '">' +
        '</fieldset>';
    }
    box.innerHTML = h;
  }

  function readPanel() {
    const p = $('#ttdh');
    if (!p) return;
    const v = function (id) { const e = $('#ttdh-' + id); return e ? String(e.value).trim() : ''; };
    const ch = function (id) { const e = $('#ttdh-' + id); return !!(e && e.checked); };
    S.queue = v('queue');
    S.count = Math.min(6, Math.max(1, parseInt(v('count'), 10) || 1));
    p.querySelectorAll('[data-m]').forEach(function (e) {
      const i = parseInt(e.getAttribute('data-m'), 10);
      S.members[i] = S.members[i] || {};
      S.members[i][e.getAttribute('data-k')] = String(e.value).trim();
    });
    S.members = S.members.slice(0, S.count);
    S.prefs = v('prefs');
    S.laddus = v('laddus');
    S.hundi = v('hundi');
    S.contact = { email: v('email'), city: v('city'), state: v('state'), country: v('country'), pincode: v('pin') };
    S.dryRun = ch('dry');
    S.watch = ch('watch');
    S.refreshSec = Math.max(MIN_REFRESH_SEC, parseInt(v('every'), 10) || MIN_REFRESH_SEC);
    S.watchUntil = v('until');
    S.payRetry = ch('pay');
    S.payTries = Math.min(MAX_PAY_TRIES, Math.max(1, parseInt(v('paytries'), 10) || 1));
    S.payGapSec = Math.max(MIN_PAY_GAP_SEC, parseInt(v('paygap'), 10) || MIN_PAY_GAP_SEC);
    const set = function (id, val) { const e = $('#ttdh-' + id); if (e) e.value = String(val); };
    set('every', S.refreshSec);
    set('paytries', S.payTries);
    set('paygap', S.payGapSec);
  }

  function applyMin() {
    const p = $('#ttdh');
    if (!p) return;
    p.classList.toggle('ttdh-min', !!S.minimized);
    const b = $('#ttdh-min');
    if (b) b.textContent = S.minimized ? '+' : '_';
  }

  function onPanelClick(e) {
    const b = e.target.closest ? e.target.closest('button[data-act]') : null;
    if (!b) return;
    const act = b.getAttribute('data-act');
    if (act === 'min') {
      S.minimized = !S.minimized;
      save();
      applyMin();
    } else if (act === 'use') {
      readPanel();
      applyQueue();
    } else if (act === 'next') {
      nextGroup();
    } else if (act === 'save') {
      readPanel();
      save();
      log('Saved (only in this browser).');
    } else if (act === 'find') {
      findAndContinue();
    } else if (act === 'fill') {
      stopFlag = false;
      fillPilgrims();
    } else if (act === 'stop') {
      stopFlag = true;
      log('Stopping...');
    } else if (act === 'clear') {
      if (!nativeConfirm('Remove all your saved TTD Helper details from this browser?')) return;
      stopFlag = true;
      try {
        localStorage.removeItem(KEY);
        localStorage.removeItem(LEARNED_KEY);
      } catch (err) { /* storage blocked */ }
      S = load();
      build();
      log('Your data was removed from this browser.');
    }
  }

  function onPanelChange(e) {
    if (e.target && e.target.id === 'ttdh-count') {
      readPanel();
      renderMembers();
    } else {
      readPanel();
    }
    save();
  }

  function build() {
    const old = $('#ttdh');
    const oldLog = old && old.querySelector('#ttdh-log') ? old.querySelector('#ttdh-log').textContent : '';
    if (old) old.remove();
    const p = document.createElement('div');
    p.id = 'ttdh';
    p.innerHTML = panelHtml();
    document.body.appendChild(p);
    p.addEventListener('click', onPanelClick);
    p.addEventListener('change', onPanelChange);
    renderMembers();
    applyMin();
    const lg = p.querySelector('#ttdh-log');
    if (lg && oldLog) lg.textContent = oldLog;
  }

  function show() {
    if (!$('#ttdh')) build();
    S.minimized = false;
    save();
    applyMin();
  }

  function scan() {
    const mon = readMonth();
    return {
      month: mon ? mon.label : null,
      days: readDays().filter(function (d) { return d.status !== 'Other month'; }).map(function (d) { return { day: d.day, status: d.status }; }),
      slots: readSlots().map(function (s) { return { time: s.time, available: s.available, full: s.full }; }),
      payButton: !!payButton(),
      pilgrimFields: pilgrimFields().map(function (f) { return { kind: f.kind, label: f.label }; })
    };
  }

  window.__ttdHelper = { show: show, find: findAndContinue, fill: fillPilgrims, scan: scan };

  build();
  log('Ready. Log in yourself, open Special Entry Darshan, then press "Find slot & continue".');

  if (S.stage === 'fill') {
    (async function () {
      try {
        const ok = await waitFor(function () { return pilgrimFields().length >= 2; }, 15000);
        if (ok) {
          await fillPilgrims();
        } else {
          S.stage = '';
          save();
          log('Press "Fill pilgrims" when the pilgrim details page is open.');
        }
      } catch (e) {
        log('Stopped: ' + e.message);
      }
    })();
  }
})();
