// Culture Tracker — frontend.
// Ondersteunt twee dataformaten:
//   1. AI-formaat  → brief.daily.categories  (array van {id, label, insights[]})
//   2. Raw-formaat → brief.daily.topics      (array van topic-clusters, fallback)
//
// Tabs: Daily · Weekly · Monthly (alleen als data aanwezig is)

(function () {
  "use strict";

  // --- DOM refs ---
  const $intro       = document.getElementById("intro");
  const $briefDate   = document.getElementById("brief-date");
  const $catFilter   = document.getElementById("filter-category");
  const $resetBtn    = document.getElementById("filter-reset");
  const $layerDaily  = document.getElementById("layer-daily");
  const $layerWeek   = document.getElementById("layer-weekly");
  const $layerMonth  = document.getElementById("layer-monthly");
  const $tabDaily    = document.getElementById("tab-daily");
  const $tabWeek     = document.getElementById("tab-weekly");
  const $tabMonth    = document.getElementById("tab-monthly");
  const $archList    = document.getElementById("archive-list");

  // --- State ---
  let brief  = null;
  let curTab = "daily";  // "daily" | "weekly" | "monthly"

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

  // ── Cross-category mega-trends rendering ─────────────────────────────────

  function renderMegaTrend(mt) {
    const catPills = (mt.categories || []).map(function (c) {
      return el("span", { class: "pill mega-cat" }, c);
    });
    const catsRow = catPills.length
      ? el("div", { class: "mega-cats" }, catPills)
      : null;

    // strength: "sterk" | "matig" — uit AI-output
    const strengthLabel = mt.strength === "sterk" ? "⚡ Sterk signaal" : "Cross-categorie";
    const strengthBadge = el("span", { class: "badge badge-mega" }, strengthLabel);

    const why = mt.why_it_matters
      ? el("p", { class: "mega-signal" }, [
          el("strong", null, "Waarom: "),
          mt.why_it_matters,
        ])
      : null;

    return el("div", { class: "mega-trend" + (mt.strength === "sterk" ? " is-strong" : "") }, [
      el("div", { class: "mega-trend-header" }, [
        el("h3", { class: "mega-trend-name" }, mt.trend || ""),
        strengthBadge,
      ]),
      mt.summary ? el("p", { class: "mega-summary" }, mt.summary) : null,
      why,
      catsRow,
    ]);
  }

  function renderCrossCategory(crossCat, $container) {
    const megaTrends = (crossCat && Array.isArray(crossCat.megaTrends))
      ? crossCat.megaTrends : [];
    if (megaTrends.length === 0) return;

    const wrap = el("section", { class: "cross-category" });
    const headerEl = el("div", { class: "category-header cross-category-header" }, [
      el("h2", { class: "category-title" }, "Culture Radar"),
      el("span", { class: "cross-category-sub" },
        megaTrends.length + " mega-" + (megaTrends.length === 1 ? "trend" : "trends") + " vandaag"),
    ]);
    wrap.appendChild(headerEl);
    const grid = el("div", { class: "mega-trends-grid" });
    megaTrends.forEach(function (mt) { grid.appendChild(renderMegaTrend(mt)); });
    wrap.appendChild(grid);
    $container.appendChild(wrap);
  }

  // ── Report macro-trends (uit de gecureerde trendrapporten) ───────────────

  function renderReportInsights(report, $container) {
    const trends = (report && Array.isArray(report.macroTrends)) ? report.macroTrends : [];
    if (trends.length === 0) return;

    const cards = trends.map(function (mt) {
      const horizon = mt.horizon
        ? el("span", { class: "badge badge-horizon" }, "↗ " + mt.horizon)
        : (mt.strength
            ? el("span", { class: "badge " + (mt.strength === "sterk" ? "badge-hot" : "badge-neutral") }, mt.strength)
            : null);
      const header = el("div", { class: "insight-header" }, [
        el("h3", { class: "insight-trend" }, mt.trend || ""), horizon,
      ]);
      const summary = mt.summary ? el("p", { class: "insight-summary" }, mt.summary) : null;
      const why = mt.why_it_matters
        ? el("p", { class: "insight-why" }, [el("strong", null, "Waarom relevant: "), mt.why_it_matters])
        : null;
      const action = mt.strategic_action
        ? el("p", { class: "insight-why" }, [el("strong", null, "Strategische actie: "), mt.strategic_action])
        : null;
      const cats = (mt.categories || []).map(function (c) { return el("span", { class: "pill source" }, c); });
      const catsRow = cats.length ? el("div", { class: "insight-sources" }, cats) : null;
      return el("div", { class: "insight" }, [header, summary, why, action, catsRow]);
    });

    const count = report.processedCount || report.reportCount;
    const details = el("details", { class: "report-insights" }, [
      el("summary", null, "Macro-trends uit " + (count ? count + " " : "") + "trendrapporten (" + trends.length + ")"),
      report.intro ? el("p", { class: "insight-summary" }, report.intro) : null,
      el("div", { class: "insights" }, cards),
    ]);

    $container.appendChild(el("section", { class: "category" }, [
      el("div", { class: "category-header" }, [el("h2", { class: "category-title" }, "Uit de trendrapporten")]),
      details,
    ]));
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
    const sourceBadge = insight.trending
      ? el("span", { class: "badge badge-hot" }, "🔥 " + badgeCount + " bronnen")
      : (badgeCount >= 2
          ? el("span", { class: "badge badge-neutral" }, badgeCount + " bronnen")
          : null);

    const header = el("div", { class: "insight-header" }, [
      el("h3", { class: "insight-trend" }, insight.trend || ""),
      sourceBadge,
    ]);

    // Trajectory + streak/new meta-badges
    const metaBadges = [];
    if (insight.trajectory) {
      const tMap = {
        "opkomend":  { label: "▲ opkomend",  cls: "badge-up" },
        "piekend":   { label: "● piekend",   cls: "badge-peak" },
        "afbouwend": { label: "▼ afbouwend", cls: "badge-down" },
      };
      const t = tMap[insight.trajectory];
      if (t) metaBadges.push(el("span", { class: "badge " + t.cls }, t.label));
    }
    if (insight.isNew) {
      metaBadges.push(el("span", { class: "badge badge-new" }, "✦ Nieuw vandaag"));
    } else if (insight.daysActive && insight.daysActive > 1) {
      metaBadges.push(el("span", { class: "badge badge-streak" },
        "↻ " + insight.daysActive + " dagen actief"));
    }
    const metaRow = metaBadges.length
      ? el("div", { class: "insight-meta-badges" }, metaBadges)
      : null;

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
    return el("div", { class: cls }, [header, metaRow, summary, why, srcsRow, articlesEl]);
  }

  function renderWeeklyInsight(insight) {
    const momentumBadge = insight.momentum
      ? el("span", { class: "badge badge-momentum" }, insight.momentum)
      : null;
    const header = el("div", { class: "insight-header" }, [
      el("h3", { class: "insight-trend" }, insight.trend || ""),
      momentumBadge,
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

  function renderMonthlyInsight(insight) {
    const horizonBadge = insight.horizon
      ? el("span", { class: "badge badge-horizon" }, "↗ " + insight.horizon)
      : null;
    const header = el("div", { class: "insight-header" }, [
      el("h3", { class: "insight-trend" }, insight.trend || ""),
      horizonBadge,
    ]);
    const summary = insight.summary
      ? el("p", { class: "insight-summary" }, insight.summary)
      : null;
    const why = insight.why_it_matters
      ? el("p", { class: "insight-why" }, [
          el("strong", null, "Strategische impact: "),
          insight.why_it_matters,
        ])
      : null;
    return el("div", { class: "insight" }, [header, summary, why]);
  }

  function renderCategorySection(cat, mode) {
    // mode: "daily" | "weekly" | "monthly"
    const header = el("div", { class: "category-header" }, [
      el("h2", { class: "category-title" }, cat.label || cat.id),
    ]);
    const insightsEl = el("div", { class: "insights" });
    (cat.insights || []).forEach(function (ins) {
      if (mode === "monthly")     insightsEl.appendChild(renderMonthlyInsight(ins));
      else if (mode === "weekly") insightsEl.appendChild(renderWeeklyInsight(ins));
      else                        insightsEl.appendChild(renderInsight(ins));
    });
    return el("section", { class: "category" }, [header, insightsEl]);
  }

  function renderAiLayer(data, $container, mode) {
    // mode: "daily" | "weekly" | "monthly"
    // Note: the caller (renderCurrentTab) is responsible for clearing the layer,
    // so sections rendered before this one (Culture Radar, report insights) survive.
    const cats     = Array.isArray(data.categories) ? data.categories : [];
    const filterVal = $catFilter ? $catFilter.value : "";
    const filtered  = filterVal ? cats.filter(function (c) { return c.id === filterVal; }) : cats;

    if (filtered.length === 0) {
      $container.appendChild(el("p", { class: "empty" }, "Geen data beschikbaar voor deze periode."));
      return;
    }
    filtered.forEach(function (cat) {
      $container.appendChild(renderCategorySection(cat, mode || "daily"));
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
    if ($tabDaily)  $tabDaily.classList.toggle("active",  tab === "daily");
    if ($tabWeek)   $tabWeek.classList.toggle("active",   tab === "weekly");
    if ($tabMonth)  $tabMonth.classList.toggle("active",  tab === "monthly");
    if ($layerDaily) $layerDaily.classList.toggle("hidden", tab !== "daily");
    if ($layerWeek)  $layerWeek.classList.toggle("hidden",  tab !== "weekly");
    if ($layerMonth) $layerMonth.classList.toggle("hidden", tab !== "monthly");
    renderCurrentTab();
  }

  function renderCurrentTab() {
    if (!brief) return;

    if (curTab === "daily" && $layerDaily) {
      $layerDaily.innerHTML = "";
      const daily = brief.daily || {};
      // Cross-category mega-trends first (if present).
      if (brief.crossCategory && Array.isArray(brief.crossCategory.megaTrends) &&
          brief.crossCategory.megaTrends.length > 0) {
        renderCrossCategory(brief.crossCategory, $layerDaily);
      }
      // Macro-trends from the curated trend reports (collapsed by default).
      if (brief.reportInsights) renderReportInsights(brief.reportInsights, $layerDaily);
      if (Array.isArray(daily.categories)) renderAiLayer(daily, $layerDaily, "daily");
      else renderRawLayer(daily, $layerDaily);
    }

    if (curTab === "weekly" && $layerWeek && brief.weekly) {
      $layerWeek.innerHTML = "";
      renderAiLayer(brief.weekly, $layerWeek, "weekly");
    }

    if (curTab === "monthly" && $layerMonth && brief.monthly) {
      $layerMonth.innerHTML = "";
      if (Array.isArray(brief.monthly.categories)) {
        renderAiLayer(brief.monthly, $layerMonth, "monthly");
      } else {
        $layerMonth.appendChild(el("p", { class: "empty" },
          "Maandoverzicht wordt gegenereerd zodra er genoeg weekdata is (7+ dagen archief)."));
      }
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
      $intro.appendChild(el("h2", null, "Zeitfeed Weekly"));
      if (daily.intro) $intro.appendChild(el("p", null, daily.intro));
    }
    if ($briefDate && brief && brief.date) {
      $briefDate.textContent = formatDate(brief.date);
    }
  }

  function updateTabVisibility() {
    const hasWeekly  = brief && brief.weekly  && Array.isArray(brief.weekly.categories);
    const hasMonthly = brief && brief.monthly && Array.isArray(brief.monthly.categories);
    if ($tabWeek)  $tabWeek.classList.toggle("hidden",  !hasWeekly);
    if ($tabMonth) $tabMonth.classList.toggle("hidden", !hasMonthly);
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
        $intro.appendChild(el("h2", null, "Zeitfeed Weekly"));
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

  if ($tabDaily)  $tabDaily.addEventListener("click",  function () { showTab("daily"); });
  if ($tabWeek)   $tabWeek.addEventListener("click",   function () { showTab("weekly"); });
  if ($tabMonth)  $tabMonth.addEventListener("click",  function () { showTab("monthly"); });
  if ($catFilter) $catFilter.addEventListener("change", renderCurrentTab);
  if ($resetBtn)  $resetBtn.addEventListener("click", function () {
    if ($catFilter) $catFilter.value = "";
    renderCurrentTab();
  });

  // ── Boot ──────────────────────────────────────────────────────────────────
  loadLatest();
  loadArchive();

})();
