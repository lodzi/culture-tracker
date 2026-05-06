// Culture Tracker — vanilla JS frontend.
// Renders /data/latest.json as trending topic clusters.
// Each topic = articles from ≥2 different sources discussing the same subject.

(function () {
  "use strict";

  // --- DOM refs ---
  const $intro          = document.getElementById("intro");
  const $briefDate      = document.getElementById("brief-date");
  const $filterCategory = document.getElementById("filter-category");
  const $filterSource   = document.getElementById("filter-source");
  const $filterMinSrc   = document.getElementById("filter-min-sources");
  const $filterReset    = document.getElementById("filter-reset");
  const $archiveList    = document.getElementById("archive-list");
  const $daily          = document.getElementById("layer-daily");

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

  function relativeTime(iso) {
    if (!iso) return "";
    try {
      const diff = Date.now() - new Date(iso).getTime();
      if (diff < 0) return "net";
      const h = Math.floor(diff / 3600000);
      if (h < 1) return "< 1u geleden";
      if (h < 24) return h + "u geleden";
      const d = Math.floor(h / 24);
      return d + "d geleden";
    } catch (e) { return ""; }
  }

  // --- Single article within a topic ---
  function renderTopicItem(item) {
    const titleNode = item.url
      ? el("a", { href: item.url, target: "_blank", rel: "noopener noreferrer" }, item.title || "Untitled")
      : document.createTextNode(item.title || "Untitled");

    const metaParts = [];
    if (item.source) {
      metaParts.push(el("span", { class: "pill source-name" }, item.source));
    }
    if (item.published) {
      metaParts.push(el("span", { class: "item-age" }, relativeTime(item.published)));
    }

    return el("article", { class: "item" }, [
      el("div", { class: "item-head" }, [
        el("h4", { class: "item-title" }, [titleNode]),
      ]),
      item.summary ? el("p", { class: "item-summary" }, item.summary) : null,
      el("div", { class: "item-meta" }, metaParts),
    ]);
  }

  // --- Full topic block ---
  function renderTopic(topic) {
    // Badge: 🔥 for topics covered by 3+ sources, neutral otherwise
    const badge = topic.trending
      ? el("span", { class: "badge badge-hot" }, "🔥 " + topic.sourceCount + " bronnen")
      : el("span", { class: "badge badge-neutral" }, topic.sourceCount + " bronnen");

    const titleRow = el("div", { class: "topic-title-row" }, [
      el("h3", { class: "topic-label" }, topic.label),
      badge,
    ]);

    // One pill per source — this is the core of the "who covers this?" view
    const sourcePills = (topic.sources || []).map(function (s) {
      return el("span", { class: "pill source" }, s);
    });
    const sourcesRow = el("div", { class: "topic-sources" }, sourcePills);

    // Category tags (music, fashion, internet, …)
    const catPills = (topic.categories || []).map(function (c) {
      return el("span", { class: "pill" }, c);
    });
    const catsRow = catPills.length
      ? el("div", { class: "topic-cats" }, catPills)
      : null;

    const header = el("header", { class: "topic-header" }, [titleRow, sourcesRow, catsRow]);

    // Individual articles
    const itemsEl = el("div", { class: "items" });
    (topic.items || []).forEach(function (item) {
      itemsEl.appendChild(renderTopicItem(item));
    });

    const cls = ["topic",
      topic.trending ? "is-trending" : "",
      topic.fresh    ? "is-fresh"    : "",
    ].filter(Boolean).join(" ");

    return el("section", { class: cls }, [header, itemsEl]);
  }

  // --- Render all topics (called on load + every filter change) ---
  function renderTopics() {
    $daily.innerHTML = "";
    const daily = (brief && brief.daily) || {};

    // Support both new format (topics) and legacy archive format (themes).
    let topics = Array.isArray(daily.topics) ? daily.topics : [];
    if (topics.length === 0 && Array.isArray(daily.themes)) {
      topics = daily.themes.map(function (theme) {
        const srcs = Array.from(
          new Set((theme.items || []).map(function (i) { return i.source; }).filter(Boolean))
        );
        return {
          label:       theme.title || "Topic",
          sourceCount: srcs.length,
          sources:     srcs,
          categories:  Array.from(new Set((theme.items || []).map(function (i) { return i.category; }).filter(Boolean))),
          trending:    false,
          fresh:       false,
          items:       theme.items || [],
        };
      });
    }

    // Apply filters
    const cat    = $filterCategory.value;
    const src    = $filterSource.value;
    const minSrc = parseInt($filterMinSrc.value, 10) || 2;

    const filtered = topics.filter(function (t) {
      if (t.sourceCount < minSrc) return false;
      if (cat && !(t.categories || []).includes(cat)) return false;
      if (src && !(t.sources    || []).includes(src)) return false;
      return true;
    });

    if (filtered.length === 0) {
      $daily.appendChild(el("p", { class: "empty" }, "Geen topics gevonden met deze filters."));
      return;
    }

    filtered.forEach(function (topic) {
      $daily.appendChild(renderTopic(topic));
    });
  }

  // --- Intro block ---
  function renderIntro() {
    $intro.innerHTML = "";
    const daily = (brief && brief.daily) || {};
    $intro.appendChild(el("h2", null, daily.title || "Culture Tracker"));
    if (daily.intro) $intro.appendChild(el("p", null, daily.intro));
    if (brief && brief.date) $briefDate.textContent = formatDate(brief.date);
  }

  // --- Populate filter dropdowns from current data ---
  function populateFilters() {
    const daily  = (brief && brief.daily) || {};
    const topics = Array.isArray(daily.topics) ? daily.topics : [];

    const allCats = new Set();
    const allSrcs = new Set();
    topics.forEach(function (t) {
      (t.categories || []).forEach(function (c) { allCats.add(c); });
      (t.sources    || []).forEach(function (s) { allSrcs.add(s); });
    });

    $filterCategory.length = 1;
    $filterSource.length   = 1;

    Array.from(allCats).sort().forEach(function (c) {
      $filterCategory.appendChild(el("option", { value: c }, c));
    });
    Array.from(allSrcs).sort().forEach(function (s) {
      $filterSource.appendChild(el("option", { value: s }, s));
    });
  }

  // --- Archive list ---
  function renderArchive(entries) {
    $archiveList.innerHTML = "";
    if (!entries || entries.length === 0) {
      $archiveList.appendChild(el("li", { class: "archive-empty" }, "No archive yet."));
      return;
    }
    entries.forEach(function (entry) {
      const date = typeof entry === "string" ? entry : entry.date;
      $archiveList.appendChild(
        el("li", null, [
          el("a", { href: "./data/archive/" + date + ".json" },
            formatDate(date) + " — " + date + ".json"),
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
      renderTopics();
    } catch (err) {
      console.error("Failed to load latest.json", err);
      $intro.innerHTML = "";
      $intro.appendChild(el("h2", null, "Culture Tracker"));
      $intro.appendChild(el("p", null,
        "Kon de brief niet laden. Zorg dat /data/latest.json bestaat. (" + err.message + ")"
      ));
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

  // --- Event wiring ---
  [$filterCategory, $filterSource, $filterMinSrc].forEach(function (input) {
    input.addEventListener("change", renderTopics);
  });
  $filterReset.addEventListener("click", function () {
    $filterCategory.value = "";
    $filterSource.value   = "";
    $filterMinSrc.value   = "2";
    renderTopics();
  });

  // --- Boot ---
  loadLatest();
  loadArchive();
})();
