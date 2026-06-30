/* ============================================================
   U Tří lip — interaktivita
   Vše čistě v prohlížeči, žádný server ani build.
   ============================================================ */
(function () {
  "use strict";

  /* --- Aktuální rok v patičce --- */
  var yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  /* --- Stín hlavičky při scrollu --- */
  var header = document.getElementById("header");
  function onScroll() {
    if (!header) return;
    header.classList.toggle("is-scrolled", window.scrollY > 10);
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* --- Mobilní menu (hamburger) --- */
  var burger = document.getElementById("burger");
  var nav = document.getElementById("nav");
  function closeNav() {
    if (!nav || !burger) return;
    nav.classList.remove("is-open");
    burger.classList.remove("is-open");
    burger.setAttribute("aria-expanded", "false");
    document.body.style.overflow = "";
  }
  if (burger && nav) {
    burger.addEventListener("click", function () {
      var open = nav.classList.toggle("is-open");
      burger.classList.toggle("is-open", open);
      burger.setAttribute("aria-expanded", open ? "true" : "false");
      document.body.style.overflow = open ? "hidden" : "";
    });
    // Zavřít po kliknutí na odkaz
    nav.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", closeNav);
    });
    // Zavřít klávesou Escape
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeNav();
    });
  }

  /* --- Záložky jídelního lístku --- */
  var tabs = document.querySelectorAll(".menu__tab");
  var panels = document.querySelectorAll(".menu__panel");
  tabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      var cat = tab.getAttribute("data-cat");
      tabs.forEach(function (t) {
        var active = t === tab;
        t.classList.toggle("is-active", active);
        t.setAttribute("aria-selected", active ? "true" : "false");
      });
      panels.forEach(function (p) {
        var show = p.getAttribute("data-panel") === cat;
        p.classList.toggle("is-active", show);
        p.hidden = !show;
      });
    });
  });

  /* --- Rezervační formulář → otevře e-mail (mailto) --- */
  var form = document.getElementById("reserveForm");
  var status = document.getElementById("reserveStatus");

  function setStatus(msg, ok) {
    if (!status) return;
    status.textContent = msg;
    status.classList.remove("is-ok", "is-err");
    status.classList.add(ok ? "is-ok" : "is-err");
  }

  if (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();

      // Jednoduchá kontrola povinných polí
      var required = form.querySelectorAll("[required]");
      var firstBad = null;
      required.forEach(function (input) {
        var bad = !String(input.value).trim();
        input.classList.toggle("is-error", bad);
        if (bad && !firstBad) firstBad = input;
      });
      if (firstBad) {
        setStatus("Vyplňte prosím všechna povinná pole (označená *).", false);
        firstBad.focus();
        return;
      }

      // Sestavení e-mailu
      var name = form.name.value.trim();
      var date = form.date.value;
      var time = form.time.value;
      var people = form.people.value;
      var phone = form.phone.value.trim();
      var note = form.note.value.trim();

      var subject = "Rezervace stolu — " + name + " (" + date + " " + time + ")";
      var bodyLines = [
        "Dobrý den,",
        "",
        "rád/a bych si rezervoval/a stůl:",
        "",
        "Jméno: " + name,
        "Datum: " + date,
        "Čas: " + time,
        "Počet osob: " + people,
        "Telefon: " + phone,
        note ? "Poznámka: " + note : "",
        "",
        "Děkuji a těším se na potvrzení.",
      ].filter(Boolean);

      var mailto =
        "mailto:rezervace@utrilip.cz" +
        "?subject=" + encodeURIComponent(subject) +
        "&body=" + encodeURIComponent(bodyLines.join("\n"));

      // Otevře e-mailový program návštěvníka
      window.location.href = mailto;

      setStatus(
        "Otevíráme váš e-mailový program s předvyplněnou rezervací. Pokud se nic nestalo, zavolejte nám prosím na 546 123 456.",
        true
      );
    });

    // Při psaní zrušíme chybové zvýraznění
    form.querySelectorAll("input, textarea").forEach(function (input) {
      input.addEventListener("input", function () {
        input.classList.remove("is-error");
      });
    });
  }

  /* --- Odhalení sekcí při scrollu --- */
  var revealTargets = document.querySelectorAll(
    ".feature, .story__media, .story__text, .daily__card, .dish, .gallery__item, .review, .contact__list li"
  );
  revealTargets.forEach(function (el) { el.classList.add("reveal"); });

  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });
    revealTargets.forEach(function (el) { io.observe(el); });
  } else {
    revealTargets.forEach(function (el) { el.classList.add("is-visible"); });
  }
})();
