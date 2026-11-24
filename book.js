#!/usr/bin/env node
'use strict';

/*
 * TTD Special Entry Darshan booking automation (personal use).
 * Drives a real Edge/Chrome window with Playwright:
 *   1. asks for your details in the terminal (saved to details.json),
 *   2. opens the TTD slot page; YOU log in with your OTP,
 *   3. picks a slot from your preferences, fills every pilgrim,
 *   4. after you confirm, ticks Terms, continues, and opens the payment page.
 * It never types the OTP, never solves captchas, never pays, and checks slots at most every 15 s.
 *
 * Usage: node book.js [--browser chrome|msedge] [--new]
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { chromium } = require('playwright-core');

const SLOT_URL = 'https://ttdevasthanams.ap.gov.in/slot-booking?flow=sed&flowIdentifier=sed';
const TTD_HOST = 'ttdevasthanams.ap.gov.in';
const DETAILS = path.join(__dirname, 'details.json');
const PROFILE = path.join(__dirname, '.browser-profile');
const MIN_REFRESH_SEC = 15;

const GENDERS = { m: 'Male', f: 'Female', t: 'Transgender' };
const ID_TYPES = ['Aadhaar Card', 'Passport', 'Voter ID', 'Driving License', 'PAN Card'];
const ID_TYPE_RE = {
  'Aadhaar Card': 'a+dh?a+r',
  'Passport': 'passport',
  'Voter ID': 'voter|epic',
  'Driving License': 'driv',
  'PAN Card': '^\\s*pan'
};
const PAY_RE = /^\s*(pay\s*now|proceed\s*to\s*pay(ment)?|make\s*payment|pay\s*(rs\.?|\u20b9)\s*[\d,.]+|confirm\s*(and|&)\s*pay)\s*$/i;
const FAIL_RE = /(try\s*again|server\s*(is\s*)?busy|too\s*many|unable\s*to|something\s*went\s*wrong|failed|time\s*d?\s*out|timeout|error|not\s*responding|high\s*traffic)/i;
const STOP_RE = /(already|in\s*progress|pending|duplicate|session\s*expired|login\s*again|quota\s*is\s*full|no\s*tickets|sold\s*out|booking\s*(is\s*)?(confirmed|successful))/i;
const GATEWAY_RE = /payment|gateway|billdesk|razorpay|payu|ccavenue|sbiepay/i;

const args = process.argv.slice(2);
const argVal = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on('SIGINT', () => { console.log('\nBye.'); process.exit(0); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function ask(q, def) {
  const a = (await rl.question(def != null && def !== '' ? `${q} [${def}]: ` : `${q}: `)).trim();
  return a === '' && def != null ? String(def) : a;
}

async function askYes(q, def) {
  const a = (await ask(`${q} (${def ? 'Y/n' : 'y/N'})`)).toLowerCase();
  return a === '' ? def : a.startsWith('y');
}

/* ---------------- Details ---------------- */

function summary(d) {
  const lines = d.members.map((m, i) => `  ${i + 1}. ${m.name}, ${m.age}, ${m.gender}, ${m.idType} ${m.idNo}`);
  return [
    `Members (${d.members.length}):`, ...lines,
    `Dates: ${d.prefs.join(' ; ')}`,
    `Laddus: ${d.laddus}   Hundi: ${d.hundi || '-'}`,
    `Contact: ${d.email} | ${d.city} | ${d.state} | ${d.pincode}`,
    `Keep checking if full: ${d.watch ? `yes, every ${d.refreshSec}s${d.until ? ` until ${d.until}` : ''}` : 'no'}`
  ].join('\n');
}

