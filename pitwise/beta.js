// Kopirovani beta klice. MUSI byt externi soubor - CSP v _headers nepovoluje
// inline <script> ani inline onclick (script-src 'self' https://payhip.com).
(function () {
  var btn = document.getElementById("copyBeta");
  var keyEl = document.getElementById("betaKey");
  if (!btn || !keyEl) return;

  var label = btn.textContent;
  var timer = null;

  function done(ok) {
    btn.textContent = ok ? "Copied ✓" : "Press Ctrl+C";
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { btn.textContent = label; }, 2000);
  }

  function selectKey() {
    try {
      var r = document.createRange();
      r.selectNodeContents(keyEl);
      var s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
    } catch (e) { /* vyber neni kriticky */ }
  }

  btn.addEventListener("click", function () {
    var text = keyEl.textContent.trim();
    // clipboard API je jen na https + po gestu uzivatele; kdyz nejde, aspon text oznac
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { selectKey(); done(false); });
    } else {
      selectKey();
      done(false);
    }
  });

  // klik na samotny klic ho rovnou oznaci (pohodlne na mobilu)
  keyEl.addEventListener("click", selectKey);
})();
