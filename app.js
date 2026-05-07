// Culture Tracker — frontend.
// Ondersteunt twee dataformaten:
//   1. AI-formaat  → brief.daily.categories  (array van {id, label, insights[]})
//   2. Raw-formaat → brief.daily.topics      (array van topic-clusters, fallback)
//
// Tabs: Daily · Weekly (alleen als brief.weekly aanwezig is)

(function () {
  "use strict";

  // --- DOM refs ---
  const $intro      = document.getElementById("intro");
  const $briefDate  = document.getElementById("brief-date");
  const $catFilter  = document.getElementById("filter-category");
  const $resetBtn   = document.getElementById("filter-reset");
  const $layerDaily = document.getElementById("layer-daily");
  const $layerWeek  = document.getElementById("layer-weekly");
  const $tabDaily   = document.getElementById("tab-daily");
  const $tabWeek    = document.getElementById("tab-weekly");
  const $archList   = document.getElementById("archive-list");

  // --- State ---
  let brief  = null;
  let curTab = "daily";  // "daily" | "weekly"

  // --- Helpers ---
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === "class")   node.className  = attrs[k];
        else if (k === "html") node.innerHTML = attrs[k];
        else if (k.startsWith("on") && typeof attrs[k] === "function")
          node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] != null) node.setAttribute(k, attrs[k]);
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
      return d.toLocaleDateString("nl-BE", {
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
      return Math.floor(h / 24) + "d geleden";
    } catch (e) { return ""; }
  }

  // ── AI-formaat rendering ──────────────────────────────────────────────────

  function renderArticle(art) {
    const titleNode = art.url
      ? el("a", { href: art.url, target: "_blank", rel: "noopener noreferrer" }, art.title || "Zonder titel")
      : document.createTextNode(art.title || "Zonder titel");

    const meta = [];
    if (art.source)    meta.push(el("span", { class: "pill source-name" }, art.source));
    if (art.published) meta.push(el("span", { class: "item-age" }, relativeTime(art.published)));

    return el("article", { class: "item" }, [
      el("div", { class: "item-head" }, [el("h4", { class: "item-title" }, [titleNode])]),
      el("div", { class: "item-meta" }, meta),
    ]);
  }

  function renderInsight(insight) {
    const badgeCount = insight.sources ? insight.sources.length : 0;
    const badge = insight.trending
      ? el("span", { class: "badge badge-hot" }, "🔥 " + badgeCount + " bronnen")
      : (badgeCount >= 2
          ? el("span", { class: "badge badge-neutral" }, badgeCount + " bronnen")
          : null);

    const header = el("div", { class: "insight-header" }, [
      el("h3", { class: "insight-trend" }, insight.trend || ""),
      badge,
    ]);

    const summary = insight.summary
      ? el("p", { class: "insight-summary" }, insight.summary)
      : null;

    const why = insight.why_it_matters
      ? el("p", { class: "insight-why" }, [
          el("strong", null, "Waarom relevant: "),
          insight.why_it_matters,
        ])
      : null;

    const srcPills = (insight.sources || []).map(function (s) {
      return el("span", { class: "pill source" }, s);
    });
    const srcsRow = srcPills.length
      ? el("div", { class: "insight-sources" }, srcPills)
      : null;

    let articlesEl = null;
    if (insight.articles && insight.articles.length > 0) {
      const artItems = el("div", { class: "items" });
      insight.articles.forEach(function (a) { artItems.appendChild(renderArticle(a)); });
      articlesEl = el("details", { class: "insight-articles" }, [
        el("summary", null, insight.articles.length + " artikel" +
          (insight.articles.length !== 1 ? "s" : "") + " bekijken"),
        artItems,
      ]);
    }

    const cls = ["insight", insight.trending ? "is-trending" : ""].filter(Boolean).join(" ");
    return el("div", { class: cls }, [header, summary, why, srcsRow, articlesEl]);
  }

  function renderWeeklyInsight(insight) {
    const header = el("div", { class: "insight-header" }, [
      el("h3", { class: "insight-trend" }, insight.trend || ""),
    ]);
    const summary = insight.summary
      ? el("p", { class: "insight-summary" }, insight.summary)
      : null;
    const why = insight.why_it_matters
      ? el("p", { class: "insight-why" }, [
          el("strong", null, "Culturele verschuiving: "),
          insight.why_it_matters,
        ])
      : null;
    return el("div", { class: "insight" }, [header, summary, why]);
  }

  function renderCategorySection(cat, isWeekly) {
    const header = el("div", { class: "category-header" }, [
      el("h2", { class: "category-title" }, cat.label || cat.id),
    ]);
    const insightsEl = el("div", { class: "insights" });
    (cat.insights || []).forEach(function (ins) {
      insightsEl.appendChild(isWeekly ? renderWeeklyInsight(ins) : renderInsight(ins));
    });
    return el("section", { class: "category" }, [header, insightsEl]);
  }

  function renderAiLayer(data, $container, isWeekly) {
    $container.innerHTML = "";
    const cats     = Array.isArray(data.categories) ? data.categories : [];
    const filterVal = $catFilter ? $catFilter.value : "";
    const filtered  = filterVal ? cats.filter(function (c) { return c.id === filterVal; }) : cats;

    if (filtered.length === 0) {
      $container.appendChild(el("p", { class: "empty" }, "Geen data beschikbaar voor deze periode."));
      return;
    }
    filtered.forEach(function (cat) {
      $container.appendChild(renderCategorySection(cat, isWeekly));
    });
  }

  // ── Raw-formaat rendering (fallback voor als synthesis nog niet gedraaid heeft) ───

  function renderTopicItem(item) {
    const titleNode = item.url
      ? el("a", { href: item.url, target: "_blank", rel: "noopener noreferrer" }, item.title || "Zonder titel")
      : document.createTextNode(item.title || "Zonder titel");
    const meta = [];
    if (item.source)    meta.push(el("span", { class: "pill source-name" }, item.source));
    if (item.published) meta.push(el("span", { class: "item-age" }, relativeTime(item.published)));
    return el("article", { class: "item" }, [
      el("div", { class: "item-head" }, [el("h4", { class: "item-title" }, [titleNode])]),
      item.summary ? el("p", { class: "item-summary" }, item.summary) : null,
      el("div", { class: "item-meta" }, meta),
    ]);
  }

  function renderRawLayer(data, $container) {
    $container.innerHTML = "";
    const topics = Array.isArray(data.topics) ? data.topics : [];
    if (topics.length === 0) {
      $container.appendChild(el("p", { class: "empty" },
        "Geen topics — AI synthesis is nog niet gedraaid."));
      return;
    }
    topics.forEach(function (topic) {
      const badge = topic.trending
        ? el("span", { class: "badge badge-hot" }, "🔥 " + topic.sourceCount + " bronnen")
        : el("span", { class: "badge badge-neutral" }, topic.sourceCount + " bronnen");
      const sourcePills = (topic.sources || []).map(function (s) {
        return el("span", { class: "pill source" }, s);
      });
      const itemsEl = el("div", { class: "items" });
      (topic.items || []).forEach(function (i) { itemsEl.appendChild(renderTopicItem(i)); });
      $container.appendChild(el("section", {
        class: ["topic", topic.trending ? "is-trending" : ""].filter(Boolean).join(" "),
      }, [
        el("header", { class: "topic-header" }, [
          el("div", { class: "topic-title-row" }, [
            el("h3", { class: "topic-label" }, topic.label), badge,
          ]),
          el("div", { class: "topic-sources" }, sourcePills),
        ]),
        itemsEl,
      ]));
    });
  }

  // ── Tab switching ─────────────────────────────────────────────────────────

  function showTab(tab) {
    curTab = tab;
    if ($tabDaily) $tabDaily.classList.toggle("active", tab === "daily");
    if ($tabWeek)  $tabWeek.classList.toggle("active",  tab === "weekly");
    if ($layerDaily) $layerDaily.classList.toggle("hidden", tab !== "daily");
    if ($layerWeek)  $layerWeek.classList.toggle("hidden",  tab !== "weekly");
    renderCurrentTab();
  }

  function renderCurrentTab() {
    if (!brief) return;

    if (curTab === "daily" && $layerDaily) {
      const daily = brief.daily || {};
      if (Array.isArray(daily.categories)) renderAiLayer(daily, $layerDaily, false);
      else renderRawLayer(daily, $layerDaily);
    }

    if (curTab === "weekly" && $layerWeek && brief.weekly) {
      renderAiLayer(brief.weekly, $layerWeek, true);
    }
  }

  // ── Filters ───────────────────────────────────────────────────────────────

  function populateCatFilter() {
    if (!$catFilter) return;
    $catFilter.length = 1;
    const daily = (brief && brief.daily) || {};
    const cats  = Array.isArray(daily.categories) ? daily.categories : [];
    cats.forEach(function (c) {
      $catFilter.appendChild(el("option", { value: c.id }, c.label || c.id));
    });
  }

  // ── Intro ─────────────────────────────────────────────────────────────────

  function renderIntro() {
    if ($intro) {
      $intro.innerHTML = "";
      const daily = (brief && brief.daily) || {};
      $intro.appendChild(el("h2", null, "Culture Tracker"));
      if (daily.intro) $intro.appendChild(el("p", null, daily.intro));
    }
    if ($briefDate && brief && brief.date) {
      $briefDate.textContent = formatDate(brief.date);
    }
  }

  function updateTabVisibility() {
    const hasWeekly = brief && brief.weekly && Array.isArray(brief.weekly.categories);
    if ($tabWeek) $tabWeek.classList.toggle("hidden", !hasWeekly);
  }

  // ── Archive ───────────────────────────────────────────────────────────────

  function renderArchive(entries) {
    if (!$archList) return;
    $archList.innerHTML = "";
    if (!entries || entries.length === 0) {
      $archList.appendChild(el("li", { class: "archive-empty" }, "Nog geen archief."));
      return;
    }
    entries.forEach(function (entry) {
      const date = typeof entry === "string" ? entry : entry.date;
      $archList.appendChild(el("li", null, [
        el("a", { href: "./data/archive/" + date + ".json" },
          formatDate(date) + " — " + date + ".json"),
      ]));
    });
  }

  // ── Loaders ───────────────────────────────────────────────────────────────

  async function loadLatest() {
    try {
      const res = await fetch("./data/latest.json", { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      brief = await res.json();
      renderIntro();
      updateTabVisibility();
      populateCatFilter();
      showTab("daily");
    } catch (err) {
      console.error("Kon latest.json niet laden:", err);
      if ($intro) {
        $intro.innerHTML = "";
        $intro.appendChild(el("h2", null, "Culture Tracker"));
        $intro.appendChild(el("p", null,
          "Kon de brief niet laden. Zorg dat data/latest.json bestaat. (" + err.message + ")"));
      }
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
    } catch (err) { renderArchive([]); }
  }

  // ── Event wiring ──────────────────────────────────────────────────────────

  if ($tabDaily) $tabDaily.addEventListener("click", function () { showTab("daily"); });
  if ($tabWeek)  $tabWeek.addEventListener("click",  function () { showTab("weekly"); });
  if ($catFilter) $catFilter.addEventListener("change", renderCurrentTab);
  if ($resetBtn)  $resetBtn.addEventListener("click", function () {
    if ($catFilter) $catFilter.value = "";
    renderCurrentTab();
  });

  // ── Boot ──────────────────────────────────────────────────────────────────
  loadLatest();
  loadArchive();

})();
