/* Claude Keeper showcase — interactive demo + UI behavior. No dependencies. */
(function () {
  "use strict";

  /* ── Scroll reveal ───────────────────────────────── */
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
  }, { threshold: 0.12 });
  document.querySelectorAll(".reveal").forEach(function (el) { io.observe(el); });

  /* ── Use-case tabs ───────────────────────────────── */
  var tabs = document.querySelectorAll(".tab");
  tabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      var target = tab.getAttribute("data-tab");
      tabs.forEach(function (t) { t.classList.toggle("active", t === tab); });
      document.querySelectorAll(".panel").forEach(function (p) {
        p.classList.toggle("active", p.getAttribute("data-panel") === target);
      });
    });
  });

  /* ── Animated terminal demo (drives every .js-demo screen) ── */
  var screens = [].slice.call(document.querySelectorAll(".js-demo-body")).map(function (body) {
    return { body: body, state: body.parentNode.querySelector(".js-demo-state") };
  });
  var btn = document.getElementById("demoToggle");
  if (!screens.length) return;

  var GLYPH = {
    RUNNING:  { g: "\u25CF", cls: "s-running",  label: "RUNNING" },
    LIMIT:    { g: "\u26A0", cls: "s-limit",    label: "LIMIT" },
    WAITING:  { g: "\u25D0", cls: "s-waiting",  label: "WAITING" },
    RESUMING: { g: "\u21BB", cls: "s-resuming", label: "RESUMING" }
  };

  var timers = [];
  function clearTimers() { timers.forEach(function (t) { clearTimeout(t); clearInterval(t); }); timers = []; }
  function after(ms, fn) { var t = setTimeout(fn, ms); timers.push(t); return t; }

  function setState(s) {
    var m = GLYPH[s];
    screens.forEach(function (sc) {
      if (!sc.state) return;
      sc.state.className = "term-state " + m.cls + " js-demo-state";
      sc.state.innerHTML = '<span class="glyph">' + m.g + "</span> " + m.label;
    });
  }

  function line(html, cls) {
    screens.forEach(function (sc) {
      var d = document.createElement("div");
      d.className = "term-line" + (cls ? " " + cls : "");
      d.innerHTML = html;
      sc.body.appendChild(d);
      sc.body.scrollTop = sc.body.scrollHeight;
    });
  }

  function fmt(ms) {
    if (ms < 0) ms = 0;
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60); s -= m * 60;
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return p(h) + " : " + p(m) + " : " + p(s);
  }

  // The demo compresses a 5-hour wait into ~9 seconds so it is watchable.
  var DEMO_WAIT_MS = 9000;

  function runCycle() {
    clearTimers();
    screens.forEach(function (sc) { sc.body.innerHTML = ""; });

    setState("RUNNING");
    line('<span class="p">claude&gt;</span> refactor the auth module to use JWT refresh tokens');
    after(700, function () { line('<span class="c">\u25CF</span> Reading <span class="dim">src/auth/session.ts</span> \u2026'); });
    after(1500, function () { line('<span class="c">\u25CF</span> Applying changes to 7 files \u2026'); });
    after(2400, function () { line('<span class="dim">  applying edits across the project \u2026</span>'); });
    after(3300, function () {
      line('<span class="warn">Claude usage limit reached. Your limit will reset at 3:00 PM (America/New_York).</span>');
      setState("LIMIT");
    });

    after(4200, function () {
      setState("WAITING");
      var reset = Date.now() + DEMO_WAIT_MS;
      var cds = [];
      screens.forEach(function (sc) {
        var banner = document.createElement("div");
        banner.className = "limit-banner";
        banner.innerHTML =
          '<div class="ttl">\u26A0 Usage limit reached \u2014 auto-resume armed</div>' +
          '<div class="countdown">' + fmt(DEMO_WAIT_MS) + "</div>" +
          '<div class="cd-meta">at 3:00\u202FPM (America/New_York) \u00B7 strategy: <b>Continue</b> \u00B7 source: parsed</div>' +
          '<div class="progress"><span></span></div>' +
          '<div class="cd-meta">survives app restart &amp; laptop sleep \u00B7 retries 0/5</div>';
        sc.body.appendChild(banner);
        sc.body.scrollTop = sc.body.scrollHeight;
        cds.push({ cd: banner.querySelector(".countdown"), bar: banner.querySelector(".progress > span") });
      });

      var iv = setInterval(function () {
        var remain = reset - Date.now();
        var pct = Math.min(100, Math.max(0, (1 - remain / DEMO_WAIT_MS) * 100));
        cds.forEach(function (x) { x.cd.textContent = fmt(remain); x.bar.style.width = pct.toFixed(1) + "%"; });
        if (remain <= 0) clearInterval(iv);
      }, 100);
      timers.push(iv);

      after(DEMO_WAIT_MS + 200, function () {
        setState("RESUMING");
        line('<span class="s-resuming">\u21BB</span> Limit reset \u2014 resuming with the <span class="c">Continue</span> strategy');
      });
      after(DEMO_WAIT_MS + 1300, function () {
        setState("RUNNING");
        line('<span class="p">claude&gt;</span> <span class="dim">(context restored)</span> continuing the refactor \u2026');
        line('<span class="c">\u25CF</span> Done. Work complete. <span class="cursor"></span>');
      });
      after(DEMO_WAIT_MS + 3600, function () {
        line('<span class="dim">\u2014 demo loops \u2014</span>');
        after(1200, runCycle);
      });
    });
  }

  var playing = true;
  function start() { playing = true; if (btn) btn.textContent = "\u23F8 Pause demo"; runCycle(); }
  function stop() { playing = false; clearTimers(); if (btn) btn.textContent = "\u25B6 Play demo"; }
  if (btn) btn.addEventListener("click", function () { playing ? stop() : start(); });

  // Animate immediately (the hero terminal is visible on load), and be polite:
  // pause the loop while the tab is hidden, resume when it comes back.
  runCycle();
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) { clearTimers(); }
    else if (playing) { runCycle(); }
  });
})();

