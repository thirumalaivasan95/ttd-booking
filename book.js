#!/usr/bin/env node
'use strict';

/*
 * TTD Special Entry Darshan booking helper (personal use).
 * Double-click "Start TTD Booking.vbs". A browser opens with a form for your details.
 * Then: log in with your OTP -> it waits for release time -> grabs the first free slot ->
 * fills every pilgrim -> ticks Terms -> clicks Pay Now. You pay on the gateway yourself.
 * It never types the OTP, never skips the TTD queue, and never pays.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const SLOT_URL = 'https://ttdevasthanams.ap.gov.in/slot-booking?flow=sed&flowIdentifier=sed';
const TTD_HOST = 'ttdevasthanams.ap.gov.in';
const DETAILS = path.join(__dirname, 'details.json');
const PROFILE = path.join(__dirname, '.browser-profile');
const LOGFILE = path.join(__dirname, 'book.log');
const MIN_REFRESH_SEC = 10;

const ID_TYPES = ['Aadhaar Card', 'Passport', 'Voter ID', 'Driving License', 'PAN Card'];
const ID_TYPE_RE = { 'Aadhaar Card': 'a+dh?a+r', 'Passport': 'passport', 'Voter ID': 'voter|epic', 'Driving License': 'driv', 'PAN Card': '^\\s*pan' };
const PAY_RE = /^\s*(pay\s*now|proceed\s*to\s*pay(ment)?|make\s*payment|pay\s*(rs\.?|\u20b9)\s*[\d,.]+|confirm\s*(and|&)\s*pay)\s*$/i;
const FAIL_RE = /(try\s*again|server\s*(is\s*)?busy|too\s*many|unable\s*to|something\s*went\s*wrong|failed|time\s*d?\s*out|timeout|error|not\s*responding|high\s*traffic)/i;
const STOP_RE = /(already|in\s*progress|pending|duplicate|session\s*expired|login\s*again|quota\s*is\s*full|no\s*tickets|sold\s*out|booking\s*(is\s*)?(confirmed|successful))/i;
const GATEWAY_RE = /payment|gateway|billdesk|razorpay|payu|ccavenue|sbiepay/i;
const QUEUE_RE = /(waiting\s*room|you\s*are\s*(now\s*)?in\s*(the\s*)?(queue|line)|queue\s*(position|number)|your\s*(position|turn)|estimated\s*wait)/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const timeKey = (s) => norm(s).replace(/00/g, '');

/* ---------------- Status (console + log file + purple bar in the browser) ---------------- */

let statusPage = null;
let lastMsg = '';

function status(msg) {
  lastMsg = msg;
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOGFILE, line + '\n'); } catch (e) { /* ignore */ }
  if (statusPage) statusPage.evaluate((m) => window.__ttdbotSet && window.__ttdbotSet(m), msg).catch(() => {});
}

const STATUS_BAR = `(() => {
  const mk = () => {
    if (!document.body || document.getElementById('ttdbot-status')) return;
    const d = document.createElement('div');
    d.id = 'ttdbot-status';
    d.style.cssText = 'position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:2147483647;background:#6a1b9a;color:#fff;padding:8px 18px;border-radius:0 0 12px 12px;font:600 15px system-ui,sans-serif;max-width:92vw;box-shadow:0 3px 12px rgba(0,0,0,.35);pointer-events:none;text-align:center';
    d.textContent = window.__ttdbotMsg || 'TTD helper running';
    document.body.appendChild(d);
  };
  const mkBtn = () => {
    if (!document.body || document.getElementById('ttdbot-go') || !/ttdevasthanams/.test(location.host)) return;
    const b = document.createElement('button');
    b.id = 'ttdbot-go';
    b.textContent = 'Logged in? Go to booking';
    b.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;background:#6a1b9a;color:#fff;border:0;border-radius:10px;padding:12px 16px;font:600 15px system-ui,sans-serif;cursor:pointer;box-shadow:0 3px 12px rgba(0,0,0,.35)';
    b.onclick = () => { if (window.ttdbotGo) window.ttdbotGo(); };
    document.body.appendChild(b);
  };
  window.__ttdbotSet = (m) => { window.__ttdbotMsg = m; mk(); const e = document.getElementById('ttdbot-status'); if (e) e.textContent = m; };
  setInterval(mkBtn, 1000);
  document.addEventListener('DOMContentLoaded', mk);
  setInterval(mk, 1000);
})();`;