async function askDetails(old) {
  old = old || {};
  const d = {};
  console.log('\nEnter details exactly as on the photo ID. Press Enter to keep the value in [brackets].\n');
  let count;
  for (;;) {
    count = parseInt(await ask('Number of members (1-6)', (old.members || []).length || 1), 10);
    if (count >= 1 && count <= 6) break;
    console.log('  TTD allows 1 to 6.');
  }
  d.members = [];
  for (let i = 0; i < count; i++) {
    const o = (old.members || [])[i] || {};
    console.log(`\n-- Member ${i + 1} --`);
    const m = {};
    while (!(m.name = await ask('  Full name', o.name))) console.log('  Name is required.');
    while (!/^\d{1,3}$/.test(m.age = await ask('  Age', o.age))) console.log('  Enter a number.');
    for (;;) {
      const g = (await ask('  Gender M/F/T', o.gender ? o.gender[0] : '')).toLowerCase()[0];
      if (GENDERS[g]) { m.gender = GENDERS[g]; break; }
      console.log('  Type M, F or T.');
    }
    console.log('  ID type: ' + ID_TYPES.map((t, k) => `${k + 1}=${t}`).join(', '));
    for (;;) {
      const k = parseInt(await ask('  ID type number', o.idType ? ID_TYPES.indexOf(o.idType) + 1 : 1), 10);
      if (ID_TYPES[k - 1]) { m.idType = ID_TYPES[k - 1]; break; }
    }
    while (!(m.idNo = (await ask('  ID number', o.idNo)).replace(/\s+/g, ''))) console.log('  ID number is required.');
    d.members.push(m);
  }
  console.log('\nPreferred dates, best first, separated by ";". Formats: any | 2027-02-23 | 23-02-2027 | 23/02/2027, optional time e.g. "23/02/2027 8 pm"');
  d.prefs = (await ask('Dates', (old.prefs || ['any']).join(' ; '))).split(/[;\n]+/).map((s) => s.trim()).filter(Boolean);
  if (!d.prefs.length) d.prefs = ['any'];
  d.laddus = String(Math.max(0, parseInt(await ask('Extra laddus (\u20b950 each)', old.laddus != null ? old.laddus : 0), 10) || 0));
  d.hundi = (await ask('Hundi offering in \u20b9 (blank = none)', old.hundi || '')).replace(/\D/g, '');
  console.log('\n-- Contact --');
  d.email = await ask('Email', old.email);
  d.city = await ask('City', old.city);
  d.state = await ask('State', old.state);
  d.pincode = await ask('Pincode', old.pincode);
  console.log('');
  d.watch = await askYes('If no slot is free, keep checking?', !!old.watch);
  d.refreshSec = MIN_REFRESH_SEC;
  d.until = '';
  if (d.watch) {
    d.refreshSec = Math.max(MIN_REFRESH_SEC, parseInt(await ask(`Check every how many seconds (min ${MIN_REFRESH_SEC})`, old.refreshSec || 20), 10) || MIN_REFRESH_SEC);
    d.until = await ask('Stop checking at time HH:MM (blank = never)', old.until || '');
  }
  return d;
}

async function getDetails() {
  let old = null;
  try { old = JSON.parse(fs.readFileSync(DETAILS, 'utf8')); } catch (e) { old = null; }
  if (old && old.members && old.members.length && !args.includes('--new')) {
    console.log('\nSaved details:\n' + summary(old) + '\n');
    if (await askYes('Use these?', true)) return old;
  }
  const d = await askDetails(old);
  fs.writeFileSync(DETAILS, JSON.stringify(d, null, 2));
  console.log('\n' + summary(d));
  log(`Saved to ${DETAILS} (contains ID numbers, keep it private).`);
  return d;
}

function parsePrefs(list) {
  return list.map((s) => {
    let m = s.match(/^any\b\s*(.*)$/i);
    if (m) return { any: true, time: m[1].trim(), text: s };
    m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s*(.*)$/);
    if (m) return { y: +m[1], m: +m[2], d: +m[3], time: m[4].trim(), text: s };
    m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})\s*(.*)$/);
    if (m) return { y: +m[3], m: +m[2], d: +m[1], time: m[4].trim(), text: s };
    log(`Ignoring date I do not understand: "${s}"`);
    return null;
  }).filter(Boolean);
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const timeKey = (s) => norm(s).replace(/00/g, '');

/* ---------------- In-page readers (run inside the browser) ---------------- */