/* ── Smart download links: detect OS/arch and point each download control
   at the matching installer asset of the latest GitHub release. Degrades
   gracefully — if detection or the API call fails, every control keeps its
   default href (the releases page). ─────────────────────────────────────── */
(function () {
  "use strict";

  var REPO = "rking2003/claude-keeper";
  var RELEASES_PAGE = "https://github.com/" + REPO + "/releases/latest";

  var OS_META = {
    win:   { name: "Windows", icon: "\uD83E\uDE9F", ext: "exe",      label: "Windows installer (.exe)" },
    mac:   { name: "macOS",   icon: "\uD83C\uDF4E", ext: "dmg",      label: "macOS installer (.dmg)" },
    linux: { name: "Linux",   icon: "\uD83D\uDC27", ext: "AppImage", label: "Linux AppImage" }
  };

  function detectOS() {
    var uaPlat = (navigator.userAgentData && navigator.userAgentData.platform) || "";
    var s = (uaPlat + " " + (navigator.platform || "") + " " + (navigator.userAgent || "")).toLowerCase();
    if (/win/.test(s)) return "win";
    if (/mac|iphone|ipad|ipod/.test(s)) return "mac";
    if (/linux|android|x11|cros/.test(s)) return "linux";
    return null;
  }

  function guessArch() {
    var s = ((navigator.platform || "") + " " + (navigator.userAgent || "")).toLowerCase();
    return /arm64|aarch64/.test(s) ? "arm64" : "x64";
  }

  function detectArch() {
    var uad = navigator.userAgentData;
    if (uad && typeof uad.getHighEntropyValues === "function") {
      return uad.getHighEntropyValues(["architecture"]).then(function (v) {
        var a = (v && v.architecture ? v.architecture : "").toLowerCase();
        if (a.indexOf("arm") >= 0) return "arm64";
        if (a.indexOf("x86") >= 0 || a.indexOf("amd") >= 0) return "x64";
        return guessArch();
      }).catch(guessArch);
    }
    return Promise.resolve(guessArch());
  }

  function archMatches(name, arch) {
    var n = name.toLowerCase();
    if (arch === "arm64") return /arm64|aarch64/.test(n);
    // x64: electron-builder names the x64 AppImage without an arch token, so
    // treat "no arm marker" as x64 (alongside explicit x64/amd64/x86_64).
    if (/x64|amd64|x86_64/.test(n)) return true;
    return !/arm64|aarch64/.test(n);
  }

  function pick(assets, os, arch) {
    var meta = OS_META[os];
    var extRe = new RegExp("\\." + meta.ext + "$", "i");
    var usable = assets.filter(function (a) {
      return !/\.blockmap$/i.test(a.name) && extRe.test(a.name);
    });
    var match = usable.filter(function (a) { return archMatches(a.name, arch); })[0];
    if (!match) match = usable[0]; // any installer of this OS as a last resort
    return match || null;
  }

  function setLinks(os, url) {
    document.querySelectorAll('[data-dl="' + os + '"]').forEach(function (el) { el.href = url; });
  }

  function highlight(os, arch, urls) {
    if (!os || !OS_META[os]) return;
    var meta = OS_META[os];

    var banner = document.getElementById("dlDetected");
    if (banner) {
      var nm = document.getElementById("dlDetectedName");
      var sub = document.getElementById("dlDetectedSub");
      var ic = document.getElementById("dlDetectedIc");
      var btn = document.getElementById("dlDetectedBtn");
      if (ic) ic.textContent = meta.icon;
      if (nm) nm.textContent = meta.name + " (" + arch + ")";
      if (sub) sub.textContent = "Recommended: " + meta.label + ". Other platforms are below.";
      if (btn) {
        btn.href = urls[os] || RELEASES_PAGE;
        btn.textContent = "\u2193 Download for " + meta.name;
      }
      banner.hidden = false;
    }

    var card = document.querySelector('[data-os-card="' + os + '"]');
    if (card && !card.querySelector(".rec-tag")) {
      card.classList.add("is-recommended");
      var tag = document.createElement("span");
      tag.className = "rec-tag";
      tag.textContent = "\u2713 Recommended for your machine";
      card.appendChild(tag);
    }
  }

  function init(release, arch) {
    var assets = (release && release.assets) || [];
    var urls = {};
    ["win", "mac", "linux"].forEach(function (os) {
      var a = pick(assets, os, arch);
      var url = a ? a.browser_download_url : RELEASES_PAGE;
      urls[os] = url;
      setLinks(os, url);
    });
    highlight(detectOS(), arch, urls);
  }

  if (!("fetch" in window)) return;

  Promise.all([
    fetch("https://api.github.com/repos/" + REPO + "/releases/latest", {
      headers: { Accept: "application/vnd.github+json" }
    }).then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("release fetch failed")); }),
    detectArch()
  ]).then(function (res) {
    init(res[0], res[1]);
  }).catch(function () {
    // Detection still helps even if the asset list is unavailable: highlight
    // the visitor's OS card while links stay on the releases page.
    detectArch().then(function (arch) { highlight(detectOS(), arch, {}); }).catch(function () {});
  });
})();
