# Prompt to rebuild the TTD Helper with any AI

Copy everything below the line into ChatGPT, Gemini, Copilot or any other AI chat, including free ones. If the answer gets cut off, type **"continue exactly where you stopped"**.

---

You are a careful JavaScript developer. Write ONE complete, working file named `ttd-helper.js`. Do not leave anything out, do not use placeholders like "...", and do not use any libraries. Then write the small extra files listed at the end. Follow every rule exactly.

## What it is

A personal helper for the OFFICIAL Tirumala Tirupati Devasthanams (TTD) "Special Entry Darshan" booking site. It runs inside the user's own browser on `https://ttdevasthanams.ap.gov.in/*`, either as a userscript (Tampermonkey) or as a bookmarklet. It must work in Chrome, Edge, Firefox and Safari on Windows, Mac, Android and iPhone.

It ONLY:

- fills the user's own details;
- picks a free slot from the user's preferences;
- presses the site's own buttons at human speed;
- retries the "Pay Now" button safely after the user presses it.

It must NEVER:

- log in;
- type or read the OTP;
- solve a CAPTCHA;
- tick the Terms checkbox;
- pay;
- send data anywhere;
- open more tabs;
- run faster than the limits below.

## File header (userscript)

Start the file with exactly:

```
// ==UserScript==
// @name         TTD Booking Helper (personal)
// @namespace    personal.ttd
// @version      1.1
// @description  Fills your own members' details on the official TTD Special Entry Darshan page and retries Pay Now safely. You log in, review and pay yourself.
// @match        https://ttdevasthanams.ap.gov.in/*
// @grant        none
// ==/UserScript==
```

Then wrap ALL code in `(function () { 'use strict'; ... })();`.

- If `window.__ttdHelper` already exists, call `window.__ttdHelper.show()` and return, so it never loads twice.
- Use only ES2017 (async/await is fine).
- Do not use `//` comments inside code lines that would break if newlines were removed; keep comments on their own lines.

## Constants and saved settings

- `KEY = 'ttdHelper.v1'` is the localStorage key. Everything is saved only in localStorage of that browser.
- `MIN_REFRESH_SEC = 15`, `MIN_PAY_GAP_SEC = 5`, `MAX_PAY_TRIES = 10`.
- `DEFAULTS`:

```
{ count: 1, members: [], queue: '',
  contact: { email: '', city: '', state: '', country: 'India', pincode: '' },
  prefs: 'any', laddus: '10', hundi: '',
  dryRun: true, watch: false, refreshSec: 20, watchUntil: '', stage: '',
  payRetry: true, payTries: 8, payGapSec: 8, minimized: false }
```

- `load()` = `Object.assign({}, DEFAULTS, JSON.parse(localStorage[KEY] || '{}'))`, wrapped in try/catch.
- `save()` writes `S` back to localStorage.
- A member is `{ name, age, gender, idType, idNo }`.

## Helper functions (write all of them)

- `sleep(ms)`.
- `waitFor(fn, ms)`: polls `fn` every 150 ms until it returns something truthy or the time runs out. It returns null on timeout, and throws `Error('Stopped by you.')` if `stopFlag` is set.
- `txt(el)`: `textContent` with whitespace collapsed and trimmed.
- `visible(el)`: `offsetParent !== null` and visibility is not hidden.
- `mine(el)`: true if the element is inside the helper's own panel `#ttdh`.
- `leaves(regex, root)`: all `div,span,p,li,label,td,button,h1,h2,h3,h4` with `childElementCount === 0` whose text matches, and which are not `mine`.
- `buttons()`: visible `button, a, [role="button"], input[type=submit], input[type=button]` that are not `mine`.
- `btnText(b)`: the `value` for inputs, otherwise `txt`.
- `click(el)`: `scrollIntoView({block:'center'})`, then `el.click()`.
- `setValue(el, v)` (React-safe):
  1. Call the NATIVE value setter from `HTMLInputElement`, `HTMLSelectElement` or `HTMLTextAreaElement.prototype` via `Object.getOwnPropertyDescriptor(proto,'value').set.call(el, v)`.
  2. Dispatch bubbling `input`, `change` and `blur` events.