function pageReadCalendar() {
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const re = new RegExp('^(' + MONTHS.join('|') + ') (\\d{4})$');
  const COLORS = { 'rgb(163, 0, 14)': 'Quota Full', 'rgb(204, 204, 204)': 'Not Available', 'rgb(255, 255, 255)': 'Other month', 'rgb(255, 191, 0)': 'Filling Fast' };
  const txt = (e) => (e.textContent || '').replace(/\s+/g, ' ').trim();
  const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const leaf = Array.from(document.querySelectorAll('div,span,p,h1,h2,h3,h4,h5,h6,button,label,td'))
    .find((e) => e.childElementCount === 0 && re.test(txt(e)) && vis(e));
  if (!leaf) return null;
  const m = txt(leaf).match(re);
  const bg = (el) => { let e = el; for (let i = 0; i <= 3 && e; i++) { const c = getComputedStyle(e).backgroundColor; if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c; e = e.firstElementChild; } return null; };
  document.querySelectorAll('[data-ttdbot-day]').forEach((e) => e.removeAttribute('data-ttdbot-day'));
  const days = [];
  document.querySelectorAll('table td').forEach((td) => {
    if (!vis(td)) return;
    const t = txt(td);
    if (!/^\d{1,2}$/.test(t)) return;
    const c = bg(td);
    if (!c) return;
    const status = COLORS[c] || 'Available';
    if (status === 'Other month') return;
    td.setAttribute('data-ttdbot-day', t);
    days.push({ day: +t, status, bookable: status === 'Available' || status === 'Filling Fast' });
  });
  return { label: txt(leaf), month: MONTHS.indexOf(m[1]) + 1, year: +m[2], days };
}

function pageMarkArrow(which) {
  document.querySelectorAll('[data-ttdbot-arrow]').forEach((e) => e.removeAttribute('data-ttdbot-arrow'));
  const imgs = Array.from(document.querySelectorAll('main img')).filter((i) => /chevron/i.test(i.getAttribute('src') || ''));
  if (imgs.length < 2) return false;
  const img = which === 'next' ? imgs[imgs.length - 1] : imgs[0];
  if (/grey/i.test(img.getAttribute('src') || '')) return false;
  (img.closest('button,[role=button]') || img).setAttribute('data-ttdbot-arrow', which);
  return true;
}

