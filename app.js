// Culture Tracker — vanilla JS frontend.
// Renders /data/latest.json across three layers: daily / weekly / monthly.

(function () {
  "use strict";

  // --- DOM refs ---
  const $intro = document.getElementById("intro");
  const $briefDate = document.getElementById("brief-date");
  const $filters = document.getElementById("filters");
  const $filterCategory = document.getElementById("filter-category");
  const $filterSource = document.getElementById("filter-source");
  const $filterScore = document.getElementById("filter-score");
  const $filterReset = document.getElementById("filter-reset");
  const $archiveList = document.getElementById("archive-list");
  const layerEls = {
    daily:   document.getElementById("layer-daily"),
    weekly:  document.getElementById("layer-weekly"),
    monthly: document.getElementById("layer-monthly"),
  };
  const $layerButtons = document.querySelectorAll(".layer-btn");

  // --- State ---
  let brief = null;
  let activeLayer = "daily";

  // --- Helpers ---
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === "class") node.className = attrs[k];
        else if (k === "html") node.innerHTML = attrs[k];
        else if (k.startsWith("on") && typeof attrs[k] === "function") {
          node.addEventListener(k.slice(2), attrs[k]);
        } else if (attrs[k] !== undefined && attrs[k] !== null) {
          node.setAttribute(k, attrs[k]);
        }
      }
    }
    if (children) {
      (Array.isArray(children) ? children : [children]).forEach(function (c) {
        if (c == null) return;
        node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
      });
    }
    return node;
  }

  function formatDate(iso) {
    try {
      const d = new Date(iso + "T00:00:00");
      if (isNaN(d.getTime())) return iso;
      return d.toLocaleDateString(undefined, {
        weekday: "long", year: "numeric", month: "long", day: "numeric",
      });
    } catch (e) { return iso; }
  }

  function unique(values) {
    return Array.from(new Set(values.filter(Boolean))).sort();
  }

  function scorePill(score) {
    if (typeof score !== "number") return null;
    return el("span", { class: "item-score", title: "Score" }, "★ " + score + "/10");
  }

  // --- Layer switching ---
  function setLayer(name) {
    activeLayer = name;
    Object.keys(layerEls).forEach(function (k) {
      layerEls[k].classList.toggle("hidden", k !== name);
    });
    $layerButtons.forEach(function (btn) {
      btn.classList.toggle("active", btn.dataset.layer === name);
    });
    // Filters are only meaningful for the daily layer.
    $filters.classList.toggle("hidden", name !== "daily");
  }

  // --- Daily layer ---
  function renderDailyItem(item) {
    const meta = el("div", { class: "item-meta" });
    if (item.category) meta.appendChild(el("span", { class: "pill" }, item.category));
    if (item.source) {
      const sourceText = item.url
        ? el("a", { href: item.url, target: "_blank", rel: "noopener noreferrer" }, item.source)
        : document.createTextNode(item.source);
      meta.appendChild(el("span", { class: "pill source" }, [sourceText]));
    }

    const head = el("div", { class: "item-head" }, [
      el("h4", { class: "item-title" },
        item.url
          ? [el("a", { href: item.url, target: "_blank", rel: "noopener noreferrer" }, item.title || "Untitled")]
          : item.title || "Untitled"
      ),
      scorePill(item.score),
    ]);

    return el("article", { class: "item" }, [
      head,
      item.summary ? el("p", { class: "item-summary" }, item.summary) : null,
      item.cultural_relevance
        ? el("p", { class: "item-relevance" }, item.cultural_relevance)
        : null,
      meta,
    ]);
  }

  function renderDaily() {
    const root = layerEls.daily;
    root.innerHTML = "";
    const daily = brief.daily || {};
    const themes = Array.isArray(daily.themes) ? daily.themes : [];

    const cat = $filterCategory.value;
    const src = $filterSource.value;
    const minScore = parseInt($filterScore.value, 10) || 0;

    let totalShown = 0;

    themes.forEach(function (theme) {
      const filtered = (theme.items || []).filter(function (item) {
        if (cat && item.category !== cat) return false;
        if (src && item.source !== src) return false;
        if (minScore > 0 && (typeof item.score !== "number" || item.score < minScore)) return false;
        return true;
      });
      if (filtered.length === 0) return;

      const items = el("div", { class: "items" });
      filtered.forEach(function (item) {
        items.appendChild(renderDailyItem(item));
        totalShown++;
      });

      root.appendChild(el("section", { class: "theme" }, [
        el("header", { class: "theme-header" }, [
          el("h3", { class: "theme-title" }, theme.title || "Untitled theme"),
          theme.summary ? el("p", { class: "theme-summary" }, theme.summary) : null,
        ]),
        items,
      ]));
    });

    if (totalShown === 0) {
      root.appendChild(el("p", { class: "empty" }, "No items match the current filters."));
    }
  }

  // --- Weekly hypes layer ---
  function renderHype(h) {
    const cats = (h.categories || []).map(function (c) {
      return el("span", { class: "pill" }, c);
    });
    const head = el("div", { class: "item-head" }, [
      el("h3", { class: "card-title" }, h.title || "Untitled hype"),
      scorePill(h.score),
    ]);
    const signals = Array.isArray(h.signals) && h.signals.length
      ? el("ul", { class: "signals" }, h.signals.map(function (s) {
          return el("li", null, s);
        }))
      : null;

    return el("article", { class: "card" }, [
      head,
      h.description ? el("p", { class: "card-body" }, h.description) : null,
      h.why_it_matters
        ? el("p", { class: "card-aside" }, [
            el("strong", null, "Why it matters: "),
            document.createTextNode(h.why_it_matters),
          ])
        : null,
      signals
        ? el("div", { class: "card-section" }, [
            el("h4", { class: "card-section-title" }, "Signals"),
            signals,
          ])
        : null,
      cats.length ? el("div", { class: "item-meta" }, cats) : null,
    ]);
  }

  function renderWeekly() {
    const root = layerEls.weekly;
    root.innerHTML = "";
    const hypes = Array.isArray(brief.weekly_hypes) ? brief.weekly_hypes : [];
    if (hypes.length === 0) {
      root.appendChild(el("p", { class: "empty" }, "No weekly hypes yet — they'll show up after a few days of data."));
      return;
    }
    const intro = el("p", { class: "layer-intro" },
      "Patterns gaining traction across multiple sources this week.");
    root.appendChild(intro);
    hypes.forEach(function (h) { root.appendChild(renderHype(h)); });
  }

  // --- Monthly trends layer ---
  function renderTrend(t) {
    const head = el("div", { class: "item-head" }, [
      el("h3", { class: "card-title" }, t.title || "Untitled trend"),
      scorePill(t.score),
    ]);
    const evidence = Array.isArray(t.evidence) && t.evidence.length
      ? el("ul", { class: "signals" }, t.evidence.map(function (s) {
          return el("li", null, s);
        }))
      : null;

    return el("article", { class: "card" }, [
      head,
      t.description ? el("p", { class: "card-body" }, t.description) : null,
      t.cultural_shift
        ? el("p", { class: "card-aside" }, [
            el("strong", null, "Cultural shift: "),
            document.createTextNode(t.cultural_shift),
          ])
        : null,
      evidence
        ? el("div", { class: "card-section" }, [
            el("h4", { class: "card-section-title" }, "Evidence"),
            evidence,
          ])
        : null,
      t.implications
        ? el("div", { class: "card-section" }, [
            el("h4", { class: "card-section-title" }, "Implications"),
            el("p", { class: "card-body" }, t.implications),
          ])
        : null,
    ]);
  }

  function renderMonthly() {
    const root = layerEls.monthly;
    root.innerHTML = "";
    const trends = Array.isArray(brief.monthly_trends) ? brief.monthly_trends : [];
    if (trends.length === 0) {
      root.appendChild(el("p", { class: "empty" }, "No monthly trends yet — they'll show up after several days of data."));
      return;
    }
    const intro = el("p", { class: "layer-intro" },
      "Macro shifts in popular culture — patterns that span weeks or months.");
    root.appendChild(intro);
    trends.forEach(function (t) { root.appendChild(renderTrend(t)); });
  }

  // --- Intro + filters population ---
  function renderIntro() {
    $intro.innerHTML = "";
    const daily = brief.daily || {};
    $intro.appendChild(el("h2", null, daily.title || "Daily Culture Brief"));
    if (daily.intro) $intro.appendChild(el("p", null, daily.intro));
    if (brief.date) $briefDate.textContent = formatDate(brief.date);
  }

  function populateFilters() {
    const themes = (brief.daily && brief.daily.themes) || [];
    const allItems = [];
    themes.forEach(function (t) {
      (t.items || []).forEach(function (i) { allItems.push(i); });
    });
    const categories = unique(allItems.map(function (i) { return i.category; }));
    const sources = unique(allItems.map(function (i) { return i.source; }));

    // Reset and refill (in case of reload).
    $filterCategory.length = 1;
    $filterSource.length = 1;

    categories.forEach(function (c) {
      $filterCategory.appendChild(el("option", { value: c }, c));
    });
    sources.forEach(function (s) {
      $filterSource.appendChild(el("option", { value: s }, s));
    });
  }

  // --- Archive ---
  function renderArchive(entries) {
    $archiveList.innerHTML = "";
    if (!entries || entries.length === 0) {
      $archiveList.appendChild(el("li", { class: "archive-empty" }, "No archive yet."));
      return;
    }
    entries.forEach(function (entry) {
      const date = typeof entry === "string" ? entry : entry.date;
      const path = "./data/archive/" + date + ".json";
      $archiveList.appendChild(
        el("li", null, [
          el("a", { href: path }, formatDate(date) + " — " + date + ".json"),
        ])
      );
    });
  }

  // --- Loaders ---
  async function loadLatest() {
    try {
      const res = await fetch("./data/latest.json", { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      brief = await res.json();
      renderIntro();
      populateFilters();
      renderDaily();
      renderWeekly();
      renderMonthly();
    } catch (err) {
      console.error("Failed to load latest.json", err);
      $intro.innerHTML = "";
      $intro.appendChild(el("h2", null, "Daily Culture Brief"));
      $intro.appendChild(
        el("p", null,
          "Could not load today's brief. Make sure /data/latest.json exists. (" + err.message + ")"
        )
      );
    }
  }

  async function loadArchive() {
    try {
      const res = await fetch("./data/archive/index.json", { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const entries = await res.json();
      entries.sort(function (a, b) {
        const da = typeof a === "string" ? a : a.date;
        const db = typeof b === "string" ? b : b.date;
        return db.localeCompare(da);
      });
      renderArchive(entries);
    } catch (err) {
      renderArchive([]);
    }
  }

  // --- Wiring ---
  $layerButtons.forEach(function (btn) {
    btn.addEventListener("click", function () { setLayer(btn.dataset.layer); });
  });
  [$filterCategory, $filterSource, $filterScore].forEach(function (el) {
    el.addEventListener("change", renderDaily);
  });
  $filterReset.addEventListener("click", function () {
    $filterCategory.value = "";
    $filterSource.value = "";
    $filterScore.value = "0";
    renderDaily();
  });

  // --- Boot ---
  setLayer("daily");
  loadLatest();
  loadArchive();
})();