- `norm(s)`: lowercase, keep only a–z and 0–9.
- `bg(el)`: walk the element and up to 3 levels of `firstElementChild`, and return the first `backgroundColor` that is not `rgba(0, 0, 0, 0)`.
- `log(msg)`: prepend `time + msg` to the panel's `<pre id="ttdh-log">`, and also `console.log` it.

## Page 1: the slot page (`/slot-booking?flow=sed&flowIdentifier=sed`). These are facts from the real site.

- **Month title:** a leaf whose text matches `^(January|...|December) \d{4}$`.
- **Calendar:** a `<table>`. Each `<td>` holds a day number. Its background colour (via `bg`) means:
  - `rgb(163, 0, 14)` = Quota Full
  - `rgb(204, 204, 204)` = Not Available / Not Released
  - `rgb(255, 255, 255)` = a day from another month (ignore it)
  - `rgb(255, 191, 0)` = Filling Fast (bookable)
  - any other non-transparent colour = Available (bookable)
- **Next-month arrow:** in `main img`, the images whose `src` contains `chevron`. The LAST one is "next". It is disabled if its `src` contains `grey`, or if there are fewer than 2.
- **After clicking a bookable day:**
  - A leaf with text starting `Select any 1 Slot` appears.
  - There is a readonly `<input label="Number of Tickets">`. Clicking it opens `<li>` items `1` to `6`.
  - Each slot card has a leaf starting `Slot Time` (e.g. `Slot Time 8:00 pm`). The card is the nearest ancestor whose computed `cursor` is `pointer`. Inside the card, a leaf with only digits is the "N Available" count.
- **Other inputs and buttons:** `<input label="No. of Additional Laddus">` (₹50 each), `<input label="Hundi Offerings">`, button text `Refresh`, button text `Continue`.

### `setTickets(n)`

1. Find `input[label="Number of Tickets"]`. If its value is already `n`, return.
2. Click it, wait for a visible `li` with text exactly `n`, and click that `li`.
3. Wait until the input's value equals `n`.
4. If it fails, throw `'Could not choose n tickets (the site allows 1-6).'`

### Preferences

`S.prefs` is text with one entry per line (`;` is also allowed). Each entry is one of:

- `any`
- `YYYY-MM-DD` with an optional time, e.g. `2027-02-23 8:00 pm`
- `DD-MM-YYYY` or `DD/MM/YYYY` with an optional time

Compare times with `timeKey(s) = norm(s).replace(/00/g,'')`, so `8:00 pm`, `8 pm` and `8pm` are all equal.

### `findSlotOnce()`

Repeat for up to 3 months:

1. Read the month and the bookable days, and log them; mark Filling Fast days with `*`.
2. For each preference in order, the candidate days are all bookable days for `any`, or the matching day if the year and month match.
3. For each candidate day:
   - Click it and wait 5 s for `Select any 1 Slot`.
   - Call `setTickets(count)` and wait 400 ms.
   - Read the slot cards and log `day month: time (available), ...`.
   - Keep the slots that are not full, match the time (if given), and have `available >= count` (or an unknown count).
   - Return the first match as `{day, month, slot}`.
4. If nothing matched, click the next-month arrow, wait 1200 ms and repeat. Return null if nothing is found.

### `findAndContinue()` (the "Find slot & continue" button)

1. Guard against running twice. Clear `stopFlag`.
2. Call `readPanel()`. If the quick list has text, call `applyQueue()`.
3. Call `prompt('Extra laddus (₹50 each). Keep 10 or type a new number:', S.laddus)`.
   - If the user presses Cancel, stop.
   - Otherwise store `max(0, int)` in `S.laddus` and in the panel box, then `save()`.
4. Check that every member up to `count` has a name, age and gender. Otherwise throw `'Fill name, age and gender for member N first.'`
5. Loop:
   - Call `found = findSlotOnce()`.
   - **If something was found:**
     1. Click the slot card and log `'Selected <day> <month> <time> for N member(s).'`
     2. Set the laddus and hundi inputs with `setValue`, if they exist and have values.
     3. If `S.dryRun`, log `'Dry run: stopped before Continue...'` and stop.
     4. Otherwise set `S.stage='fill'`, save, and click the `Continue` button.
     5. Wait up to 20 s for at least 2 pilgrim fields, then call `fillPilgrims()`.
   - **If nothing was found and `S.watch` is off:** log `'No slot matches...'` and stop.
   - **If the watch end time (`HH:MM` today) has passed:** log it and stop.
   - **Otherwise:** log `'Nothing yet...'`, wait `max(15, refreshSec)` seconds in 100 ms steps (checking `stopFlag`), click the site's `Refresh` button, wait 1500 ms and loop again.
