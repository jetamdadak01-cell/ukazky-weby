"use strict";
(function(){
  var REST_EMAIL = "rezervace@utrilip.cz"; /* UPRAVTE ZDE pro reálný podnik */

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

  /* rezervace -> předvyplněný e-mail (mailto); platí až po potvrzení podniku */
  var form = document.getElementById("form");
  if (form){
    form.addEventListener("submit", function(e){
      e.preventDefault();
      var d = new FormData(form);
      var body =
        "Dobrý den,\n\nrád(a) bych zarezervoval(a) stůl U Tří lip.\n\n" +
        "Jméno: " + (d.get("jmeno") || "") + "\n" +
        "Telefon: " + (d.get("telefon") || "") + "\n" +
        "Datum: " + (d.get("datum") || "") + "\n" +
        "Čas: " + (d.get("cas") || "") + "\n" +
        "Počet osob: " + (d.get("osob") || "") + "\n\n" +
        "Děkuji za potvrzení.";
      location.href = "mailto:" + REST_EMAIL +
        "?subject=" + encodeURIComponent("Rezervace stolu — U Tří lip") +
        "&body=" + encodeURIComponent(body);
    });
  }
})();