function pageReadSlots() {
  const txt = (e) => (e.textContent || '').replace(/\s+/g, ' ').trim();
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  document.querySelectorAll('[data-ttdbot-card]').forEach((e) => e.removeAttribute('data-ttdbot-card'));
  const all = Array.from(document.querySelectorAll('div,span,p,li,label,td,button,h1,h2,h3,h4,h5,h6'));
  const seen = new Set();
  const out = [];
  all.filter((e) => e.childElementCount === 0 && /^Slot Time/i.test(txt(e)) && vis(e)).forEach((l) => {
    let card = l;
    while (card && card !== document.body && getComputedStyle(card).cursor !== 'pointer') card = card.parentElement;
    if (!card || card === document.body) card = l.parentElement || l;
    else {
      const oneSlot = (e) => Array.from(e.querySelectorAll('*')).filter((x) => x.childElementCount === 0 && /^Slot Time/i.test(txt(x))).length <= 1;
      while (card.parentElement && card.parentElement !== document.body && getComputedStyle(card.parentElement).cursor === 'pointer' && oneSlot(card.parentElement)) card = card.parentElement;
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
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
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
  const found = await waitUntil(() => safeEval(page, pageMarkOption, optionRe), 5000);
  if (!found) {
    await page.keyboard.press('Escape').catch(() => {});
    return 'miss';
  }
  await page.locator('[data-ttdbot-opt="1"]').first().click();
  await sleep(200);
  return 'ok';
}

/* ---------------- Step 1: login + calendar ---------------- */

async function waitForCalendar(page) {
  if (await safeEval(page, pageReadCalendar)) return;
  console.log('\n>>> In the browser window: log in with your mobile number and OTP (and the captcha, if shown).');
  console.log('>>> I will continue by myself as soon as the slot calendar is visible.');
  let ac = new AbortController();
  let enter = rl.question('>>> Or press Enter here once you are logged in and I will open the slot page.\n', { signal: ac.signal }).then(() => 'enter', () => null);
  for (;;) {
    const r = await Promise.race([enter, sleep(1500).then(() => null)]);
    if (r === 'enter') {
      if (!page.url().includes('slot-booking')) await page.goto(SLOT_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
      const ok = await waitUntil(() => safeEval(page, pageReadCalendar), 30000, 500);
      if (ok) return;
      ac = new AbortController();
      enter = rl.question('>>> Still no calendar. Finish logging in / open Special Entry Darshan, then press Enter.\n', { signal: ac.signal }).then(() => 'enter', () => null);
      continue;
    }
    if (await safeEval(page, pageReadCalendar)) {
      ac.abort();
      return;
    }
  }
}

/* ---------------- Step 2: find a slot ---------------- */

async function setTickets(page, n) {
  const inp = field(page, 'Number of Tickets').first();
  await inp.waitFor({ state: 'visible', timeout: 8000 });
  if ((await inp.inputValue()) === String(n)) return;
  await inp.click();
  const li = page.locator('li:visible, [role="option"]:visible').filter({ hasText: new RegExp(`^\\s*${n}\\s*$`) }).first();
  await li.click({ timeout: 5000 });
  const ok = await waitUntil(async () => (await inp.inputValue()) === String(n), 4000);
  if (!ok) throw new Error(`Could not choose ${n} tickets (the site allows 1-6).`);
}

async function openDay(page, cal, day, count) {
  await page.locator(`[data-ttdbot-day="${day}"]`).first().click();
  await page.getByText(/^\s*Select any 1 Slot/i).first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
  await settle(page);
  await setTickets(page, count);
  await settle(page);
  await sleep(300);
  const slots = (await safeEval(page, pageReadSlots)) || [];
  log(`${day} ${cal.label}: ${slots.map((s) => `${s.time} (${s.available == null ? '?' : s.available}${s.full ? ', full' : ''})`).join(', ') || 'no slots'}`);
  return slots;
}

async function findSlot(page, d) {
  const prefs = parsePrefs(d.prefs);
  if (!prefs.length) prefs.push({ any: true, time: '', text: 'any' });
  const count = d.members.length;
  const ok = (s, want) => !s.full && (!want || timeKey(s.time) === want) && (s.available == null || s.available >= count);
  let moves = 0;
  for (let pass = 0; pass < 3; pass++) {
    const cal = await safeEval(page, pageReadCalendar);
    if (!cal) throw new Error('The slot calendar is not visible any more (logged out?).');
    const open = cal.days.filter((x) => x.bookable);
    log(`${cal.label}: open days ${open.map((x) => x.day + (x.status === 'Filling Fast' ? '*' : '')).join(', ') || 'none'}`);
    const cache = new Map();
    let current = null;
    for (const p of prefs) {
      const cands = p.any ? open : open.filter((x) => p.y === cal.year && p.m === cal.month && x.day === p.d);
      const want = p.time ? timeKey(p.time) : '';
      for (const c of cands) {
        let slots = cache.get(c.day);
        if (!slots) {
          await safeEval(page, pageReadCalendar);
          slots = await openDay(page, cal, c.day, count);
          cache.set(c.day, slots);
          current = c.day;
        }
        let hit = slots.find((s) => ok(s, want));
        if (!hit) continue;
        if (current !== c.day) {
          await safeEval(page, pageReadCalendar);
          slots = await openDay(page, cal, c.day, count);
          cache.set(c.day, slots);
          current = c.day;
          hit = slots.find((s) => ok(s, want));
          if (!hit) continue;
        }
        return { day: c.day, month: cal.label, slot: hit };
      }
    }
    const needLater = prefs.some((p) => p.any || p.y * 12 + p.m > cal.year * 12 + cal.month);
    if (pass === 2 || !needLater || !(await safeEval(page, pageMarkArrow, 'next'))) break;
    await page.locator('[data-ttdbot-arrow="next"]').first().click();
    moves++;
    await waitUntil(async () => { const c2 = await safeEval(page, pageReadCalendar); return c2 && c2.label !== cal.label; }, 6000);
    await settle(page);
  }
  for (let i = 0; i < moves; i++) {
    if (!(await safeEval(page, pageMarkArrow, 'prev'))) break;
    await page.locator('[data-ttdbot-arrow="prev"]').first().click();
    await sleep(1000);
  }
  return null;
}

function watchEnded(d) {
  if (!d.until) return false;
  const [h, m] = d.until.split(':').map((x) => parseInt(x, 10) || 0);
  const end = new Date();
  end.setHours(h, m, 0, 0);
  return Date.now() > end.getTime();
}

async function selectSlot(page, d) {
  for (;;) {
    const found = await findSlot(page, d);
    if (found) {
      await page.locator(`[data-ttdbot-card="${found.slot.idx}"]`).first().click();
      log(`Selected ${found.day} ${found.month} ${found.slot.time} for ${d.members.length} member(s).`);
      await sleep(300);
      const lad = field(page, 'No. of Additional Laddus').first();
      if (+d.laddus > 0 && await lad.count()) await fillText(lad, d.laddus).catch((e) => log('Laddus: ' + e.message.split('\n')[0]));
      const hun = field(page, 'Hundi Offerings').first();
      if (d.hundi && await hun.count()) await fillText(hun, d.hundi).catch((e) => log('Hundi: ' + e.message.split('\n')[0]));
      return true;
    }
    if (!d.watch) return false;
    if (watchEnded(d)) {
      log(`It is past ${d.until}. Stopped checking.`);
      return false;
    }
    log(`Nothing free yet. Checking again in ${d.refreshSec}s... (Ctrl+C to quit)`);
    await sleep(d.refreshSec * 1000);
    const refresh = page.getByRole('button', { name: /^\s*refresh\s*$/i }).first();
    if (await refresh.count()) await refresh.click().catch(() => {});
    else await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await waitUntil(() => safeEval(page, pageReadCalendar), 20000, 500);
    await settle(page);
  }
}

/* ---------------- Step 3: pilgrim details ---------------- */

async function fillPilgrims(page, d) {
  const names = field(page, 'Name');
  await names.first().waitFor({ state: 'visible', timeout: 30000 });
  await settle(page);
  const n = Math.min(await names.count(), d.members.length);
  if (n < d.members.length) log(`Warning: the page shows ${n} pilgrim block(s) but you have ${d.members.length} member(s).`);
  const misses = [];
  const run = async (what, p) => {
    try {
      const r = await p;
      if (r === 'miss') misses.push(what);
    } catch (e) {
      misses.push(what);
      log(`Could not fill ${what}: ${e.message.split('\n')[0]}`);
    }
  };
  for (let i = 0; i < n; i++) {
    const m = d.members[i];
    await run(`member ${i + 1} name`, fillText(names.nth(i), m.name));
    await run(`member ${i + 1} age`, fillText(field(page, 'Age').nth(i), m.age));
    await run(`member ${i + 1} gender`, choose(page, field(page, 'Gender').nth(i), `^\\s*${escRe(m.gender)}\\s*$`));
    await run(`member ${i + 1} ID type`, choose(page, field(page, 'Photo ID Proof').nth(i), ID_TYPE_RE[m.idType] || escRe(m.idType)));
    await run(`member ${i + 1} ID number`, fillText(field(page, 'Photo Id Number').nth(i), m.idNo));
    log(`Member ${i + 1} (${m.name}) filled.`);
  }
  const contact = [['Enter email ID', d.email], ['Enter City', d.city], ['State', d.state], ['Enter pincode', d.pincode]];
  for (const [label, v] of contact) {
    if (!v) continue;
    const loc = field(page, label).first();
    if (!(await loc.count())) continue;
    if ((await loc.inputValue().catch(() => '')).trim()) continue;
    const ro = await loc.evaluate((e) => e.readOnly).catch(() => false);
    await run(label, ro ? choose(page, loc, `^\\s*${escRe(v)}`) : fillText(loc, v));
  }
  if (misses.length) log(`Please fill these yourself in the browser: ${misses.join(', ')}`);
  return misses;
}

/* ---------------- Step 4: terms -> payment page ---------------- */

async function toPayment(page) {
  console.log('\n>>> Check every detail in the browser now.');
  const go = await askYes('>>> Accept Terms and conditions and press Continue for you?', true);
  if (go) {
    if (await safeEval(page, pageMarkTerms)) {
      const box = page.locator('[data-ttdbot-terms="1"]').first();
      if (!(await box.isChecked().catch(() => false))) await box.check({ force: true }).catch(() => box.click({ force: true }));
    }
    await page.getByRole('button', { name: /^\s*continue\s*$/i }).last().click();
    log('Pressed Continue.');
  } else {
    console.log('>>> Tick Terms and press Continue yourself; I will wait for the Pay Now button.');
  }

  const payBtn = page.locator('button:visible, a:visible, [role="button"]:visible, input[type=submit]:visible').filter({ hasText: PAY_RE }).first();
  const seen = await payBtn.waitFor({ state: 'visible', timeout: 120000 }).then(() => true, () => false);
  if (!seen) {
    log('No Pay Now button appeared within 2 minutes. Continue in the browser yourself.');
    return;
  }
  log('Booking summary page with Pay Now is open.');
  for (let attempt = 1; ; attempt++) {
    const ans = (await ask(attempt === 1
      ? '>>> Press Enter to click Pay Now and open the payment gateway (or type q to do it yourself)'
      : '>>> Press Enter to click Pay Now again, AFTER checking My Bookings that nothing was charged (q to stop)', '')).toLowerCase();
    if (ans === 'q') return;
    const start = page.url();
    const before = new Set((await safeEval(page, pagePopupTexts)) || []);
    if (!(await payBtn.count())) {
      log('Pay Now button is gone. Check My Bookings before doing anything else.');
      return;
    }
    await payBtn.click().catch((e) => log('Click failed: ' + e.message.split('\n')[0]));
    log('Clicked Pay Now. Waiting for the payment page...');
    const r = await waitUntil(async () => {
      const u = page.url();
      let host = '';
      try { host = new URL(u).hostname; } catch (e) { host = ''; }
      if (host && host !== TTD_HOST) return { t: 'left' };
      if (u !== start && GATEWAY_RE.test(u)) return { t: 'left' };
      const texts = ((await safeEval(page, pagePopupTexts)) || []).filter((t) => !before.has(t));
      const st = texts.find((t) => STOP_RE.test(t));
      if (st) return { t: 'stop', msg: st };
      const f = texts.find((t) => FAIL_RE.test(t));
      if (f) return { t: 'fail', msg: f };
      return null;
    }, 30000, 300);
    if (r && r.t === 'left') {
      log('PAYMENT PAGE IS OPEN in the browser. Complete the payment yourself.');
      return;
    }
    if (r && r.t === 'stop') {
      log(`The site says: "${r.msg.slice(0, 200)}". Check My Bookings before trying again.`);
      return;
    }
    log(r ? `The site says: "${r.msg.slice(0, 200)}"` : 'No payment page after 30 s.');
  }
}

/* ---------------- Main ---------------- */

async function launch() {
  const pref = argVal('--browser');
  const channels = pref ? [pref] : ['msedge', 'chrome'];
  for (const channel of channels) {
    try {
      const ctx = await chromium.launchPersistentContext(PROFILE, { channel, headless: false, viewport: null, args: ['--start-maximized'] });
      log(`Opened ${channel}. (Your TTD login is remembered in ${PROFILE})`);
      return ctx;
    } catch (e) {
      log(`Could not open ${channel}: ${e.message.split('\n')[0]}`);
    }
  }
  throw new Error('Install Microsoft Edge or Google Chrome.');
}

async function main() {
  console.log('=== TTD Special Entry Darshan booking helper ===');
  const d = await getDetails();
  const ctx = await launch();
  const page = ctx.pages()[0] || await ctx.newPage();
  page.on('dialog', async (dlg) => {
    const msg = dlg.message();
    log(`Site popup (${dlg.type()}): ${msg}`);
    if (dlg.type() !== 'alert' && STOP_RE.test(msg)) await dlg.dismiss().catch(() => {});
    else await dlg.accept().catch(() => {});
  });
  const closed = new Promise((r) => ctx.on('close', r));

  try {
    await page.goto(SLOT_URL, { waitUntil: 'domcontentloaded' });
    await waitForCalendar(page);
    log('Slot calendar is visible.');
    if (!(await selectSlot(page, d))) {
      log('No slot matched your dates. Run again with other dates, or choose "keep checking".');
    } else {
      await page.getByRole('button', { name: /^\s*continue\s*$/i }).last().click();
      log('Pressed Continue. Waiting for the pilgrim details page...');
      await fillPilgrims(page, d);
      await toPayment(page);
    }
  } catch (e) {
    log('Stopped: ' + e.message.split('\n')[0]);
  }
  console.log('\nThe browser stays open. Close it when you are done (or press Ctrl+C here).');
  rl.close();
  await closed;
  process.exit(0);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
else module.exports = { selectSlot, fillPilgrims, toPayment, parsePrefs, rl };