/* ---------------- The details form (shown in the browser) ---------------- */

function formHtml(old) {
  const data = JSON.stringify(old || {}).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><title>TTD Booking - your details</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font:16px system-ui,sans-serif;background:#f6f0fa;margin:0;padding:20px;color:#222}
form{max-width:640px;margin:0 auto;background:#fff;border:2px solid #6a1b9a;border-radius:14px;padding:20px}
h1{color:#6a1b9a;margin:0 0 4px;font-size:24px}.sub{color:#555;margin:0 0 14px}
label{display:block;margin:10px 0 4px;font-weight:600}
input,select,textarea{width:100%;box-sizing:border-box;font-size:16px;padding:8px;border:1px solid #bbb;border-radius:8px}
fieldset{border:1px solid #ddd;border-radius:10px;margin:10px 0;padding:8px 12px}legend{color:#6a1b9a;font-weight:700}
.row{display:flex;gap:8px;margin-top:6px}.row>*{flex:1}
.chk{display:flex;gap:8px;align-items:center;font-weight:400}.chk input{width:auto}
button{background:#6a1b9a;color:#fff;border:0;border-radius:10px;padding:14px;font-size:18px;width:100%;margin-top:16px;cursor:pointer}
.hint{font-weight:400;color:#666;font-size:13px}#err{color:#c62828;font-weight:600}
</style></head><body>
<form id="f" novalidate>
<h1>TTD Special Entry Darshan</h1>
<p class="sub">Fill this once. After you log in, the helper books the first free slot and takes you to Pay Now.</p>
<label>How many members?</label>
<select id="count">${[1, 2, 3, 4, 5, 6].map((n) => `<option>${n}</option>`).join('')}</select>
<div id="members"></div>
<label>Which slot?</label>
<select id="mode"><option value="first">First available slot (fastest)</option><option value="dates">Only these dates</option></select>
<div id="datesBox" style="display:none"><textarea id="prefs" rows="2" placeholder="2027-02-23 8 pm; 24/02/2027"></textarea>
<span class="hint">Best first, separated by ";". Time is optional.</span></div>
<label>When does TTD open booking? <span class="hint">(the release time, e.g. today 10:00 AM - NOT your darshan date. Leave blank if already open)</span></label>
<input id="releaseAt" type="datetime-local">
<label>If nothing is free, check again every (seconds, min ${MIN_REFRESH_SEC})</label>
<input id="refreshSec" type="number" min="${MIN_REFRESH_SEC}" value="${MIN_REFRESH_SEC}">
<label>Extra laddus (\u20b950 each)</label><input id="laddus" type="number" min="0" value="0">
<fieldset><legend>Contact</legend>
<input id="email" type="email" placeholder="Email">
<div class="row"><input id="city" placeholder="City"><input id="state" placeholder="State"></div>
<div class="row"><input id="pincode" placeholder="Pincode" inputmode="numeric"></div></fieldset>
<label class="chk"><input type="checkbox" id="autoTerms" checked> Tick "Terms and conditions" for me (I have read them)</label>
<label class="chk"><input type="checkbox" id="autoPay" checked> Click "Pay Now" for me (I pay on the payment page myself)</label>
<p id="err"></p>
<button type="submit">Save &amp; start</button>
</form>
<script>
const OLD = ${data};
const IDT = ${JSON.stringify(ID_TYPES)};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const $ = (id) => document.getElementById(id);
let members = (OLD.members || []).slice();
function collect() {
  document.querySelectorAll('#members fieldset').forEach((fs, i) => {
    const g = (k) => fs.querySelector('[name=' + k + ']').value.trim();
    members[i] = { name: g('name'), age: g('age'), gender: g('gender'), idType: g('idType'), idNo: g('idNo').replace(/\\s+/g, '') };
  });
}
function render() {
  collect();
  const n = +$('count').value;
  let h = '';
  for (let i = 0; i < n; i++) {
    const m = members[i] || {};
    h += '<fieldset><legend>Member ' + (i + 1) + '</legend>' +
      '<input name="name" placeholder="Full name exactly as on ID" value="' + esc(m.name) + '">' +
      '<div class="row"><input name="age" type="number" min="1" max="120" placeholder="Age" value="' + esc(m.age) + '">' +
      '<select name="gender"><option value="">Gender</option>' + ['Male', 'Female', 'Transgender'].map((g) => '<option' + (m.gender === g ? ' selected' : '') + '>' + g + '</option>').join('') + '</select></div>' +
      '<div class="row"><select name="idType">' + IDT.map((t) => '<option' + ((m.idType || IDT[0]) === t ? ' selected' : '') + '>' + t + '</option>').join('') + '</select>' +
      '<input name="idNo" placeholder="ID number" autocomplete="off" value="' + esc(m.idNo) + '"></div></fieldset>';
  }
  $('members').innerHTML = h;
}
$('count').value = String(Math.min(6, Math.max(1, members.length || 1)));
$('count').onchange = render;
$('mode').onchange = () => { $('datesBox').style.display = $('mode').value === 'dates' ? '' : 'none'; };
const prefs = OLD.prefs || ['any'];
if (!(prefs.length === 1 && /^any$/i.test(prefs[0]))) { $('mode').value = 'dates'; $('prefs').value = prefs.join('; '); $('mode').onchange(); }
['releaseAt', 'refreshSec', 'laddus', 'email', 'city', 'state', 'pincode'].forEach((k) => { if (OLD[k] != null && OLD[k] !== '') $(k).value = OLD[k]; });
if (OLD.autoTerms === false) $('autoTerms').checked = false;
if (OLD.autoPay === false) $('autoPay').checked = false;
render();
$('f').onsubmit = async (e) => {
  e.preventDefault();
  collect();
  const n = +$('count').value;
  const ms = members.slice(0, n);
  for (let i = 0; i < n; i++) {
    const m = ms[i];
    if (!m.name || !/^\\d{1,3}$/.test(m.age) || !m.gender || !m.idNo) { $('err').textContent = 'Fill name, age, gender and ID number for member ' + (i + 1) + '.'; return; }
  }
  const d = {
    members: ms,
    prefs: $('mode').value === 'first' ? ['any'] : $('prefs').value.split(/[;\\n]+/).map((s) => s.trim()).filter(Boolean),
    releaseAt: $('releaseAt').value,
    refreshSec: Math.max(${MIN_REFRESH_SEC}, parseInt($('refreshSec').value, 10) || ${MIN_REFRESH_SEC}),
    laddus: String(Math.max(0, parseInt($('laddus').value, 10) || 0)),
    email: $('email').value.trim(), city: $('city').value.trim(), state: $('state').value.trim(), pincode: $('pincode').value.trim(),
    autoTerms: $('autoTerms').checked, autoPay: $('autoPay').checked
  };
  if (!d.prefs.length) d.prefs = ['any'];
  $('err').textContent = '';
  await window.ttdSubmit(d);
  document.body.innerHTML = '<h2 style="text-align:center;color:#6a1b9a;margin-top:80px">Saved. Opening the TTD site...</h2>';
};
</script></body></html>`;
}

async function askForm(page) {
  let old = null;
  try { old = JSON.parse(fs.readFileSync(DETAILS, 'utf8')); } catch (e) { old = null; }
  let resolve;
  const got = new Promise((r) => { resolve = r; });
  await page.exposeFunction('ttdSubmit', (d) => { resolve(d); return true; });
  await page.setContent(formHtml(old));
  const d = await got;
  fs.writeFileSync(DETAILS, JSON.stringify(d, null, 2));
  return d;
}

/* ---------------- In-page readers (run inside the browser) ---------------- */

function pageReadCalendar() {
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const re = new RegExp('^(' + MONTHS.join('|') + ') (\\d{4})$');
  const COLORS = { 'rgb(163, 0, 14)': 'Quota Full', 'rgb(204, 204, 204)': 'Not Available', 'rgb(255, 255, 255)': 'Other month', 'rgb(255, 191, 0)': 'Filling Fast' };
  const txt = (e) => (e.textContent || '').replace(/\s+/g, ' ').trim();
  const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const labels = Array.from(document.querySelectorAll('div,span,p,h1,h2,h3,h4,h5,h6,button,label,td'))
    .filter((e) => e.childElementCount === 0 && re.test(txt(e)) && vis(e));
  const tables = Array.from(document.querySelectorAll('table')).filter(vis);
  if (!labels.length || !tables.length) return null;
  const bg = (el) => { let e = el; for (let i = 0; i <= 3 && e; i++) { const c = getComputedStyle(e).backgroundColor; if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c; e = e.firstElementChild; } return null; };
  document.querySelectorAll('[data-ttdbot-day]').forEach((e) => e.removeAttribute('data-ttdbot-day'));
  const months = [];
  const days = [];
  tables.forEach((t) => {
    const before = labels.filter((l) => l.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING);
    const lab = before[before.length - 1];
    if (!lab) return;
    const label = txt(lab);
    const mm = label.match(re);
    const month = MONTHS.indexOf(mm[1]) + 1;
    const year = +mm[2];
    months.push(label);
    t.querySelectorAll('td').forEach((td) => {
      const tx = txt(td);
      if (!/^\d{1,2}$/.test(tx)) return;
      const id = (td.id || '').match(/^(\d{1,2})\/(\d{1,2})$/);
      if (id && +id[2] + 1 !== month) return;
      const c = bg(td);
      if (!c) return;
      const st = COLORS[c] || 'Available';
      if (st === 'Other month') return;
      const key = `${year}-${month}-${tx}`;
      td.setAttribute('data-ttdbot-day', key);
      days.push({ key, day: +tx, month, year, label, status: st, bookable: st === 'Available' || st === 'Filling Fast' });
    });
  });
  if (!months.length) return null;
  return { label: months.join(', '), months, days };
}

function pageReadSlots() {
  const txt = (e) => (e.textContent || '').replace(/\s+/g, ' ').trim();
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const isSlot = (x) => x.childElementCount === 0 && /^Slot Time/i.test(txt(x));
  document.querySelectorAll('[data-ttdbot-card]').forEach((e) => e.removeAttribute('data-ttdbot-card'));
  const seen = new Set();
  const out = [];
  Array.from(document.querySelectorAll('div,span,p,li,label,td,button,h1,h2,h3,h4,h5,h6')).filter((e) => isSlot(e) && vis(e)).forEach((l) => {
    let card = l;
    while (card && card !== document.body && getComputedStyle(card).cursor !== 'pointer') card = card.parentElement;
    if (!card || card === document.body) card = l.parentElement || l;
    else {
      while (card.parentElement && card.parentElement !== document.body && getComputedStyle(card.parentElement).cursor === 'pointer'
        && Array.from(card.parentElement.querySelectorAll('*')).filter(isSlot).length <= 1) card = card.parentElement;
    }
    if (seen.has(card)) return;
    seen.add(card);
    let time = txt(l).replace(/^Slot Time\s*:?\s*/i, '');
    if (!time) { const mm = txt(card).match(/\d{1,2}(:\d{2})?\s*[ap]\.?m\.?/i); time = mm ? mm[0] : ''; }
    const cnt = Array.from(card.querySelectorAll('*')).find((e) => e.childElementCount === 0 && /^\d+$/.test(txt(e)));
    const available = cnt ? parseInt(txt(cnt), 10) : null;
    const full = available === 0 || /quota\s*full|not\s*available|sold\s*out/i.test(txt(card));
    card.setAttribute('data-ttdbot-card', String(out.length));
    out.push({ idx: out.length, time, available, full });
  });
  return out;
}

function pageMarkOption(src) {
  const re = new RegExp(src, 'i');
  const txt = (e) => (e.textContent || '').replace(/\s+/g, ' ').trim();
  document.querySelectorAll('[data-ttdbot-opt]').forEach((e) => e.removeAttribute('data-ttdbot-opt'));
  const o = Array.from(document.querySelectorAll('li,[role=option]')).find((e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && re.test(txt(e));
  });
  if (!o) return false;
  o.setAttribute('data-ttdbot-opt', '1');
  return true;
}

function pageMarkTerms() {
  const boxes = Array.from(document.querySelectorAll('input[type=checkbox]'));
  const box = boxes.find((b) => {
    let p = b;
    for (let i = 0; i < 5 && p; i++, p = p.parentElement) if (/terms/i.test(p.textContent || '')) return true;
    return false;
  }) || boxes[boxes.length - 1];
  if (!box) return false;
  box.setAttribute('data-ttdbot-terms', '1');
  return true;
}

function pagePopupTexts() {
  const sel = '[role=alert],[role=dialog],[role=alertdialog],[class*=toast i],[class*=snack i],[class*=error i],[class*=modal i],[class*=popup i],[class*=alert i]';
  return Array.from(document.querySelectorAll(sel)).filter((e) => {
    if (e.id === 'ttdbot-status') return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }).map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/* ---------------- Browser helpers ---------------- */

async function safeEval(page, fn, arg) {
  try { return await page.evaluate(fn, arg); } catch (e) { return null; }
}

async function waitUntil(fn, ms, step = 250) {
  const end = Date.now() + ms;
  for (;;) {
    const r = await fn();
    if (r) return r;
    if (Date.now() > end) return null;
    await sleep(step);
  }
}

async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 2500 }).catch(() => {});
}

function field(page, label) {
  const l = label.replace(/"/g, '\\"');
  return page.locator(`input[label="${l}" i], textarea[label="${l}" i], input[aria-label="${l}" i], input[placeholder="${l}" i]`);
}

async function fillText(loc, value) {
  if (!value) return 'skip';
  if ((await loc.inputValue().catch(() => '')).trim() === String(value)) return 'same';
  await loc.click();
  await loc.fill(String(value));
  return 'ok';
}

async function choose(page, loc, optionRe) {
  const val = (await loc.inputValue().catch(() => '')).trim();
  if (val && new RegExp(optionRe, 'i').test(val)) return 'same';
  await loc.click();
  const found = await waitUntil(() => safeEval(page, pageMarkOption, optionRe), 5000, 100);
  if (!found) {
    await page.keyboard.press('Escape').catch(() => {});
    return 'miss';
  }
  await page.locator('[data-ttdbot-opt="1"]').first().click();
  await sleep(150);
  return 'ok';
}

/* ---------------- Step 1: get to the calendar (login / queue aware) ---------------- */

let goRequested = false;
let calendarSeen = false;

function pageState() {
  const body = document.body ? document.body.innerText : '';
  const a = document.activeElement;
  const typing = !!(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && !a.closest('#ttdbot-status'));
  const loginForm = Array.from(document.querySelectorAll('input')).some((i) => {
    const r = i.getBoundingClientRect();
    const l = (i.getAttribute('label') || i.getAttribute('placeholder') || i.name || i.id || '') + ' ' + (i.closest('div') ? i.closest('div').innerText.slice(0, 80) : '');
    return r.width > 0 && /mobile|otp|captcha|phone/i.test(l);
  });
  const loggedIn = /log\s*out|logout|sign\s*out/i.test(body);
  return { typing, loginForm, loggedIn, queue: body.slice(0, 5000) };
}

async function ensureCalendar(page, d) {
  let lastAction = Date.now();
  for (;;) {
    if (await safeEval(page, pageReadCalendar)) { calendarSeen = true; return; }
    const u = page.url();
    const st = (await safeEval(page, pageState)) || { typing: true, loginForm: false, loggedIn: false, queue: '' };
    const onSlot = u.includes('slot-booking');
    if (QUEUE_RE.test(st.queue)) {
      status('You are in the TTD waiting queue. Keeping your place (not refreshing)...');
      lastAction = Date.now();
    } else if (st.typing || st.loginForm || /login|signin|otp/i.test(u)) {
      status('Log in: enter your mobile number, captcha and OTP. I will not touch the page while you type.');
      lastAction = Date.now();
    } else if (goRequested || (st.loggedIn && !onSlot)) {
      goRequested = false;
      if (!onSlot || Date.now() - lastAction > 3000) {
        status('Logged in. Opening Special Entry Darshan...');
        await page.goto(SLOT_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
        lastAction = Date.now();
      }
    } else if (!st.loggedIn && !calendarSeen) {
      status('Click "Log In" on the TTD page and log in with OTP. Then press the "Go to booking" button (bottom right).');
    } else if (onSlot && Date.now() - lastAction > d.refreshSec * 1000) {
      status('Slot page not ready yet, reloading...');
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      lastAction = Date.now();
    }
    await sleep(500);
  }
}

async function waitForRelease(page, d) {
  if (!d.releaseAt) return;
  const t = new Date(d.releaseAt).getTime();
  if (!(t > Date.now())) return;
  if (t - Date.now() > 36 * 3600 * 1000) {
    status(`Release time ${d.releaseAt} is more than 36 hours away - ignoring it and checking now.`);
    return;
  }
  for (;;) {
    const left = t - Date.now();
    if (left <= 0) break;
    const s = Math.ceil(left / 1000);
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    status(`Ready with ${d.members.length} member(s). Booking opens in ${hh ? hh + 'h ' : ''}${mm}m ${ss}s. Keep this window open.`);
    await sleep(Math.min(1000, left));
  }
  status('Release time! Loading fresh slots...');
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
}

/* ---------------- Step 2: find + select a slot ---------------- */

function parsePrefs(list) {
  return list.map((s) => {
    let m = s.match(/^any\b\s*(.*)$/i);
    if (m) return { any: true, time: m[1].trim() };
    m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s*(.*)$/);
    if (m) return { y: +m[1], m: +m[2], d: +m[3], time: m[4].trim() };
    m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})\s*(.*)$/);
    if (m) return { y: +m[3], m: +m[2], d: +m[1], time: m[4].trim() };
    return null;
  }).filter(Boolean);
}

async function setTickets(page, n) {
  const inp = field(page, 'Number of Tickets').first();
  await inp.waitFor({ state: 'visible', timeout: 8000 });
  if ((await inp.inputValue()) === String(n)) return;
  await inp.click();
  await page.locator('li:visible, [role="option"]:visible').filter({ hasText: new RegExp(`^\\s*${n}\\s*$`) }).first().click({ timeout: 5000 });
  const ok = await waitUntil(async () => (await inp.inputValue()) === String(n), 4000, 100);
  if (!ok) throw new Error(`Could not choose ${n} tickets (the site allows 1-6).`);
}

async function openDay(page, c, count) {
  await safeEval(page, pageReadCalendar);
  const td = page.locator(`[data-ttdbot-day="${c.key}"]`).first();
  await td.click({ timeout: 3000 }).catch(() => td.click({ force: true }));
  await page.getByText(/^\s*Select any 1 Slot/i).first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
  await setTickets(page, count);
  await settle(page);
  const slots = (await safeEval(page, pageReadSlots)) || [];
  status(`${c.day} ${c.label}: ${slots.map((s) => `${s.time} (${s.available == null ? '?' : s.available}${s.full ? ' full' : ''})`).join(', ') || 'no slots'}`);
  return slots;
}

async function findSlot(page, d) {
  const prefs = parsePrefs(d.prefs);
  if (!prefs.length) prefs.push({ any: true, time: '' });
  const count = d.members.length;
  const ok = (s, want) => !s.full && (!want || timeKey(s.time) === want) && (s.available == null || s.available >= count);
  const cal = await safeEval(page, pageReadCalendar);
  if (!cal) return null;
  const open = cal.days.filter((x) => x.bookable);
  const notReleased = cal.days.filter((x) => x.status === 'Not Available').length;
  status(open.length
    ? `Open dates: ${open.map((x) => `${x.day} ${x.label.slice(0, 3)}${x.status === 'Filling Fast' ? '*' : ''}`).join(', ')}`
    : `All dates full${notReleased ? ` (${notReleased} not released yet)` : ''}.`);
  const cache = new Map();
  let current = null;
  for (const p of prefs) {
    const cands = p.any ? open : open.filter((x) => p.y === x.year && p.m === x.month && x.day === p.d);
    const want = p.time ? timeKey(p.time) : '';
    for (const c of cands) {
      let slots = cache.get(c.key);
      if (!slots) {
        slots = await openDay(page, c, count);
        cache.set(c.key, slots);
        current = c.key;
      }
      let hit = slots.find((s) => ok(s, want));
      if (!hit) continue;
      if (current !== c.key) {
        slots = await openDay(page, c, count);
        cache.set(c.key, slots);
        current = c.key;
        hit = slots.find((s) => ok(s, want));
        if (!hit) continue;
      }
      return { day: c.day, month: c.label, slot: hit };
    }
  }
  return null;
}

async function selectSlot(page, d) {
  for (;;) {
    await ensureCalendar(page, d);
    let found = null;
    try { found = await findSlot(page, d); } catch (e) { status('Slot page changed: ' + e.message.split('\n')[0]); }
    if (found) {
      await page.locator(`[data-ttdbot-card="${found.slot.idx}"]`).first().click();
      status(`Selected ${found.day} ${found.month} ${found.slot.time} for ${d.members.length} member(s).`);
      const lad = field(page, 'No. of Additional Laddus').first();
      if (+d.laddus > 0 && await lad.count()) await fillText(lad, d.laddus).catch(() => status('Could not set laddus; set them yourself.'));
      return found;
    }
    status(`No free slot yet. Checking again in ${d.refreshSec}s...`);
    await sleep(d.refreshSec * 1000);
    const refresh = page.getByRole('button', { name: /^\s*refresh\s*$/i }).first();
    if (await refresh.count()) await refresh.click().catch(() => {});
    else await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await settle(page);
  }
}

/* ---------------- Step 3: pilgrim details ---------------- */

async function fillPilgrims(page, d) {
  const names = field(page, 'Name');
  await names.first().waitFor({ state: 'visible', timeout: 30000 });
  const n = Math.min(await names.count(), d.members.length);
  const misses = [];
  const run = async (what, p) => {
    try { if ((await p) === 'miss') misses.push(what); } catch (e) { misses.push(what); }
  };
  for (let i = 0; i < n; i++) {
    const m = d.members[i];
    await run(`member ${i + 1} name`, fillText(names.nth(i), m.name));
    await run(`member ${i + 1} age`, fillText(field(page, 'Age').nth(i), m.age));
    await run(`member ${i + 1} gender`, choose(page, field(page, 'Gender').nth(i), `^\\s*${escRe(m.gender)}\\s*$`));
    await run(`member ${i + 1} ID type`, choose(page, field(page, 'Photo ID Proof').nth(i), ID_TYPE_RE[m.idType] || escRe(m.idType)));
    await run(`member ${i + 1} ID number`, fillText(field(page, 'Photo Id Number').nth(i), m.idNo));
    status(`Member ${i + 1} (${m.name}) filled.`);
  }
  for (const [label, v] of [['Enter email ID', d.email], ['Enter City', d.city], ['State', d.state], ['Enter pincode', d.pincode]]) {
    if (!v) continue;
    const loc = field(page, label).first();
    if (!(await loc.count()) || (await loc.inputValue().catch(() => '')).trim()) continue;
    const ro = await loc.evaluate((e) => e.readOnly).catch(() => false);
    await run(label, ro ? choose(page, loc, `^\\s*${escRe(v)}`) : fillText(loc, v));
  }
  return misses;
}

/* ---------------- Step 4: Terms -> Pay Now ---------------- */

async function toPayment(page, d, misses) {
  if (misses.length || !d.autoTerms) {
    status(misses.length
      ? `Please fill: ${misses.join(', ')}. Then tick Terms and press Continue - I will wait for Pay Now.`
      : 'Check the details, tick Terms and press Continue - I will wait for Pay Now.');
  } else {
    if (await safeEval(page, pageMarkTerms)) {
      const box = page.locator('[data-ttdbot-terms="1"]').first();
      if (!(await box.isChecked().catch(() => false))) await box.check({ force: true }).catch(() => box.click({ force: true }));
    }
    await page.getByRole('button', { name: /^\s*continue\s*$/i }).last().click();
    status('Terms ticked, Continue pressed. Waiting for Pay Now...');
  }

  const payBtn = page.locator('button:visible, a:visible, [role="button"]:visible, input[type=submit]:visible').filter({ hasText: PAY_RE }).first();
  if (!(await payBtn.waitFor({ state: 'visible', timeout: 600000 }).then(() => true, () => false))) {
    status('No Pay Now button appeared. Continue in the browser yourself.');
    return;
  }
  if (!d.autoPay) {
    status('PAY NOW is ready - press it yourself.');
    return;
  }
  const start = page.url();
  const before = new Set((await safeEval(page, pagePopupTexts)) || []);
  await payBtn.click();
  status('Pay Now clicked. Opening the payment page...');
  const r = await waitUntil(async () => {
    const u = page.url();
    let host = '';
    try { host = new URL(u).hostname; } catch (e) { host = ''; }
    if ((host && host !== TTD_HOST) || (u !== start && GATEWAY_RE.test(u))) return { t: 'left' };
    const texts = ((await safeEval(page, pagePopupTexts)) || []).filter((t) => !before.has(t));
    const st = texts.find((t) => STOP_RE.test(t));
    if (st) return { t: 'stop', msg: st };
    const f = texts.find((t) => FAIL_RE.test(t));
    if (f) return { t: 'fail', msg: f };
    return null;
  }, 45000, 300);
  if (r && r.t === 'left') status('PAYMENT PAGE IS OPEN - complete the payment.');
  else status(`${r ? `The site says: "${r.msg.slice(0, 150)}". ` : 'No payment page yet. '}Check My Bookings first, then press Pay Now yourself if needed.`);
}

/* ---------------- Main ---------------- */

async function launch() {
  const pref = process.argv.includes('--chrome') ? ['chrome'] : ['msedge', 'chrome'];
  const headless = process.argv.includes('--headless');
  for (const channel of pref) {
    try {
      return await chromium.launchPersistentContext(PROFILE, { channel, headless, viewport: null, args: ['--start-maximized', '--remote-debugging-port=9333'] });
    } catch (e) {
      status(`Could not open ${channel}: ${e.message.split('\n')[0]}`);
    }
  }
  throw new Error('Install Microsoft Edge or Google Chrome.');
}

async function run(page, d) {
  statusPage = page;
  await page.goto(SLOT_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await ensureCalendar(page, d);
  await waitForRelease(page, d);
  await selectSlot(page, d);
  await page.getByRole('button', { name: /^\s*continue\s*$/i }).last().click();
  status('Continue pressed. Filling pilgrim details...');
  const misses = await fillPilgrims(page, d);
  await toPayment(page, d, misses);
}

async function main() {
  try { fs.writeFileSync(LOGFILE, ''); } catch (e) { /* ignore */ }
  const ctx = await launch();
  await ctx.addInitScript(STATUS_BAR);
  await ctx.exposeBinding('ttdbotGo', () => { goRequested = true; status('Going to booking...'); });
  const page = await ctx.newPage();
  const startedAt = Date.now();
  for (const p of ctx.pages()) if (p !== page) await p.close().catch(() => {});
  ctx.on('page', (p) => { if (Date.now() - startedAt < 15000) p.close().catch(() => {}); });
  page.on('dialog', async (dlg) => {
    status(`Site popup: ${dlg.message()}`);
    if (dlg.type() !== 'alert' && STOP_RE.test(dlg.message())) await dlg.dismiss().catch(() => {});
    else await dlg.accept().catch(() => {});
  });
  ctx.on('close', () => process.exit(0));
  setInterval(() => { if (statusPage && lastMsg) statusPage.evaluate((m) => window.__ttdbotSet && window.__ttdbotSet(m), lastMsg).catch(() => {}); }, 1500);
  const d = process.argv.includes('--go') && fs.existsSync(DETAILS) ? JSON.parse(fs.readFileSync(DETAILS, 'utf8')) : await askForm(page);
  try {
    await run(page, d);
  } catch (e) {
    status('Stopped: ' + e.message.split('\n')[0] + ' - continue in the browser yourself.');
  }
}

if (require.main === module) main().catch((e) => { status('Error: ' + e.message); process.exit(1); });
else module.exports = { askForm, run, formHtml, STATUS_BAR };
