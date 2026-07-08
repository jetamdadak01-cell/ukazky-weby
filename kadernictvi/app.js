"use strict";
(function(){
  var SALON_EMAIL = "salon.lnena@email.cz"; /* UPRAVTE ZDE pro reálný salon */

  /* mobilní menu */
  var burger = document.getElementById("burger");
  var nav = document.getElementById("nav");
  if (burger && nav){
    burger.addEventListener("click", function(){
      var open = nav.classList.toggle("open");
      burger.setAttribute("aria-expanded", open ? "true" : "false");
    });
    nav.addEventListener("click", function(e){
      if (e.target.tagName === "A") nav.classList.remove("open");
    });
  }

  /* reveal při scrollu */
  var els = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window){
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(en){
        if (en.isIntersecting){ en.target.classList.add("in"); io.unobserve(en.target); }
      });
    }, { threshold: .12 });
    els.forEach(function(el){ io.observe(el); });
  } else {
    els.forEach(function(el){ el.classList.add("in"); });
  }

  /* poptávkový formulář -> předvyplněný e-mail (mailto), nic se neodesílá samo */
  var form = document.getElementById("form");
  if (form){
    form.addEventListener("submit", function(e){
      e.preventDefault();
      var d = new FormData(form);
      var body =
        "Dobrý den,\n\nráda/rád bych se objednal(a) do Salonu Lněná.\n\n" +
        "Jméno: " + (d.get("jmeno") || "") + "\n" +
        "Telefon: " + (d.get("telefon") || "") + "\n" +
        "Služba: " + (d.get("sluzba") || "") + "\n" +
        "Termín: " + (d.get("termin") || "dle domluvy") + "\n\n" +
        "Děkuji.";
      location.href = "mailto:" + SALON_EMAIL +
        "?subject=" + encodeURIComponent("Objednání — Salon Lněná") +
        "&body=" + encodeURIComponent(body);
    });
  }
})();