6. Catch errors and log `'Stopped: ' + message`. In `finally`, clear the running flag.

## Page 2: the pilgrim page (`/pilgrim-details?...`). These are facts from the real site.

- **For each member (the number of blocks equals the ticket count):**
  - `<input label="Name">`
  - `<input type=number label="Age">`
  - `<input readonly label="Gender">`: click it to open `<li>` items `Female`, `Male`, `Transgender`
  - `<input readonly name="photoIdType" label="Photo ID Proof">`: a dropdown of `<li>`, e.g. `Aadhaar Card`
  - `<input label="Photo Id Number">`
- **Member 1** is often pre-filled from the TTD profile.
- **After the members:** `<input label="Enter email ID">`, `Enter City`, `State`, `Country`, `Enter pincode`, a **Terms and conditions** checkbox, and `Continue`.

### `labelOf(el)`

Use the first non-empty value of:

1. attribute `label`
2. `aria-label`
3. `placeholder`
4. `name`
5. `<label for=id>` text
6. the text of up to 3 parent levels (first 60 characters)

### `pilgrimFields()`

1. Take all visible `input, select, textarea` that are not `mine`. Skip hidden, checkbox and radio inputs.
2. Skip any whose label matches `/ticket|laddu|hundi|mobile|phone|otp|email|search/i`.
3. Give each remaining field the FIRST kind that matches, in this order:
   - `idNo`: `/(id|proof|aadha?ar|passport|card).*(no|number)|number.*(id|proof)/i`
   - `idType`: `/(photo\s*id|id\s*proof|proof\s*type|id\s*type)/i`
   - `gender`: `/gender/i`
   - `age`: `/\bage\b/i`
   - `name`: `/name/i`

### `chooseOption(el, want)`

- **SELECT:** pick the option whose `norm(text)` starts with `norm(want)`, or whose value equals it.
- **readonly input:**
  1. Click it.
  2. Wait 3 s for a visible `li` or `[role=option]` where `norm(text)` starts with `norm(want)` or `norm(want)` starts with `norm(text)`.
  3. Click it and wait 250 ms.
  4. If no option appears, click the input again to close it and return false.
- **Otherwise:** call `setValue`.

### `fillPilgrims()` (the "Fill pilgrims" button, and also automatic after Continue)

1. Call `readPanel()`, call `applyQueue()` if the list has text, then save.
2. Save the learned fields as `KEY + '.learnedFields'`: `{at, url: location.pathname, fields: ['kind="label"', ...]}`.
3. Set the panel's `pointerEvents` to `'none'` while filling.
4. Count each kind as it appears in order. The Nth `name` field belongs to member N, and the same for the other kinds.
   - Skip a field if it already holds the same value (by `norm`).
   - Use `chooseOption` for gender and idType, and `setValue` for the others.
   - Wait 120 ms between fields. Record any misses.
5. **Contact fields:** for every visible input, fill it if its label matches the item and it is empty:
   - email: `/email/i`
   - city: `/city/i`
   - state: `/^state$/i`
   - country: `/country/i`
   - pincode: `/pin\s*code/i`
6. Restore `pointerEvents`, set `S.stage=''` and save.
7. Log `'Filled N field(s).'` plus any misses, then `'Check every detail, tick Terms and conditions, press Continue, then press Pay Now yourself. I will retry Pay Now if the site fails.'`
8. Do NOT tick Terms, and do NOT click Continue or Pay.

When the script starts, if `S.stage === 'fill'`, wait up to 15 s for pilgrim fields and auto-run `fillPilgrims()`.

## Pay Now safe retry (only after the USER clicks Pay Now)

**Regexes:**

- `PAY_RE = /^(pay\s*now|proceed\s*to\s*pay(ment)?|make\s*payment|pay\s*(rs\.?|₹)\s*[\d,.]+|confirm\s*(and|&)\s*pay)$/i`
- `REDIRECT_OK_RE = /^(ok|okay|yes|proceed|continue|redirect|confirm|go\s*to\s*payment)$/i`
- `FAIL_RE = /(try\s*again|server\s*(is\s*)?busy|too\s*many|unable\s*to|something\s*went\s*wrong|failed|time\s*d?\s*out|timeout|error|not\s*responding|high\s*traffic)/i`
- `STOP_RE = /(already|in\s*progress|pending|duplicate|session\s*expired|login\s*again|quota\s*is\s*full|no\s*tickets|sold\s*out|booking\s*(is\s*)?(confirmed|successful))/i`

