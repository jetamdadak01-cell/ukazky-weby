/* =========================================================
   Studio Lumé — interaktivita (čistý JS, bez knihoven)
   ========================================================= */
(function () {
  "use strict";

  /* ---------- Rok v patičce ---------- */
  var yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  /* ---------- Mobilní menu ---------- */
  var toggle = document.getElementById("navToggle");
  var menu = document.getElementById("navMenu");

  if (toggle && menu) {
    toggle.addEventListener("click", function () {
      var isOpen = menu.classList.toggle("open");
      toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
      toggle.setAttribute("aria-label", isOpen ? "Zavřít menu" : "Otevřít menu");
    });

    // Po kliknutí na odkaz menu zavřít (mobil)
    menu.addEventListener("click", function (e) {
      if (e.target.closest("a")) {
        menu.classList.remove("open");
        toggle.setAttribute("aria-expanded", "false");
        toggle.setAttribute("aria-label", "Otevřít menu");
      }
    });
  }

  /* ---------- Objednávkový formulář → mailto (bez serveru) ---------- */
  // UPRAVUJTE ZDE: e-mail, kam má poptávka chodit
  var SALON_EMAIL = "ahoj@studio-lume.cz";

  var form = document.getElementById("bookingForm");
  var hint = document.getElementById("formHint");

  if (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();

      var name = form.name.value.trim();
      var phone = form.phone.value.trim();
      var service = form.service.value;
      var term = form.term.value.trim();
      var message = form.message.value.trim();

      // Jednoduchá validace
      if (!name || !phone) {
        showHint("Vyplňte prosím jméno a telefon, ať se vám můžeme ozvat.", true);
        if (!name) form.name.focus(); else form.phone.focus();
        return;
      }

      // Sestavení e-mailu
      var subject = "Poptávka termínu — " + service;
      var bodyLines = [
        "Dobrý den,",
        "",
        "ráda bych se objednala na: " + service + ".",
        "",
        "Jméno: " + name,
        "Telefon: " + phone,
        "Preferovaný termín: " + (term || "—"),
      ];
      if (message) {
        bodyLines.push("");
        bodyLines.push("Poznámka: " + message);
      }
      bodyLines.push("");
      bodyLines.push("Děkuji a budu se těšit.");

      var mailto =
        "mailto:" + SALON_EMAIL +
        "?subject=" + encodeURIComponent(subject) +
        "&body=" + encodeURIComponent(bodyLines.join("\n"));

      // Otevře e-mailový program s předvyplněnou zprávou
      window.location.href = mailto;

      showHint("Otevřeli jsme váš e-mailový program s hotovou zprávou — stačí ji odeslat.", false);
    });
  }

  function showHint(text, isError) {
    if (!hint) return;
    hint.textContent = text;
    hint.classList.toggle("error", !!isError);
  }
})();
