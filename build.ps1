# Builds bookmarklet.txt and install.html from ttd-helper.js.
# Works in Windows PowerShell 5.1 and PowerShell 7 (Windows / Mac / Linux).
$ErrorActionPreference = 'Stop'

$here = if ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path } else { (Get-Location).Path }
$src = Join-Path $here 'ttd-helper.js'
if (-not (Test-Path $src)) { throw "ttd-helper.js not found in $here" }

$utf8 = New-Object System.Text.UTF8Encoding($false)
$lines = [IO.File]::ReadAllLines($src, $utf8) | Where-Object { $_ -notmatch '^\s*//\s*(==/?UserScript==|@)' }
$body = (($lines | ForEach-Object { $_.TrimStart() } | Where-Object { $_ -ne '' }) -join "`n").Trim()
$bookmarklet = 'javascript:' + [Uri]::EscapeDataString($body)

[IO.File]::WriteAllText((Join-Path $here 'bookmarklet.txt'), $bookmarklet, $utf8)

$html = @'
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Install TTD Helper</title>
<style>
  body { font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; margin: 0; padding: 16px; color: #222; background: #faf7fc; }
  main { max-width: 720px; margin: 0 auto; }
  h1 { color: #6a1b9a; font-size: 24px; }
  h2 { color: #6a1b9a; font-size: 19px; margin-top: 28px; }
  .bm { display: inline-block; background: #6a1b9a; color: #fff; padding: 12px 20px; border-radius: 10px; font-weight: bold; text-decoration: none; font-size: 18px; cursor: grab; }
  textarea { width: 100%; height: 140px; font: 12px ui-monospace, Menlo, Consolas, monospace; box-sizing: border-box; border: 1px solid #bbb; border-radius: 8px; padding: 8px; }
  button { background: #6a1b9a; color: #fff; border: 0; border-radius: 8px; padding: 10px 18px; font-size: 16px; cursor: pointer; }
  .note { background: #fff; border-left: 4px solid #6a1b9a; padding: 10px 14px; border-radius: 6px; }
  li { margin: 6px 0; }
  #msg { margin-left: 10px; color: #2e7d32; }
</style>
</head>
<body>
<main>
<h1>TTD Helper</h1>
<p class="note">A personal helper for the official TTD Special Entry Darshan site. It fills your own members' details and picks a slot. <b>You</b> log in with your OTP, tick Terms, and press Pay Now yourself. Nothing is sent anywhere; your details stay in this browser only.</p>

<h2>Laptop / desktop (Chrome, Edge, Firefox, Safari)</h2>
<ol>
  <li>Show the bookmarks bar: press <b>Ctrl+Shift+B</b> (Windows) or <b>Cmd+Shift+B</b> (Mac).</li>
  <li>Drag this button onto the bookmarks bar: <a class="bm" href="__BOOKMARKLET__" onclick="alert('Drag this button to your bookmarks bar instead of clicking it.'); return false;">TTD Helper</a></li>
  <li>Open the TTD site, log in with your OTP, open Special Entry Darshan, then click the <b>TTD Helper</b> bookmark.</li>
</ol>

<h2>Phone (Android / iPhone)</h2>
<ol>
  <li>Press <b>Copy</b> below to copy the code.</li>
  <li>Bookmark any page (for example this one).</li>
  <li>Edit that bookmark: set the name to <b>ttdh</b> and paste the code as the URL / address. Save.</li>
  <li><b>Android (Chrome):</b> on the TTD page, type <b>ttdh</b> in the address bar and tap the bookmark that appears.</li>
  <li><b>iPhone (Safari):</b> on the TTD page, open Bookmarks and tap <b>ttdh</b>.</li>
</ol>

<textarea id="code" readonly>__BOOKMARKLET__</textarea>
<p><button id="copy" type="button">Copy</button><span id="msg"></span></p>

<h2>Optional: Tampermonkey / Userscripts</h2>
<p>If you use the Tampermonkey extension (desktop / Android) or the Userscripts app (iPhone Safari), create a new script and paste the whole <b>ttd-helper.js</b> file. The panel then appears automatically on the TTD site, with no bookmark needed.</p>

<h2>Safety</h2>
<ul>
  <li>Bookings are final. Before pressing Pay Now again, check <b>My Bookings</b> and your bank.</li>
  <li>Carry the same original photo ID you entered.</li>
  <li>Keep "Dry run" ticked the first time to see what the helper does.</li>
</ul>
</main>
<script>
  document.getElementById('copy').addEventListener('click', function () {
    var ta = document.getElementById('code');
    var done = function () { document.getElementById('msg').textContent = 'Copied.'; };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(ta.value).then(done, function () { ta.select(); document.execCommand('copy'); done(); });
    } else {
      ta.focus(); ta.select(); ta.setSelectionRange(0, ta.value.length); document.execCommand('copy'); done();
    }
  });
</script>
</body>
</html>
'@

$html = $html.Replace('__BOOKMARKLET__', $bookmarklet)
[IO.File]::WriteAllText((Join-Path $here 'install.html'), $html, $utf8)

Write-Host ("Built bookmarklet.txt ({0} characters) and install.html in {1}" -f $bookmarklet.Length, $here)