**Helpers:**

- `payButton()`: the first button whose `btnText` matches `PAY_RE` and is not disabled or `aria-disabled`.
- `popupTexts()`: the texts of visible, not-`mine` elements matching `[role=alert],[role=dialog],[role=alertdialog],[class*=toast i],[class*=snack i],[class*=error i],[class*=modal i],[class*=popup i],[class*=alert i]`.
- `redirectButton()`: inside visible dialogs, modals or popups, the first visible button or link whose text matches `REDIRECT_OK_RE`.
- `leftTtd(startHref)`: hostname is not `ttdevasthanams.ap.gov.in`, OR (the URL matches `/payment|gateway|billdesk|razorpay|payu|ccavenue|sbiepay/i` AND it differs from the start URL).

**Trigger:** add a CAPTURE-phase document `click` listener. When `S.payRetry` is on, no loop is running, `event.isTrusted` is true, and the clicked element (via `closest(button, a, [role=button], input[type=submit|button])`) is not `mine` and matches `PAY_RE`, call `setTimeout(payRetryLoop, 0)`.

### `payRetryLoop()`

1. Set `tries = 1`, `max = min(10, payTries)`, `gap = max(5, payGapSec)`.
2. Add a `beforeunload` listener that sets `leaving = true`.
3. Temporarily replace `window.confirm` with a function that logs `'Auto-accepted: ...'` and returns true. Restore it in `finally`.
4. Log `'Pay Now pressed (try 1 of max)...'`.
5. Loop. In each round, wait up to 25 s for the first of these:
   - **leaving, or `leftTtd`:** log `'Leaving TTD for the payment page...'` and stop.
   - **A redirect button:** log it, click it, wait 1500 ms and continue the loop.
   - **Popup text matching `STOP_RE`:** log `'Stopped, the site says: "..." Check My Bookings before trying again.'` and stop.
   - **Popup text matching `FAIL_RE`, or the 25 s timeout:**
     1. If `tries >= max`, log `'Gave up after N tries. Check My Bookings / your bank before trying again.'` and stop.
     2. Otherwise log the error.
     3. Click a visible `OK` / `Close` / `×` button if there is one.
     4. Wait `gap` seconds in 100 ms steps, checking `stopFlag`.
     5. Check again whether the page has left TTD.
     6. If there is no Pay button any more, log `'Pay Now button is gone... Not retrying'` and stop.
     7. Otherwise do `tries++`, log `'Retrying Pay Now (try N of max)'` and click the Pay button.

## Quick list (one member per line)

- **Format:** `Name, Age, Gender, ID type, ID number`. Separators can be a comma, `|` or a tab.
- `parseLine`:
  - gender: `f...` → Female, `t...` → Transgender, `m...` → Male
  - ID type: aadhar/aadhaar → `Aadhaar Card`, pass... → `Passport`, voter/epic → `Voter ID`, driv/dl → `Driving License`, pan → `PAN Card`; anything else is kept as typed
  - age keeps digits only; the ID number has spaces removed
- `applyQueue()`:
  1. Lines 1–6 become `S.members`, and `S.count` = the number of those lines.
  2. Log how many are used and how many wait.
  3. Update the panel's member count and member rows.
- `nextGroup()`: drop the first 6 lines, save, update the textarea, then call `applyQueue()`. If 6 or fewer lines remain, log `'No more members waiting'`.

## The panel (`div#ttdh`)

**Style:**

