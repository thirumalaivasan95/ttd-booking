# TTD Booking Helper (personal)

A small helper for the **official** Tirumala Tirupati Devasthanams (TTD) "Special Entry Darshan" site, `https://ttdevasthanams.ap.gov.in/`. It runs inside your own browser as a bookmarklet or a userscript (Tampermonkey / Userscripts). It works in Chrome, Edge, Firefox and Safari on Windows, Mac, Android and iPhone.

## What it does

- Fills in **your own** members' details (name, age, gender, photo ID) and contact details.
- Picks a free slot from your list of preferred dates and times.
- Presses the site's own buttons at human speed (it refreshes no more than once every 15 s).
- After **you** press Pay Now, it retries the Pay Now button safely if the site fails (up to 10 tries, at least 5 s apart).

What it never does: log in, type or read the OTP, solve a CAPTCHA, tick the Terms checkbox, pay, send data anywhere, or open more tabs. Your details are saved only in this browser's localStorage.

## Quick start: full automation (recommended)

Needs Node.js 18+ and Microsoft Edge or Google Chrome.

1. Double-click **`Start TTD Booking.vbs`**. No console window opens.
2. A browser opens with a form. Fill in the members (the form shows one block per member), choose "first available" or specific dates, and optionally the release time. Press **Save & start**. Your details are saved to `details.json` and pre-filled next time.
3. **Log in with your OTP** in that window. A purple bar at the top shows what the helper is doing.
4. It waits for the release time, then loads fresh slots. If nothing is free yet, it checks again every 10 s or more. If TTD puts you in a waiting queue, it keeps your place and does not refresh.
5. When a slot appears, it selects it at once, fills every pilgrim, ticks Terms, and clicks Pay Now. **You pay on the payment page yourself.**

Progress is also written to `book.log`. Add `--chrome` to `node book.js` to use Chrome instead of Edge.

`details.json` and `.browser-profile` contain your personal data. Keep them private.

## Files

| File | Purpose |
| --- | --- |
| `book.js` / `book.cmd` | Full automation (Playwright, drives Edge/Chrome) |
| `ttd-helper.js` | The helper itself (a userscript, also used to build the bookmarklet) |
| `build.ps1` | Builds `bookmarklet.txt` and `install.html` from `ttd-helper.js` |
| `ttd.cmd` | Windows: builds, then opens the TTD slot page (`ttd.cmd install` opens `install.html`) |
| `ttd.command` | Mac/Linux: does the same (needs `pwsh` to rebuild) |
| `REBUILD-PROMPT.md` | A prompt to regenerate everything with any AI |

## Install

1. **Windows:** double-click `ttd.cmd`, or run `ttd.cmd install` to open the install page.
   **Mac/Linux:** run `chmod +x ttd.command` once, then `./ttd.command install`.
2. On `install.html`:
   - **Laptop:** show the bookmarks bar (Ctrl/Cmd+Shift+B) and drag the purple **TTD Helper** button onto it.
   - **Phone:** press Copy, bookmark any page, edit the bookmark: name it `ttdh` and paste the code as the URL.
     - Android: type `ttdh` in the address bar and tap the bookmark.
     - iPhone: open Bookmarks and tap `ttdh`.
   - **Optional:** paste `ttd-helper.js` into Tampermonkey (desktop/Android) or Userscripts (iPhone). The panel then appears on the TTD site by itself.

## Use

1. Open the TTD site and **log in yourself** with your OTP.
2. Open Special Entry Darshan (`/slot-booking?flow=sed&flowIdentifier=sed`) and click the **TTD Helper** bookmark. A purple panel appears in the bottom-right corner.
3. Fill in the members (up to 6), or paste a **quick list** with one member per line:
   `Ravi Kumar, 34, M, Aadhaar, 123412341234`
   You can separate fields with a comma, `|` or a tab. Press **Use list**. If the list has more than 6 people, **Next group** moves on to the next 6.
4. Under **Dates / slots**, enter one line per preference, in order:
   - `any` (any open day; you can add a time, e.g. `any 8 pm`)
   - `2027-02-23 8:00 pm` or `23-02-2027` or `23/02/2027 8 pm`
5. Fill in the contact details, then press **Save**.
6. Leave **Dry run** ticked the first time. Press **Find slot & continue**. The helper picks a slot and stops before Continue.
7. When you are happy with what it does, untick Dry run. The helper then presses Continue and fills in the pilgrim page. You can also press **Fill pilgrims** yourself on that page.
8. **Check every detail**, tick Terms and conditions, press Continue, and then press **Pay Now yourself**.
9. If **Wait for slots** is ticked, the helper keeps checking every 15 s or more until the time you set.
10. Press **Stop** at any time. **Clear my data** removes everything the helper saved in this browser.

## Safety notes

- **Bookings are final.** If a payment looks like it failed, check **My Bookings** and your bank **before** trying again.
- The Pay Now retry stops at once if the site says something like "already", "pending", "duplicate", "session expired", "sold out" or "booking confirmed".
- Carry the **same original photo ID** you entered for each member.
- Only use this for your own family and friends, with their consent.

## Site facts used (may change if TTD updates the site)

**Slot page** (`/slot-booking?flow=sed&flowIdentifier=sed`)

- The month title is a leaf element matching `^(January|...|December) \d{4}$`.
- The calendar is a `<table>`. Each `<td>`'s background colour gives the day's status:
  - `rgb(163, 0, 14)`: Quota Full
  - `rgb(204, 204, 204)`: Not Available / Not Released
  - `rgb(255, 255, 255)`: a day from another month
  - `rgb(255, 191, 0)`: Filling Fast (bookable)
  - any other colour: Available (bookable)
- Month arrows are `main img` elements whose `src` contains `chevron`. The last one is "next"; it is disabled if its `src` contains `grey`.
- After you click a day:
  - "Select any 1 Slot" appears.
  - The readonly `input[label="Number of Tickets"]` opens a list of `<li>` items, 1 to 6.
  - Each slot card has "Slot Time ..." text and a number showing how many are available.
- Other inputs and buttons: `input[label="No. of Additional Laddus"]` (₹50 each), `input[label="Hundi Offerings"]`, and the **Refresh** and **Continue** buttons.

**Pilgrim page** (`/pilgrim-details?...`)

- Each member has these inputs:
  - `Name`
  - `Age` (number)
  - `Gender` (readonly; opens `<li>` items Female / Male / Transgender)
  - `Photo ID Proof` (readonly, `name="photoIdType"`)
  - `Photo Id Number`
- After the members: email, city, state, country, pincode, the Terms checkbox and Continue.
- Member 1 is often filled in already from your TTD profile.

## Troubleshooting

- Open the browser console and run `__ttdHelper.scan()`. It shows what the helper can see on the page: month, days, slots, the Pay button and pilgrim fields.
- The last pilgrim-page field mapping is saved in localStorage under `ttdHelper.v1.learnedFields`.
