// Culture Tracker — vanilla JS frontend.
// Renders /data/latest.json as a single daily layer, top N per topic.

(function () {
  "use strict";

  // --- DOM refs ---
  const $intro = document.getElementById("intro");
  const $briefDate = document.getElementById("brief-date");
  const $filterCategory = document.getElementById("filter-category");
  const $filterSource = document.getElementById("filter-source");
  const $filterScore = document.getElementById("filter-score");
  const $filterReset = document.getElementById("filter-reset");
  const $archiveList = document.getElementById("archive-list");
  const $daily = document.getElementById("layer-daily");

  // --- State ---
  let brief = null;

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
    return el("span", { class: "item-score", title: "Relevance score (source authority + recency + cross-source momentum)" }, "★ " + score + "/10");
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
    const root = $daily;
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
  loadLatest();
  loadArchive();
})();