- `position:fixed; right:8px; bottom:8px; z-index:2147483647; width:min(360px,94vw); max-height:85vh; overflow:auto`
- white background, `2px solid #6a1b9a` border, 12px radius, shadow, system font 14px, padding 10px
- inputs at 100% width and 16px font (so phones don't zoom); buttons purple `#6a1b9a` with white text; grey `#777` buttons for secondary actions

**Contents, top to bottom:**

1. A title "TTD Helper" and a `_` button that minimises or restores the panel. The minimised state is saved in `S.minimized`, and the panel width becomes `auto` when minimised.
2. "Quick list, one member per line" with a textarea `#ttdh-queue` (placeholder `Ravi Kumar, 34, M, Aadhaar, 123412341234`) and the buttons `Use list` and `Next group`.
3. "Members" with a select `#ttdh-count` (1–6). Changing it re-renders the member rows.
4. Member rows: for each member, a `<fieldset>` "Member N" containing:
   - name (placeholder "Full name as on ID")
   - age (number) and a gender select (Male, Female, Transgender)
   - an ID type select (Aadhaar Card, Passport, Voter ID, Driving License, PAN Card)
   - the ID number (autocomplete off)

   Each field uses `data-m=index` and `data-k=field`.
5. "Dates / slots in order, one per line" with a textarea `#ttdh-prefs`.
6. Inputs `#ttdh-laddus` (default 10) and `#ttdh-hundi`.
7. "Contact (filled once per booking)" with inputs `#ttdh-email`, `#ttdh-city`, `#ttdh-state`, `#ttdh-country` and `#ttdh-pin`.
8. A checkbox `#ttdh-dry`: "Dry run (stop before Continue)", ticked by default.
9. A checkbox `#ttdh-watch`: "Wait for slots: refresh every [#ttdh-every, min 15] s until [#ttdh-until, type=time]".
10. A checkbox `#ttdh-pay`: "After I press Pay Now, retry up to [#ttdh-paytries, 1–10] times, every [#ttdh-paygap, min 5] s".
11. The buttons `Save`, `Find slot & continue`, `Fill pilgrims`, `Stop` (sets `stopFlag`) and `Clear my data` (asks to confirm, removes both localStorage keys, rebuilds the panel).
12. A `<pre id="ttdh-log">` box: light purple background, max height 160px, 12px font.

`readPanel()` reads every control into `S`. It clamps `refreshSec >= 15`, `payTries` to 1–10 and `payGapSec >= 5`, and trims `members` to `count`.

`esc()` HTML-escapes every value written into the panel.

**Exports:**

- `window.__ttdHelper = { show, find, fill, scan }`
- `scan` returns `{month, open days with status, slots with count, pay button present, pilgrimFields}`.

Call `build()`, then log `'Ready. Log in yourself, open Special Entry Darshan, then press "Find slot & continue".'`

## Extra files

1. `build.ps1` (must work in Windows PowerShell 5.1 and PowerShell 7 on Mac):
   - `$here` = the script folder, or the current folder if `$MyInvocation.MyCommand.Path` is empty.
   - Read `ttd-helper.js` and drop the lines matching `^\s*//\s*(==/?UserScript==|@)`.
   - `bookmarklet = 'javascript:' + [Uri]::EscapeDataString(body.Trim())`, written to `bookmarklet.txt`.
   - Write `install.html`, a mobile-friendly page with:
     - a draggable purple link "TTD Helper" whose href is the bookmarklet, with laptop steps ("show bookmarks bar Ctrl/Cmd+Shift+B, drag the button");
     - phone steps ("Copy, bookmark any page, edit it: name `ttdh`, paste as URL; Android: type ttdh in the address bar and tap the bookmark; iPhone: open Bookmarks and tap ttdh");
     - a readonly textarea with the code and a Copy button;
     - an optional Tampermonkey / Userscripts note.
2. `ttd.cmd` (Windows):
   - `cd /d "%~dp0"`.
   - Run `build.ps1` through `powershell -NoProfile -Command "& ([scriptblock]::Create([IO.File]::ReadAllText('%~dp0build.ps1')))"`.
   - If the argument is `install`, open `install.html`; otherwise open `https://ttdevasthanams.ap.gov.in/slot-booking?flow=sed&flowIdentifier=sed` and print "Log in with your OTP, then click the TTD Helper bookmark."
3. `ttd.command` (Mac/Linux bash): the same, using `pwsh -NoProfile -File build.ps1` if `pwsh` exists, and `open` (or `xdg-open`).
4. `README.md`: what it does, install steps, usage steps, safety notes (bookings are final; check My Bookings before retrying; carry the same original ID), and the site facts above.

## Final check before you answer

- Every function above exists and is called correctly.
- There are no placeholders.
- The file is valid JavaScript.
- None of the "must NEVER" actions happen anywhere in the code.
