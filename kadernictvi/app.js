/* =================================================================
   SALON LNĚNÁ — app.js
   1) Mobilní menu (hamburger)
   2) Rezervační formulář → sestaví e-mail (mailto), nic neodesílá sám
   Žádné knihovny, žádný build. Funguje i přes file:// i přes serve.py.
   ================================================================= */

(function () {
  "use strict";

  /* ---------- E-MAIL SALONU (sem chodí poptávky) ---------- */
  var SALON_EMAIL = "salon.lnena@email.cz";

  /* ===== 1) MOBILNÍ MENU ===== */
  var toggle = document.getElementById("navToggle");
  var nav = document.getElementById("nav");

  if (toggle && nav) {
    toggle.addEventListener("click", function () {
      var open = nav.classList.toggle("open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.setAttribute("aria-label", open ? "Zavřít menu" : "Otevřít menu");
    });

    // klik na odkaz v menu → zavřít
    nav.querySelectorAll("a").forEach(function (link) {
      link.addEventListener("click", function () {
        nav.classList.remove("open");
        toggle.setAttribute("aria-expanded", "false");
      });
    });
  }

  /* ===== 2) REZERVAČNÍ FORMULÁŘ → MAILTO ===== */
  var form = document.getElementById("bookingForm");
  var hint = document.getElementById("formHint");

  if (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();

      // jednoduchá kontrola povinných polí
      var name = form.name.value.trim();
      var phone = form.phone.value.trim();

      if (!name || !phone) {
        if (hint) hint.textContent = "Vyplňte prosím jméno a telefon, ať se vám můžeme ozvat.";
        return;
      }

      var service = form.service.value;
      var date = form.date.value;   // formát RRRR-MM-DD
      var time = form.time.value;
      var note = form.note.value.trim();

      // datum do hezčího českého tvaru (DD. MM. RRRR)
      var datePretty = date
        ? date.split("-").reverse().join(". ")
        : "(neuvedeno)";

      var subject = "Poptávka termínu — " + service;

      var bodyLines = [
        "Dobrý den,",
        "",
        "ráda/rád bych se objednal(a):",
        "",
        "Jméno: " + name,
        "Telefon: " + phone,
        "Služba: " + service,
        "Preferovaný den: " + datePretty,
        "Přibližný čas: " + (time || "(neuvedeno)"),
        "Poznámka: " + (note || "—"),
        "",
        "Děkuji a budu se těšit."
      ];

      var mailto =
        "mailto:" + SALON_EMAIL +
        "?subject=" + encodeURIComponent(subject) +
        "&body=" + encodeURIComponent(bodyLines.join("\n"));

      // otevře e-mailový program s předvyplněnou zprávou
      window.location.href = mailto;

      if (hint) {
        hint.textContent =
          "Otevřeli jsme váš e-mailový program s hotovou zprávou — stačí ji odeslat. Pokud se nic neotevřelo, zavolejte nám na 734 221 558.";
      }
    });
  }

  /* ===== 3) ROK V PATIČCE (drobnost, ať je vždy aktuální) ===== */
  // pozn.: rok je napevno v HTML, ale kdyby chtěl uživatel auto-rok,
  // může sem doplnit element a my ho naplníme.
})();
