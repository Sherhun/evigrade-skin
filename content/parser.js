/**
 * Content script: finds ingredients on product pages, calls API,
 * injects inline highlights + floating panel directly on the page.
 *
 * No popup click needed – everything happens automatically.
 *
 * Features:
 * - Traffic light highlighting
 * - Personal blacklist (allergens, comedogenic, avoid)
 * - "Add to comparison" button
 */

(() => {
  // Единый источник правды – api-contract.js (грузится перед parser.js
  // через manifest content_scripts). Меняем там, читаем здесь.
  const SITE_URL = globalThis.evgContract?.SITE_URL || "https://evigrade.vercel.app";
  const API_URL = `${SITE_URL}/api/ingredients/match`;
  // Pause before the one retry of a match request that failed on the network.
  const MATCH_RETRY_DELAY_MS = 3000;
  const BLACKLIST_KEY = "evigrade_blacklist";
  const COMPARE_KEY = "evigrade_compare";

  const host = location.hostname;

  // Telemetry helper — proxied via the background service worker so
  // opt-out / sessionId / tier / throttling all live in one place.
  function track(type, data) {
    try {
      chrome.runtime.sendMessage({ action: "track", type, data });
    } catch {}
  }

  // Map a marketplace hostname to a contract-allowed store slug.
  // Kept here (not in api-contract.js) because it's only used for telemetry
  // and the parser already has the matchers per-store baked in elsewhere.
  function resolveStoreSlug(h) {
    if (!h) return null;
    if (h.includes("wildberries")) return "wildberries";
    if (h.includes("ozon")) return "ozon";
    if (h.includes("iherb")) return "iherb";
    if (h.includes("goldapple")) return "goldapple";
    if (h.includes("sephora")) return "sephora";
    if (h.includes("ulta.com")) return "ulta";
    if (h.includes("boots.com")) return "boots";
    if (h.includes("lookfantastic.com")) return "lookfantastic";
    if (h.includes("cultbeauty.")) return "cultbeauty";
    if (h.includes("beautybay.com")) return "beautybay";
    if (h.includes("notino.")) return "notino";
    if (h.includes("douglas.")) return "douglas";
    if (h.includes("dm.de") || h.includes("dm.at")) return "dm";
    if (h.includes("rossmann.")) return "rossmann";
    if (h.includes("druni.es")) return "druni";
    if (h.includes("primor.eu")) return "primor";
    if (h.includes("maquillalia.com")) return "maquillalia";
    if (h.includes("elcorteingles.es")) return "elcorteingles";
    return null;
  }

  let analyzed = false;
  // Last analyzed text fingerprint. Lets us detect "same product, just re-rendered"
  // vs "navigated to a new product" without trusting ingredient count, which broke
  // when the new product had fewer ingredients than the previous one.
  let lastAnalyzedKey = "";
  // Timestamp of the last detected URL change. Used to suppress stray
  // tryAnalyze() calls fired by mutation/click handlers while the SPA is still
  // hydrating the new product page – otherwise we capture the previous product's
  // DOM and stick on it.
  let urlChangedAt = 0;
  const LOG = (..._args) => {};

  // Auth/tier state for the content script. Popup.js has its own copy, so we
  // keep a local default here that's read by Pro-gated UI bits (currently the
  // concentration estimate badge in renderRow). Without this declaration any
  // call to `auth.tier` would ReferenceError and the entire injectPanel
  // template literal would throw — taking the panel with it.
  // tier is FREE by default; we asynchronously upgrade it from storage if the
  // popup has cached the user's tier there.
  const auth = { tier: "FREE", signedIn: false };
  try {
    chrome.storage?.local?.get?.("evg_tier_cache", (data) => {
      const cached = data?.evg_tier_cache;
      if (cached === "PRO" || cached === "PROFI") auth.tier = cached;
    });
  } catch {}

  // Locale: stored preference wins; otherwise page lang, then host map.
  // initAsync runs in the background and reapplies if user has a saved pick.
  if (typeof globalThis.evgI18n === "object") {
    globalThis.evgI18n.init({
      host,
      docLang: document.documentElement?.lang || "",
    });
    (async () => {
      try {
        const next = await globalThis.evgI18n.initAsync({
          host,
          docLang: document.documentElement?.lang || "",
        });
        // If the saved preference changed our locale, re-render the panel.
        if (analyzed && next) {
          refreshPanelLabels();
        }
      } catch {}
    })();
    try {
      globalThis.evgI18n.watchStorage();
      globalThis.evgI18n.onChange(() => {
        if (analyzed) refreshPanelLabels();
      });
    } catch {}
  }
  const t = (key, ...args) => (globalThis.evgI18n ? globalThis.evgI18n.t(key, ...args) : key);

  // Re-fire the analysis to refresh all localized strings in the floating panel
  // and inline highlights when the user changes language mid-session.
  function refreshPanelLabels() {
    try {
      const existing = document.getElementById("evigrade-panel");
      if (existing) existing.remove();
      analyzed = false;
      lastAnalyzedKey = "";
      if (typeof tryAnalyze === "function") tryAnalyze();
    } catch {}
  }

  // Show ingredient names in the page's language: on en/es sites the INCI name
  // (as printed on the package) leads, with the local translation as a subline.
  function primaryName(m) {
    const en = m?.nameEn || "";
    const ru = m?.nameRu || "";
    const es = m?.nameEs || "";
    const loc = globalThis.evgI18n?.locale;
    if (loc === "en") return en || es || ru;
    if (loc === "es") return es || en || ru;
    return ru || en || es;
  }
  function secondaryName(m) {
    const en = m?.nameEn || "";
    const ru = m?.nameRu || "";
    const es = m?.nameEs || "";
    const loc = globalThis.evgI18n?.locale;
    let sec = "";
    if (loc === "en") sec = ru;
    else if (loc === "es") sec = en;
    else sec = en;
    return sec && sec !== primaryName(m) ? sec : "";
  }

  // ============================================================
  // HEALTH FILTERS (pregnancy / lactation)
  // ============================================================
  // chrome.storage.local — health data special category по GDPR Art.9.
  // Cached so we don't await storage inside the highlight loop.

  const HEALTH_FILTERS_KEY = "evgHealthFilters";
  let healthFilters = { pregnancy: false, lactation: false };

  async function loadHealthFilters() {
    try {
      const data = await chrome.storage.local.get(HEALTH_FILTERS_KEY);
      const s = data?.[HEALTH_FILTERS_KEY];
      healthFilters = {
        pregnancy: Boolean(s?.pregnancy),
        lactation: Boolean(s?.lactation),
      };
    } catch {
      healthFilters = { pregnancy: false, lactation: false };
    }
    return healthFilters;
  }

  // Treat an ingredient as "health-flagged" if its pregnancySafety / lactationSafety
  // is AVOID and the corresponding user filter is on. CAUTION is rendered but
  // does not raise to AVOID rank — we don't want to over-trigger.
  function matchHealthRisk(m) {
    const flags = [];
    if (healthFilters.pregnancy && m?.pregnancySafety === "AVOID") flags.push("pregnancy");
    if (healthFilters.lactation && m?.lactationSafety === "AVOID") flags.push("lactation");
    return flags;
  }

  // ============================================================
  // BLACKLIST helpers
  // ============================================================

  async function loadBlacklist() {
    try {
      const data = await chrome.storage.local.get(BLACKLIST_KEY);
      return data[BLACKLIST_KEY] || { allergens: [], comedogenic: [], avoid: [] };
    } catch {
      return { allergens: [], comedogenic: [], avoid: [] };
    }
  }

  function checkBlacklist(ingredientName, blacklist) {
    const lower = ingredientName.toLowerCase().trim();
    const hits = [];
    for (const name of blacklist.allergens) {
      if (
        lower === name.toLowerCase() ||
        lower.includes(name.toLowerCase()) ||
        name.toLowerCase().includes(lower)
      ) {
        hits.push({ type: "allergen", name });
      }
    }
    for (const name of blacklist.comedogenic) {
      if (
        lower === name.toLowerCase() ||
        lower.includes(name.toLowerCase()) ||
        name.toLowerCase().includes(lower)
      ) {
        hits.push({ type: "comedogenic", name });
      }
    }
    for (const name of blacklist.avoid) {
      if (
        lower === name.toLowerCase() ||
        lower.includes(name.toLowerCase()) ||
        name.toLowerCase().includes(lower)
      ) {
        hits.push({ type: "avoid", name });
      }
    }
    return hits;
  }

  function matchesBlacklist(match, blacklist) {
    const namesToCheck = [match.nameRu, match.nameEn, match.query].filter(Boolean);
    const allHits = [];
    for (const name of namesToCheck) {
      const hits = checkBlacklist(name, blacklist);
      for (const h of hits) {
        if (!allHits.some((a) => a.type === h.type && a.name === h.name)) {
          allHits.push(h);
        }
      }
    }
    return allHits;
  }

  // ============================================================
  // COMPARE helpers
  // ============================================================

  async function loadCompareProducts() {
    try {
      const data = await chrome.storage.local.get(COMPARE_KEY);
      const arr = Array.isArray(data[COMPARE_KEY]) ? data[COMPARE_KEY] : [];
      return arr
        .filter((p) => p && typeof p === "object" && /^https?:\/\//i.test(String(p.url || "")))
        .slice(0, 5);
    } catch {
      return [];
    }
  }

  async function addToCompare(product) {
    const products = await loadCompareProducts();
    if (products.length >= 5) {
      LOG("Compare list full (max 5)");
      return false;
    }
    if (products.some((p) => p.url === product.url)) {
      LOG("Product already in compare list");
      return false;
    }
    products.push(product);
    await chrome.storage.local.set({ [COMPARE_KEY]: products.slice(0, 5) });
    // Notify popup
    try {
      chrome.runtime.sendMessage({ action: "compareUpdated" });
    } catch {}
    return true;
  }

  // Extract product name from page
  function getProductName() {
    // Try common selectors
    const selectors = [
      "h1",
      "[class*='product-title']",
      "[class*='product-name']",
      "[data-widget='webProductHeading'] h1",
      ".product-page__title",
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        const text = (el.textContent || "").trim();
        if (text.length > 3 && text.length < 200) return text;
      }
    }
    return (
      document.title
        .replace(/ - .*$/, "")
        .trim()
        .slice(0, 100) || t("noProductName")
    );
  }

  // ============================================================
  // CONCENTRATION ESTIMATION
  // ============================================================

  /**
   * Estimate approximate concentration based on INCI position.
   * INCI rules: above 1%, ingredients are listed in descending concentration.
   * Below 1%, order is arbitrary. We use a decay model.
   */
  // biome-ignore lint/correctness/noUnusedVariables: kept for upcoming concentration display
  function estimateConcentration(position, totalIngredients) {
    // Position is 1-based
    if (position <= 0 || totalIngredients <= 0) return null;

    // Water is typically 60-80% in cosmetics
    if (position === 1) return { min: 30, max: 80, label: "30\u201380%" };

    // For positions 2+, use exponential decay
    // The sum of all concentrations must be ~100% (minus position 1)
    // We estimate remaining 20-70% distributed among rest
    const remaining = 50; // mid estimate for non-water portion
    const _n = totalIngredients - 1;

    // Zipf-like distribution: concentration ~ 1/position
    // Normalize so sum of 1/2 + 1/3 + ... + 1/n = remaining%
    let harmonicSum = 0;
    for (let i = 2; i <= totalIngredients; i++) {
      harmonicSum += 1 / i;
    }

    const raw = (remaining / harmonicSum) * (1 / position);

    // Clamp: INCI rule says below position ~10-15 is likely <1%
    // Common breakpoint: ingredients after position 10-12 in a 30-ingredient product are <1%
    const breakpoint = Math.max(8, Math.floor(totalIngredients * 0.35));

    let min;
    let max;
    if (position <= 3) {
      min = Math.max(3, raw * 0.6);
      max = Math.min(40, raw * 1.6);
    } else if (position <= breakpoint) {
      min = Math.max(0.5, raw * 0.5);
      max = Math.min(15, raw * 1.8);
    } else {
      // Below 1% zone
      min = 0.01;
      max = 1.0;
    }

    min = Math.round(min * 10) / 10;
    max = Math.round(max * 10) / 10;

    if (min >= max) max = min + 0.5;

    let label;
    if (max <= 0.1) label = "<0.1%";
    else if (max <= 1) label = "<1%";
    else if (min < 1) label = `${min}\u2013${max}%`;
    else label = `~${Math.round((min + max) / 2)}%`;

    return { min, max, label };
  }

  // ============================================================
  // PARSERS
  // ============================================================

  function getParser() {
    if (host.includes("wildberries.")) return parseWildberries;
    if (host.includes("ozon.ru") || host.includes("ozon.com")) return parseOzon;
    if (host.includes("iherb.com")) return parseIherb;
    if (host.includes("goldapple.ru")) return parseGoldapple;
    if (/(^|\.)sephora\./.test(host)) return parseSephora;
    if (host.includes("ulta.com")) return parseUlta;
    if (host.includes("boots.com")) return parseBoots;
    if (host.includes("lookfantastic.com")) return parseLookfantastic;
    if (host.includes("cultbeauty.")) return parseCultBeauty;
    if (host.includes("beautybay.com")) return parseBeautyBay;
    if (/(^|\.)notino\./.test(host)) return parseNotino;
    if (/(^|\.)douglas\./.test(host)) return parseDouglas;
    if (host.endsWith("dm.de") || host.endsWith("dm.at") || host.includes("mein.dm."))
      return parseDm;
    if (/(^|\.)rossmann\./.test(host)) return parseRossmann;
    if (host.includes("druni.es")) return parseDruni;
    if (/(^|\.)primor\.(eu|es|pt)$/.test(host)) return parsePrimor;
    if (host.includes("maquillalia.com")) return parseMaquillalia;
    if (host.includes("elcorteingles.es")) return parseElCorteIngles;
    return null;
  }

  // Common ingredient-section heading texts across languages used by EU
  // beauty retailers (Notino, Douglas, dm, Rossmann, Sephora.fr/.de/.es etc.).
  // Latin-INCI is the same in every locale, only the section label differs.
  const EU_INGREDIENT_HEADINGS = [
    // English
    "ingredients",
    "ingredient list",
    "ingredient list:",
    "full ingredients",
    "full ingredients list",
    "full ingredient list",
    "key ingredients",
    "what's in it",
    "what's inside",
    "view ingredients",
    "inci",
    "inci list",
    // German
    "inhaltsstoffe",
    "inhaltsstoffe (inci)",
    "zutaten",
    "wirkstoffe",
    // French
    "ingrédients",
    "ingredients (inci)",
    "ingrédients (inci)",
    "liste d'ingrédients",
    "liste des ingrédients",
    "composition",
    // Italian
    "ingredienti",
    "lista ingredienti",
    "composizione",
    // Spanish
    "ingredientes",
    "lista de ingredientes",
    "composición",
    // Polish
    "składniki",
    "skład",
    "lista składników",
    // Czech
    "složení",
    "ingredience",
    // Hungarian
    "összetevők",
    "összetétel",
    // Slovak
    "zloženie",
    // Dutch
    "ingrediënten",
    "samenstelling",
    // Portuguese (for Notino .pt if added later)
    "ingredientes",
    "composição",
  ];

  // True for elements that are currently rendered – filters out stale/hidden
  // SPA leftovers from previous routes that linger in the DOM.
  // Walks ancestors and rejects any chain with display:none or visibility:hidden,
  // because tab/accordion systems (Magento, PrestaShop) often render hidden
  // panel content into the DOM while the user is on a different tab. Without
  // this, the panel can appear before the user opens the Ingredients tab.
  function isVisibleEl(el) {
    if (!el || !el.isConnected) return false;
    if (el.offsetParent === null && el.tagName !== "BODY") return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    // Walk ancestors: if any has display:none / visibility:hidden in computed
    // style, treat the whole subtree as hidden. Bounded by BODY so we never
    // walk into the detached fragment world.
    let node = el;
    let steps = 0;
    while (node && node.nodeType === 1 && node.tagName !== "BODY" && steps < 30) {
      const cs = window.getComputedStyle(node);
      if (
        cs.display === "none" ||
        cs.visibility === "hidden" ||
        cs.visibility === "collapse"
      ) {
        return false;
      }
      // Accordion / collapsible patterns that collapse via max-height:0
      // (overflow:hidden required to confirm it's not just animation transit).
      // Opacity is intentionally NOT checked – many sites fade-in content via
      // opacity transitions on the initial render.
      const mh = cs.maxHeight;
      if (mh === "0px" && cs.overflow === "hidden") return false;
      node = node.parentElement;
      steps += 1;
    }
    return true;
  }

  // Skip any DOM element that belongs to our own injected UI (panel, badge,
  // inline highlight spans). Without this, the MutationObserver-driven scan
  // would eventually pick up the panel's textContent — which is full of INCI
  // words ("Глицерин, Ниацинамид, ...") and looks like a legit ingredient
  // block — and lock us onto our own output.
  function isOurInjectedNode(el) {
    let n = el;
    while (n && n.nodeType === 1) {
      const id = n.id || "";
      if (id === "evigrade-panel" || id === "evigrade-panel-host" || id === "evigrade-badge") {
        return true;
      }
      if (n.classList?.contains?.("evg-hl") || n.classList?.contains?.("evg-list")) {
        return true;
      }
      n = n.parentElement;
    }
    return false;
  }

  // Generic helper for sites with a labelled "Ingredients" section. Tries
  // selectors in order, then heading-text search, then scanPage(). Prefers
  // visible elements when multiple matches exist (avoids stale SPA DOM).
  // `headingTexts` lets EU retailers pass localised labels (Inhaltsstoffe,
  // Ingrédients, Składniki, …); defaults to the English set used by US/UK
  // beauty sites.
  function parseByIngredientsHeading(selectors, headingTexts) {
    for (const sel of selectors) {
      const all = Array.from(document.querySelectorAll(sel)).filter((el) => !isOurInjectedNode(el));
      if (all.length === 0) continue;
      // Only consider currently visible candidates. Tabbed/accordion sites
      // (Magento Primor, PrestaShop Maquillalia, Shopify) render hidden tab
      // bodies into the DOM – matching them would surface the panel before
      // the user opens the Ingredients section. If none are visible, fall
      // through to the next selector / heading search instead of silently
      // picking a hidden one.
      const visible = all.filter(isVisibleEl);
      if (visible.length === 0) continue;
      for (const el of visible) {
        const text = (el.textContent || "").trim();
        if (text.length > 20 && text.includes(",") && looksLikeInci(text)) {
          return { text, element: el };
        }
      }
    }

    const headingTags =
      "h1, h2, h3, h4, h5, h6, button, span, div, dt, th, label, summary, strong, b, p";
    const headings = document.querySelectorAll(headingTags);
    const labels = new Set(
      (Array.isArray(headingTexts) && headingTexts.length > 0
        ? headingTexts
        : [
            "ingredients",
            "ingredient list",
            "full ingredients",
            "full ingredients list",
            "key ingredients",
            "what's in it",
            "what's inside",
            "full ingredient list",
            "view ingredients",
          ]
      ).map((s) => String(s).toLowerCase().trim()),
    );
    for (const h of headings) {
      if (h.children.length > 3) continue;
      const raw = (h.textContent || "").trim().toLowerCase();
      // Strip trailing colons / dots so "Inhaltsstoffe:" still matches.
      const t = raw.replace(/[\s:：.]+$/, "");
      if (!labels.has(t) && !labels.has(raw)) continue;
      // Skip headings that live inside a hidden tab/accordion. Without this,
      // a Magento collapsible with the "Ingredientes" label inside its
      // collapsed panel would still match and the panel would appear before
      // the user opens that tab.
      if (!isVisibleEl(h)) continue;

      // Accordion buttons reference their panel via aria-controls; some sites
      // wire the relationship the other way around (panel -> heading via
      // aria-labelledby). Walk both before falling back to DOM siblings.
      const ariaTargets = [];
      const ariaControls = h.getAttribute?.("aria-controls");
      if (ariaControls) {
        for (const id of ariaControls.split(/\s+/)) {
          const el = id && document.getElementById(id);
          if (el) ariaTargets.push(el);
        }
      }
      if (h.id) {
        for (const el of document.querySelectorAll(`[aria-labelledby~='${h.id}']`)) {
          ariaTargets.push(el);
        }
      }

      const candidates = [
        ...ariaTargets,
        h.nextElementSibling,
        h.parentElement?.nextElementSibling,
        h.closest("dl")?.querySelector("dd"),
        h.closest("section")?.querySelector("p, div"),
        h.closest("[role='tabpanel']"),
        h.closest("details")?.querySelector("p, div"),
        h.closest("[role='region']"),
      ];
      for (const c of candidates) {
        if (!c) continue;
        const val = (c.textContent || "").trim();
        if (
          val.length > 20 &&
          val.length < 8000 &&
          (val.includes(",") || val.includes(";")) &&
          looksLikeInci(val)
        ) {
          return { text: val, element: c };
        }
      }

      const parent = h.parentElement;
      if (parent) {
        let seen = false;
        for (const child of parent.children) {
          if (child === h) {
            seen = true;
            continue;
          }
          if (!seen) continue;
          const val = (child.textContent || "").trim();
          if (
            val.length > 20 &&
            val.length < 8000 &&
            (val.includes(",") || val.includes(";")) &&
            looksLikeInci(val)
          ) {
            return { text: val, element: child };
          }
        }
      }

      // Last resort: look at all descendants of the heading's containing
      // section/details for an INCI-looking paragraph. Modern sites bury
      // ingredients several levels deep inside accordion content.
      const container = h.closest("section, details, [role='region'], [role='tabpanel']");
      if (container) {
        let best = null;
        let bestScore = 0;
        for (const node of container.querySelectorAll("p, div, span, dd, li")) {
          const val = (node.textContent || "").trim();
          if (val.length < 50 || val.length > 8000) continue;
          if (!val.includes(",") && !val.includes(";")) continue;
          if (!looksLikeInci(val)) continue;
          const score = (val.match(/[,;]/g) || []).length;
          if (score > bestScore) {
            bestScore = score;
            best = node;
          }
        }
        if (best) return { text: (best.textContent || "").trim(), element: best };
      }
    }

    return scanPage();
  }

  function parseSephora() {
    return parseByIngredientsHeading(
      [
        "[data-at='ingredients']",
        "[data-at='ingredient_list']",
        "[data-at='ingredient_list_legacy']",
        "[data-at*='ingredients' i]",
        "[data-comp*='Ingredients' i]",
        "[data-comp*='IngredientList' i]",
        "#ingredients",
        "[id*='ingredients' i]",
        "[id*='ingredienti' i]",
        "[id*='ingredientes' i]",
        "[id*='ingredients' i]",
        "[id*='inhaltsstoffe' i]",
        "[id*='ingredients-inci' i]",
        "[class*='Ingredients' i]",
        "[class*='Ingredienti' i]",
        "[class*='Ingredientes' i]",
        "[class*='Inhaltsstoffe' i]",
        "[class*='Ingredients' i]",
        "section[aria-label*='ingredients' i]",
        "section[aria-label*='ingrédients' i]",
        "section[aria-label*='inhaltsstoffe' i]",
        "section[aria-label*='ingredienti' i]",
        "section[aria-label*='ingredientes' i]",
        "section[aria-label*='składniki' i]",
        "div[aria-label*='ingredients' i]",
        "div[aria-label*='ingrédients' i]",
        "div[aria-label*='inhaltsstoffe' i]",
      ],
      EU_INGREDIENT_HEADINGS,
    );
  }

  // Notino (CZ-based, 20+ EU locales). PDP renders the ingredient block
  // inside a "INCI / Složení / Inhaltsstoffe / Ingrédients / …" accordion.
  // Selectors target the data-testid hooks that are stable across locales,
  // plus a few legacy class fallbacks.
  function parseNotino() {
    return parseByIngredientsHeading(
      [
        "[data-testid='product-detail-ingredients']",
        "[data-testid*='ingredients' i]",
        "[data-testid*='ingredience' i]",
        "[data-testid*='inci' i]",
        "[data-testid*='inhaltsstoffe' i]",
        "[data-testid*='slozeni' i]",
        "[data-testid*='skladniki' i]",
        "[id*='ingredients' i]",
        "[id*='inci' i]",
        "[class*='IngredientList' i]",
        "[class*='Ingredients_' i]",
        "[class*='ProductIngredients' i]",
        "[class*='product-ingredients' i]",
        "section[aria-label*='ingredients' i]",
        "section[aria-label*='inci' i]",
        "section[aria-label*='složení' i]",
        "section[aria-label*='inhaltsstoffe' i]",
      ],
      EU_INGREDIENT_HEADINGS,
    );
  }

  // Douglas (DE-based, 22 EU markets). PDP groups info into accordion
  // panels labelled "Inhaltsstoffe / Ingredients / Ingredienti / …".
  function parseDouglas() {
    return parseByIngredientsHeading(
      [
        "[data-testid*='ingredients' i]",
        "[data-testid*='inhaltsstoffe' i]",
        "[data-testid*='inci' i]",
        "[data-test-id*='ingredients' i]",
        "[data-test-id*='inhaltsstoffe' i]",
        "[id*='ingredients' i]",
        "[id*='inhaltsstoffe' i]",
        "[id*='inci' i]",
        "[class*='Ingredients' i]",
        "[class*='Inhaltsstoffe' i]",
        "[class*='IngredientList' i]",
        "section[aria-label*='ingredients' i]",
        "section[aria-label*='inhaltsstoffe' i]",
        "section[aria-label*='ingredienti' i]",
        "section[aria-label*='ingredientes' i]",
        "div[aria-label*='ingredients' i]",
        "div[aria-label*='inhaltsstoffe' i]",
      ],
      EU_INGREDIENT_HEADINGS,
    );
  }

  // dm.de / dm.at – drogerie chain. PDP shows "Inhaltsstoffe" inside the
  // accordion under a button with role="tab" or as an .ingredients block.
  function parseDm() {
    return parseByIngredientsHeading(
      [
        "[data-dmid='ingredients']",
        "[data-dmid*='ingredients' i]",
        "[data-dmid*='inhaltsstoffe' i]",
        "[data-test*='ingredients' i]",
        "[data-test*='inhaltsstoffe' i]",
        "#ingredients",
        "#inhaltsstoffe",
        "[id*='ingredients' i]",
        "[id*='inhaltsstoffe' i]",
        "[class*='ingredients' i]",
        "[class*='Inhaltsstoffe' i]",
        "[class*='ProductIngredients' i]",
        "[class*='IngredientList' i]",
      ],
      EU_INGREDIENT_HEADINGS,
    );
  }

  // Rossmann.de / Rossmann.pl – drogerie chain. Ingredients live inside the
  // "Inhaltsstoffe / Składniki" accordion below the description.
  function parseRossmann() {
    return parseByIngredientsHeading(
      [
        "[data-testid*='ingredients' i]",
        "[data-testid*='inhaltsstoffe' i]",
        "[data-testid*='skladniki' i]",
        "[id*='ingredients' i]",
        "[id*='inhaltsstoffe' i]",
        "[id*='skladniki' i]",
        "[class*='ingredients' i]",
        "[class*='Inhaltsstoffe' i]",
        "[class*='Skladniki' i]",
        "[class*='ProductIngredients' i]",
      ],
      EU_INGREDIENT_HEADINGS,
    );
  }

  // Druni.es – nacional español, Magento storefront. La sección INCI vive en
  // el bloque "Ingredientes" / "Composición" dentro de los tabs (.m-tab-content)
  // o de los acordeones (data-role="collapsible") en la ficha de producto.
  function parseDruni() {
    return parseByIngredientsHeading(
      [
        "[data-role='collapsible']",
        ".m-tab-content",
        ".o-tabs",
        "[id*='ingredient' i]",
        "[id*='ingrediente' i]",
        "[id*='inci' i]",
        "[id*='composic' i]",
        "[class*='ingredient' i]",
        "[class*='ingrediente' i]",
        "[class*='inci' i]",
        "[class*='composic' i]",
        ".product.attribute.description",
        ".product-info-main",
      ],
      EU_INGREDIENT_HEADINGS,
    );
  }

  // Primor (.eu/.es/.pt) – cadena nacional iberica, storefront sobre Magento /
  // Adobe Commerce. INCI vive en el acordeon "Composicion" / "Ingredientes"
  // de la ficha de producto, con selectores similares a Druni.
  // Selectores best-effort: pendiente validacion con DOM real (anti-bot bloquea
  // Playwright headless). Si falla – revisar con el arbol vivo.
  function parsePrimor() {
    return parseByIngredientsHeading(
      [
        "[data-role='collapsible']",
        ".m-tab-content",
        ".o-tabs",
        "[id*='ingredient' i]",
        "[id*='ingrediente' i]",
        "[id*='composic' i]",
        "[id*='inci' i]",
        "[class*='ingredient' i]",
        "[class*='ingrediente' i]",
        "[class*='composic' i]",
        "[class*='inci' i]",
        "[class*='product-attribute' i]",
        ".product.attribute.description",
        ".product-info-main",
        ".pdp-description",
        ".product-detail__content",
      ],
      EU_INGREDIENT_HEADINGS,
    );
  }

  // Maquillalia – tienda independiente espanola sobre framework propio
  // (NO es PrestaShop estandar). DOM verificado via Wayback Machine 22.05
  // sobre dos productos (Clara Cervera, Numbuzin):
  //   <span class="product-sheet__tab-title" data-tabid="3">Ingredientes</span>
  //   <div class="product-sheet__tab-content" data-tabid="3">
  //     <p>Aqua, Propanediol, Glycerin, ...</p>
  //   </div>
  // El tab 3 es Ingredientes en todas las fichas inspeccionadas. La gating
  // por visibilidad (isVisibleEl) hace que la plashka aparezca solo cuando
  // el usuario abre el tab.
  function parseMaquillalia() {
    return parseByIngredientsHeading(
      [
        ".product-sheet__tab-content[data-tabid='3']",
        ".product-sheet__tab-content",
        ".product-sheet__tab-contents",
        "[data-tabid='3']",
        "#product-description",
        ".product-description",
        "[id*='ingredient' i]",
        "[id*='ingrediente' i]",
        "[id*='composic' i]",
        "[class*='ingredient' i]",
        "[class*='ingrediente' i]",
        "[class*='composic' i]",
      ],
      EU_INGREDIENT_HEADINGS,
    );
  }

  // El Corte Ingles (elcorteingles.es) – multimarca, SPA propia. La ficha de
  // perfumeria suele incluir un bloque "Ingredientes" o "Composicion" en la
  // descripcion extendida o en una pestana separada.
  // Pendiente validacion con DOM real (403 anti-bot en test headless).
  function parseElCorteIngles() {
    return parseByIngredientsHeading(
      [
        "[data-testid*='ingredient' i]",
        "[data-testid*='composic' i]",
        "[data-test*='ingredient' i]",
        "[id*='ingredient' i]",
        "[id*='ingrediente' i]",
        "[id*='composic' i]",
        "[id*='inci' i]",
        "[class*='ingredient' i]",
        "[class*='ingrediente' i]",
        "[class*='composic' i]",
        "[class*='inci' i]",
        "[class*='pdp-ingredients' i]",
        "[class*='ProductIngredients' i]",
        ".product-description-list",
        ".product-detail__description",
        "[data-role='accordion']",
      ],
      EU_INGREDIENT_HEADINGS,
    );
  }

  function parseUlta() {
    // Ulta's PDP uses the pal-c-Accordion component: the "Ingredients" header
    // and the body section are siblings inside .pal-c-Accordion, so neither
    // aria-controls nor closest('section') from the heading reaches the body.
    // Walk the accordion explicitly first.
    for (const acc of document.querySelectorAll(".pal-c-Accordion")) {
      const btn = acc.querySelector(".pal-c-Accordion__button");
      const label = (
        btn?.getAttribute("aria-label") ||
        acc.querySelector(".pal-c-Accordion__content--text")?.textContent ||
        ""
      )
        .trim()
        .toLowerCase();
      if (!label.includes("ingredient")) continue;
      const body = acc.querySelector(".pal-c-Accordion__body--inner, .pal-c-Accordion__body");
      const text = (body?.textContent || "").trim();
      if (text.length > 20 && text.includes(",") && looksLikeInci(text)) {
        return { text, element: body };
      }
    }
    return parseByIngredientsHeading([
      "[data-test='ingredients']",
      "[data-test*='ingredients' i]",
      "[id^='ProductInformation_Ingredients' i]",
      "[id^='Ingredients' i]",
      "#Ingredients",
      "#ingredients",
      "[aria-labelledby*='ingredients' i]",
      "[class*='ProductIngredients' i]",
      "[class*='Ingredients_' i]",
      "[class*='ingredient-list' i]",
      ".ProductDetail__ingredients",
      ".pal-c-Accordion__body--inner [data-test='markdown']",
      ".pal-c-Accordion__body [data-test='markdown']",
    ]);
  }

  function parseBoots() {
    return parseByIngredientsHeading([
      "[data-test='ingredients']",
      "[data-test*='ingredients' i]",
      "[data-testid*='ingredients' i]",
      "#ingredients",
      "#product-ingredients",
      "[class*='product__ingredients' i]",
      "[class*='ProductIngredients' i]",
      "[class*='product-ingredients' i]",
      "section[aria-label*='ingredients' i]",
      "div[aria-label*='ingredients' i]",
    ]);
  }

  function parseLookfantastic() {
    return parseByIngredientsHeading([
      "[aria-labelledby='ingredients']",
      "[data-component='productDescription'] [id*='ingredients' i]",
      ".productDescription_synopsisContent",
      "[class*='productDescription_synopsisContent']",
      "[id*='ingredients' i]",
      "[data-element='ingredients']",
    ]);
  }

  function parseCultBeauty() {
    return parseByIngredientsHeading([
      ".productDescription_synopsisContent",
      "[class*='productDescription_synopsisContent']",
      "[data-component='productDescription'] [id*='ingredients' i]",
      "[id*='Ingredients']",
      "[data-element='ingredients']",
    ]);
  }

  function parseBeautyBay() {
    return parseByIngredientsHeading([
      "[data-test*='ingredients' i]",
      "[data-testid*='ingredients' i]",
      "#ingredients",
      "[id*='ingredients' i]",
      "[class*='ingredients' i]",
    ]);
  }

  function parseWildberries() {
    LOG("parseWildberries called, DOM elements:", document.querySelectorAll("*").length);

    const wbDescs = document.querySelectorAll(
      ".mo-typography_variant_desc, [class*='variant_desc']",
    );
    let bestWb = null;
    let bestWbSeps = 0;
    for (const el of wbDescs) {
      const text = (el.textContent || "").trim();
      if (text.length < 20) continue;
      if (!looksLikeInci(text)) continue;
      const seps = (text.match(/[,;]/g) || []).length + (text.match(/\.\s*[A-Za-z]/g) || []).length;
      if (seps > bestWbSeps) {
        bestWbSeps = seps;
        bestWb = { text, element: el };
      }
    }
    if (bestWb) {
      LOG("Found via WB class:", bestWb.text.slice(0, 80));
      return bestWb;
    }

    const allEls = document.querySelectorAll("*");
    for (const cell of allEls) {
      if (cell.children.length > 3) continue;
      const text = (cell.textContent || "").trim();
      if (!/^состав$/i.test(text)) continue;

      const parent = cell.parentElement;
      if (parent) {
        for (const sibling of parent.children) {
          if (sibling === cell) continue;
          const val = (sibling.textContent || "").trim();
          if (val.length > 10 && val.includes(",")) {
            return { text: val, element: sibling };
          }
        }
        const parentNext = parent.nextElementSibling;
        if (parentNext) {
          const val = (parentNext.textContent || "").trim();
          if (val.length > 10 && val.includes(",")) {
            return { text: val, element: parentNext };
          }
        }
        const grandparent = parent.parentElement;
        if (grandparent) {
          for (const uncle of grandparent.children) {
            if (uncle === parent) continue;
            const val = (uncle.textContent || "").trim();
            if (val.length > 10 && val.includes(",") && val.length < 3000) {
              return { text: val, element: uncle };
            }
          }
        }
      }

      const next = cell.nextElementSibling;
      if (next) {
        const val = (next.textContent || "").trim();
        if (val.length > 10 && val.includes(",")) {
          return { text: val, element: next };
        }
      }
    }

    for (const el of allEls) {
      if (el.children.length > 5) continue;
      const text = (el.textContent || "").trim();
      const match = text.match(/состав\s*[:：]\s*(.{20,})/i);
      if (match?.[1].includes(",")) {
        return { text: match[1], element: el };
      }
    }

    return scanPage();
  }

  function parseOzon() {
    const allElements = document.querySelectorAll(
      "h2, h3, h4, h5, dt, th, span, div, p, b, strong, label",
    );
    for (const el of allElements) {
      const text = (el.textContent || "").trim().toLowerCase();
      if (text !== "состав" && text !== "ingredients" && text !== "ингредиенты") continue;

      const candidates = [
        el.nextElementSibling,
        el.parentElement?.nextElementSibling,
        el.closest("dl")?.querySelector("dd"),
      ];
      for (const c of candidates) {
        if (!c) continue;
        const val = (c.textContent || "").trim();
        if (val.length > 10 && (val.includes(",") || val.includes(";"))) {
          return { text: val, element: c };
        }
      }

      const parent = el.parentElement;
      if (parent) {
        let seen = false;
        for (const child of parent.children) {
          if (child === el) {
            seen = true;
            continue;
          }
          if (!seen) continue;
          const val = (child.textContent || "").trim();
          if (val.length > 10 && (val.includes(",") || val.includes(";"))) {
            return { text: val, element: child };
          }
        }
        const parentText = (parent.textContent || "").trim();
        const labelText = (el.textContent || "").trim();
        if (parentText.startsWith(labelText)) {
          const after = parentText.slice(labelText.length).trim();
          if (after.length > 10 && (after.includes(",") || after.includes(";"))) {
            return { text: after, element: parent };
          }
        }
      }
    }
    return scanPage();
  }

  function parseIherb() {
    return parseByIngredientsHeading([
      "#product-ingredient-information",
      ".prodOverviewIngred",
      "[id*='ingredient' i]",
      "[class*='ingredient' i]",
      "[data-testid*='ingredient' i]",
    ]);
  }

  function parseGoldapple() {
    const gaBlocks = document.querySelectorAll("[class*='ga-pdp-wysiwyg'], [class*='wysiwyg']");
    let bestGa = null;
    let bestGaSeps = 0;
    for (const el of gaBlocks) {
      const text = (el.textContent || "").trim();
      if (text.length < 20) continue;
      const seps = (text.match(/[,;]/g) || []).length;
      if (seps >= 5 && looksLikeInci(text) && seps > bestGaSeps) {
        bestGaSeps = seps;
        bestGa = { text, element: el };
      }
    }
    if (bestGa) {
      LOG("Found via GA class:", bestGa.text.slice(0, 80));
      return bestGa;
    }

    const headings = document.querySelectorAll("h2, h3, h4, span, div, button");
    for (const h of headings) {
      if (/^состав$/i.test((h.textContent || "").trim())) {
        const parent = h.parentElement;
        if (parent) {
          for (const sibling of parent.querySelectorAll("div, p, span")) {
            const val = (sibling.textContent || "").trim();
            if (val.length > 20 && (val.includes(",") || val.includes(";")) && looksLikeInci(val)) {
              return { text: val, element: sibling };
            }
          }
          const next = parent.nextElementSibling;
          if (next) {
            const val = (next.textContent || "").trim();
            if (val.length > 20 && val.includes(",")) {
              return { text: val, element: next };
            }
          }
        }
      }
    }

    return scanPage();
  }

  function scanPage() {
    const allEls = document.querySelectorAll("p, div, td, span, li, dd, section, article");
    let bestMatch = null;
    let bestLen = 0;
    let bestSeparators = 0;

    for (const el of allEls) {
      if (isOurInjectedNode(el)) continue;
      const text = (el.textContent || "").trim();
      if (text.length < 30 || text.length > 8000) continue;
      if (!looksLikeInci(text)) continue;

      const seps = (text.match(/[,;]/g) || []).length;
      if (seps > bestSeparators || (seps === bestSeparators && text.length > bestLen)) {
        bestSeparators = seps;
        bestLen = text.length;
        bestMatch = el;
      }
    }

    if (bestMatch) {
      return { text: (bestMatch.textContent || "").trim(), element: bestMatch };
    }

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    let node = walker.nextNode();
    while (node) {
      const text = (node.textContent || "").trim();
      if (text.length > 30 && looksLikeInci(text)) {
        return { text, element: node.parentElement };
      }
      node = walker.nextNode();
    }

    return null;
  }

  const INCI_MARKERS = [
    // Base / solvents
    "aqua",
    "water",
    "glycerin",
    "glycerine",
    "butylene glycol",
    "propylene glycol",
    "pentylene glycol",
    "hexylene glycol",
    "propanediol",
    "ethoxydiglycol",
    "dipropylene glycol",
    "caprylyl glycol",
    "methyl gluceth",
    "alcohol denat",
    "denatured alcohol",
    "ethanol",
    "isododecane",
    // Emollients / oils / butters
    "dimethicone",
    "dimethiconol",
    "cyclomethicone",
    "cyclopentasiloxane",
    "cyclohexasiloxane",
    "phenyl trimethicone",
    "dimethicone crosspolymer",
    "amodimethicone",
    "trimethylsiloxysilicate",
    "squalane",
    "squalene",
    "caprylic",
    "capric triglyceride",
    "isopropyl myristate",
    "isopropyl palmitate",
    "ethylhexyl palmitate",
    "cetyl alcohol",
    "stearyl alcohol",
    "cetearyl alcohol",
    "behenyl alcohol",
    "octyldodecanol",
    "oleyl alcohol",
    "decyl oleate",
    "diisopropyl sebacate",
    "coco-caprylate",
    "dicaprylyl carbonate",
    "isononyl isononanoate",
    "c12-15 alkyl benzoate",
    "diisopropyl adipate",
    "hydrogenated polydecene",
    "jojoba",
    "simmondsia chinensis",
    "shea butter",
    "butyrospermum parkii",
    "cocoa butter",
    "theobroma cacao",
    "argan",
    "argania spinosa",
    "rosehip",
    "rosa canina",
    "rosa mosqueta",
    "sunflower",
    "helianthus annuus",
    "coconut oil",
    "cocos nucifera",
    "olive",
    "olea europaea",
    "avocado",
    "persea gratissima",
    "sweet almond",
    "prunus amygdalus",
    "grapeseed",
    "vitis vinifera",
    "macadamia",
    "marula",
    "sclerocarya birrea",
    "hemp seed",
    "cannabis sativa",
    "borage",
    "borago officinalis",
    "evening primrose",
    "oenothera biennis",
    "sea buckthorn",
    "hippophae",
    "baobab",
    "adansonia digitata",
    "camellia",
    "rice bran",
    "oryza sativa",
    "meadowfoam",
    "limnanthes alba",
    "crambe abyssinica",
    "mineral oil",
    "paraffinum liquidum",
    "petrolatum",
    "lanolin",
    "beeswax",
    "cera alba",
    "candelilla",
    "carnauba",
    "cetyl esters",
    "myristyl myristate",
    "stearic acid",
    "palmitic acid",
    "oleic acid",
    "linoleic acid",
    "linolenic acid",
    // Emulsifiers / thickeners / polymers
    "cetearyl",
    "stearate",
    "polysorbate",
    "sorbitan",
    "carbomer",
    "xanthan gum",
    "hydroxyethylcellulose",
    "acrylates",
    "peg-",
    "glyceryl stearate",
    "ceteareth",
    "polyglyceryl",
    "sucrose stearate",
    "lecithin",
    "phospholipid",
    "sodium stearoyl glutamate",
    "cellulose gum",
    "guar gum",
    "gellan gum",
    "sclerotium gum",
    "acacia senegal",
    "pullulan",
    "sodium polyacrylate",
    "ammonium acryloyldimethyltaurate",
    "polyacrylamide",
    "hydrogenated castor oil",
    "trihydroxystearin",
    "sodium acrylates copolymer",
    "silica",
    // Actives – retinoids
    "retinol",
    "retinal",
    "retinaldehyde",
    "tretinoin",
    "adapalene",
    "retinyl palmitate",
    "retinyl linoleate",
    "hydroxypinacolone retinoate",
    "granactive retinoid",
    // Actives – vitamin C forms
    "ascorbic acid",
    "ascorbyl glucoside",
    "ascorbyl tetraisopalmitate",
    "sodium ascorbyl phosphate",
    "magnesium ascorbyl phosphate",
    "ascorbyl palmitate",
    "ethyl ascorbic acid",
    "3-o-ethyl ascorbic",
    // Actives – vitamin B / niacin
    "niacinamide",
    "nicotinamide",
    "panthenol",
    "pantothenic",
    "pyridoxine",
    "biotin",
    // Actives – vitamin E
    "tocopherol",
    "tocopheryl acetate",
    "tocopheryl linoleate",
    "tocotrienol",
    // Actives – acids
    "salicylic acid",
    "glycolic acid",
    "lactic acid",
    "mandelic acid",
    "azelaic acid",
    "tranexamic acid",
    "kojic acid",
    "phytic acid",
    "pyruvic acid",
    "tartaric acid",
    "malic acid",
    "citric acid",
    "polyhydroxy acid",
    "gluconolactone",
    "lactobionic acid",
    // Actives – brightening
    "arbutin",
    "alpha-arbutin",
    "deoxyarbutin",
    "glutathione",
    "licorice",
    "glabridin",
    "undecylenoyl phenylalanine",
    "phenylethyl resorcinol",
    "4-butylresorcinol",
    "thiamidol",
    // Actives – peptides
    "peptide",
    "palmitoyl tripeptide",
    "palmitoyl tetrapeptide",
    "palmitoyl pentapeptide",
    "acetyl hexapeptide",
    "acetyl octapeptide",
    "copper tripeptide",
    "matrixyl",
    "argireline",
    "syn-ake",
    "leuphasyl",
    "dipeptide diaminobutyroyl",
    "carnosine",
    "acetyl dipeptide",
    // Actives – hyaluronic acid forms
    "hyaluronic",
    "sodium hyaluronate",
    "hydrolyzed hyaluronic",
    "sodium acetylated hyaluronate",
    "hyaluronate crosspolymer",
    // Actives – ceramides / barrier
    "ceramide",
    "ceramide np",
    "ceramide ap",
    "ceramide eop",
    "ceramide ns",
    "ceramide ng",
    "cholesterol",
    "phytosphingosine",
    "sphingolipid",
    "fatty acid",
    "omega-3",
    "omega-6",
    "omega-9",
    // Actives – anti-aging / repair
    "adenosine",
    "caffeine",
    "centella asiatica",
    "madecassoside",
    "asiaticoside",
    "asiatic acid",
    "madecassic acid",
    "bakuchiol",
    "resveratrol",
    "ferulic acid",
    "ubiquinone",
    "coenzyme q10",
    "idebenone",
    "ectoin",
    "ergothioneine",
    "carnitine",
    "epigallocatechin gallate",
    "egcg",
    "superoxide dismutase",
    "catalase",
    "glutathione peroxidase",
    "astaxanthin",
    "lycopene",
    "lutein",
    "beta-carotene",
    "soy isoflavone",
    "genistein",
    "daidzein",
    // Actives – soothing / anti-inflammatory
    "allantoin",
    "bisabolol",
    "calendula",
    "chamomile",
    "matricaria",
    "azulene",
    "guaiazulene",
    "aloe vera",
    "aloe barbadensis",
    "colloidal oatmeal",
    "avena sativa",
    "licorice root",
    "glycyrrhiza glabra",
    "glycyrrhetinic acid",
    "stearyl glycyrrhetinate",
    "dipotassium glycyrrhizate",
    "beta-glucan",
    "cica",
    "mugwort",
    "artemisia",
    "green tea",
    "camellia sinensis",
    "white tea",
    "turmeric",
    "curcuma longa",
    "curcumin",
    "zinc gluconate",
    "copper gluconate",
    "manganese gluconate",
    // Actives – hydration
    "urea",
    "sodium pca",
    "pyrrolidone carboxylic",
    "trehalose",
    "saccharide isomerate",
    "pentavitin",
    "sorbitol",
    "mannitol",
    "xylitol",
    "erythritol",
    "alginate",
    "fucoidan",
    "chondrus crispus",
    "carrageenan",
    "amino acid",
    "serine",
    "proline",
    "glycine",
    "alanine",
    "arginine",
    "lysine",
    "histidine",
    "threonine",
    "collagen",
    "elastin",
    "keratin",
    "silk amino acids",
    "hydrolyzed collagen",
    "hydrolyzed silk",
    "hydrolyzed wheat protein",
    // Actives – exfoliation enzymes
    "papain",
    "bromelain",
    "subtilisin",
    "lipase",
    "protease",
    // Actives – scalp / hair
    "minoxidil",
    "ketoconazole",
    "piroctone olamine",
    "zinc pyrithione",
    "climbazole",
    "selenium sulfide",
    "salicylic",
    "coal tar",
    "saw palmetto",
    "serenoa repens",
    "biotin",
    "procapil",
    "capixyl",
    "redensyl",
    "baicapil",
    "anagain",
    // Minerals / inorganic
    "zinc oxide",
    "titanium dioxide",
    "kaolin",
    "bentonite",
    "magnesium aluminum silicate",
    "calcium carbonate",
    "sulfur",
    "selenium",
    "zinc",
    "copper",
    "manganese",
    // Preservatives
    "phenoxyethanol",
    "methylparaben",
    "propylparaben",
    "ethylparaben",
    "butylparaben",
    "isobutylparaben",
    "benzyl alcohol",
    "potassium sorbate",
    "sodium benzoate",
    "chlorphenesin",
    "caprylyl glycol",
    "sorbic acid",
    "dmdm hydantoin",
    "imidazolidinyl urea",
    "diazolidinyl urea",
    "methylisothiazolinone",
    "methylchloroisothiazolinone",
    "benzalkonium chloride",
    "triclosan",
    "chlorhexidine",
    "dehydroacetic acid",
    "ethylhexylglycerin",
    "undecylenic acid",
    "sodium hydroxymethylglycinate",
    "p-anisic acid",
    // Fragrance / EU 26 allergens
    "parfum",
    "fragrance",
    "linalool",
    "geraniol",
    "citronellol",
    "limonene",
    "hexyl cinnamal",
    "benzyl salicylate",
    "coumarin",
    "citral",
    "eugenol",
    "isoeugenol",
    "farnesol",
    "benzyl benzoate",
    "benzyl cinnamate",
    "cinnamal",
    "cinnamyl alcohol",
    "amyl cinnamal",
    "amylcinnamyl alcohol",
    "anise alcohol",
    "hydroxycitronellal",
    "hydroxyisohexyl 3-cyclohexene carboxaldehyde",
    "alpha-isomethyl ionone",
    "butylphenyl methylpropional",
    "evernia prunastri",
    "evernia furfuracea",
    "methyl 2-octynoate",
    // Chelators / pH adjusters / buffers
    "disodium edta",
    "tetrasodium edta",
    "trisodium edta",
    "sodium hydroxide",
    "potassium hydroxide",
    "citric acid",
    "triethanolamine",
    "aminomethyl propanol",
    "sodium citrate",
    "sodium phosphate",
    "lactic acid",
    // Sunscreens – organic (chemical)
    "octocrylene",
    "avobenzone",
    "butyl methoxydibenzoylmethane",
    "homosalate",
    "octisalate",
    "ethylhexyl salicylate",
    "ethylhexyl methoxycinnamate",
    "octinoxate",
    "bis-ethylhexyloxyphenol methoxyphenyl triazine",
    "diethylamino hydroxybenzoyl hexyl benzoate",
    "ethylhexyl triazone",
    "drometrizole trisiloxane",
    "methylene bis-benzotriazolyl tetramethylbutylphenol",
    "tinosorb",
    "uvinul",
    "mexoryl",
    "phenylbenzimidazole sulfonic acid",
    "ensulizole",
    "bemotrizinol",
    "bisoctrizole",
    // Sunscreens – inorganic (physical)
    "zinc oxide",
    "titanium dioxide",
    // Colorants / pigments
    "mica",
    "iron oxides",
    "ci 77891",
    "ci 77491",
    "ci 77492",
    "ci 77499",
    "ci 42090",
    "ci 19140",
    "ci 15850",
    "ci 77007",
    "ultramarines",
    "chromium oxide",
    "manganese violet",
    "carmine",
    "ci 75470",
    "tartrazine",
    "fd&c",
    // Misc / functional
    "isopropyl",
    "triethanolamine",
    "aminomethyl propanol",
    "sodium chloride",
    "magnesium sulfate",
    "hydrogenated",
    "hydrolyzed",
    "polyquaternium",
    "quaternium",
    "behentrimonium",
    "cetrimonium",
    "ppg-",
    "pvp",
    "copolymer",
    "crosspolymer",
  ];

  const RU_INCI_MARKERS = [
    // База / растворители
    "глицерин",
    "вода",
    "бутиленгликоль",
    "пропиленгликоль",
    "пентиленгликоль",
    "пропандиол",
    "гексиленгликоль",
    "каприлил гликоль",
    "спирт денатурированный",
    "этанол",
    // Эмоленты / масла / воски
    "диметикон",
    "диметиконол",
    "циклометикон",
    "циклопентасилоксан",
    "циклогексасилоксан",
    "фенилтриметикон",
    "амодиметикон",
    "сквалан",
    "сквален",
    "жожоба",
    "симмондсия",
    "ши",
    "карите",
    "какао",
    "теоброма",
    "аргановое",
    "аргания",
    "кокосовое",
    "кокос",
    "оливковое",
    "олива",
    "миндальное",
    "миндаль",
    "подсолнечное",
    "подсолнечник",
    "авокадо",
    "персея",
    "шиповник",
    "роза москета",
    "виноградное",
    "виноград",
    "макадамия",
    "марула",
    "конопляное",
    "конопля",
    "бораго",
    "огуречник",
    "примула вечерняя",
    "облепиха",
    "баобаб",
    "камелия",
    "рисовое",
    "рис",
    "минеральное масло",
    "парафин",
    "вазелин",
    "ланолин",
    "пчелиный воск",
    "канделильский воск",
    "карнаубский воск",
    "масло",
    "экстракт",
    "изопропил",
    "стеариновая",
    "пальмитиновая",
    "олеиновая",
    "линолевая",
    "линоленовая",
    // Эмульгаторы / загустители / полимеры
    "цетеарил",
    "стеарат",
    "цетил",
    "полисорбат",
    "сорбитан",
    "карбомер",
    "ксантан",
    "гидроксиэтилцеллюлоза",
    "глицерил стеарат",
    "полиглицерил",
    "лецитин",
    "фосфолипид",
    "целлюлозная камедь",
    "гуаровая камедь",
    "геллановая камедь",
    "склеротиум",
    "акация",
    "пуллулан",
    "полиакрилат",
    "силика",
    "кремнезем",
    // Активы – ретиноиды
    "ниацинамид",
    "ретинол",
    "ретиналь",
    "ретинальдегид",
    "третиноин",
    "адапален",
    "ретинил пальмитат",
    "гидроксипинаколон ретиноат",
    "грэнактив ретиноид",
    // Активы – витамин С
    "аскорбиновая",
    "аскорбил глюкозид",
    "аскорбил пальмитат",
    "этил аскорбиновая",
    "витамин с",
    // Активы – витамины B, E, A
    "пантенол",
    "провитамин",
    "пантотеновая",
    "пиридоксин",
    "биотин",
    "токоферол",
    "токотриенол",
    "витамин е",
    "витамин а",
    // Активы – кислоты
    "салициловая",
    "гликолевая",
    "молочная",
    "миндальная",
    "азелаиновая",
    "транексамовая",
    "койевая",
    "фитиновая",
    "пировиноградная",
    "винная",
    "яблочная",
    "полигидроксикислота",
    "глюконолактон",
    "лактобионовая",
    "кислота",
    // Активы – осветление
    "арбутин",
    "альфа-арбутин",
    "глутатион",
    "солодка",
    "глабридин",
    "тиамидол",
    // Активы – пептиды
    "пептид",
    "пальмитоил трипептид",
    "пальмитоил тетрапептид",
    "пальмитоил пентапептид",
    "ацетил гексапептид",
    "медный трипептид",
    "матриксил",
    "аргирелин",
    "карнозин",
    "дипептид",
    // Активы – гиалуроновая
    "гиалуронат",
    "гиалуроновая",
    "гидролизованная гиалуроновая",
    // Активы – церамиды / барьер
    "церамид",
    "холестерол",
    "фитосфингозин",
    "сфинголипид",
    "жирная кислота",
    "омега-3",
    "омега-6",
    "омега-9",
    // Активы – anti-age / восстановление
    "аденозин",
    "кофеин",
    "центелла",
    "мадекассозид",
    "азиатикозид",
    "азиатиковая",
    "бакучиол",
    "ресвератрол",
    "феруловая",
    "убихинон",
    "коэнзим",
    "идебенон",
    "эктоин",
    "эрготионеин",
    "карнитин",
    "эпигаллокатехин",
    "астаксантин",
    "ликопин",
    "лютеин",
    "бета-каротин",
    "генистеин",
    // Активы – успокаивающие
    "аллантоин",
    "бисаболол",
    "календула",
    "ромашка",
    "азулен",
    "гваязулен",
    "алоэ вера",
    "алоэ барбаденсис",
    "овсянка",
    "авена",
    "солодка",
    "глицирризиновая",
    "глицирретиновая",
    "бета-глюкан",
    "сика",
    "полынь",
    "артемизия",
    "зеленый чай",
    "камелия синенсис",
    "белый чай",
    "куркума",
    "куркумин",
    "глюконат цинка",
    "глюконат меди",
    // Активы – увлажнение
    "мочевина",
    "пирролидонкарбоновая",
    "трегалоза",
    "сахаридный изомерат",
    "пентавитин",
    "сорбитол",
    "маннитол",
    "ксилитол",
    "эритритол",
    "альгинат",
    "фукоидан",
    "каррагинан",
    "аминокислота",
    "серин",
    "пролин",
    "глицин",
    "аланин",
    "аргинин",
    "лизин",
    "гистидин",
    "треонин",
    "коллаген",
    "эластин",
    "кератин",
    "шелк",
    "гидролизат коллагена",
    "гидролизат шелка",
    // Активы – ферменты
    "папаин",
    "бромелаин",
    "липаза",
    "протеаза",
    // Активы – для волос / кожи головы
    "миноксидил",
    "кетоконазол",
    "пироктон оламин",
    "пиритион цинка",
    "климбазол",
    "биотин",
    "прокапил",
    "капиксил",
    "реденсил",
    // Минералы / неорганика
    "оксид цинка",
    "диоксид титана",
    "каолин",
    "бентонит",
    "сера",
    "цинк",
    "медь",
    "марганец",
    "селен",
    // Консерванты
    "феноксиэтанол",
    "метилпарабен",
    "пропилпарабен",
    "этилпарабен",
    "бутилпарабен",
    "бензиловый спирт",
    "сорбат калия",
    "бензоат натрия",
    "хлорфенезин",
    "каприлил гликоль",
    "сорбиновая кислота",
    "метилизотиазолинон",
    "метилхлоризотиазолинон",
    "дегидроуксусная кислота",
    "этилгексилглицерин",
    // Отдушки / EU 26 аллергенов
    "отдушка",
    "парфюм",
    "парфюмерная композиция",
    "ароматизатор",
    "линалоол",
    "гераниол",
    "цитронеллол",
    "лимонен",
    "кумарин",
    "цитраль",
    "эвгенол",
    "изоэвгенол",
    "фарнезол",
    "бензилбензоат",
    "бензилциннамат",
    "коричный альдегид",
    "гидроксицитронеллаль",
    "альфа-изометилионон",
    // pH / хелаторы
    "лимонная",
    "трилон",
    "триэтаноламин",
    "гидроксид натрия",
    "гидроксид калия",
    "цитрат натрия",
    "аминометилпропанол",
    // Санскрины
    "октокрилен",
    "авобензон",
    "гомосалат",
    "этилгексил салицилат",
    "этилгексил метоксициннамат",
    "бемотризинол",
    "бисоктризол",
    "тиносорб",
    "дрометризол трисилоксан",
    // Красители / пигменты
    "слюда",
    "оксиды железа",
    "ультрамарин",
    "оксид хрома",
    "кармин",
    "каприл",
    "бетаин",
    // Полимеры
    "поликватерниум",
    "кватерниум",
    "кополимер",
    "кроссполимер",
    "гидрогенизированный",
    "гидролизованный",
  ];

  const MARKETING_BLOCKERS = [
    /₽|руб\.|\$\s?\d|€\s?\d|֏/,
    /-\d+\s?%|−\d+\s?%|−\d+|\s\d{1,3}\s?%/,
    /отзыв[ов]?/i,
    /оценк[аиои]/i,
    /бренд\s*[•·:]|бренд\s+/i,
    /артикул/i,
    /страна\s+производит/i,
    /с\s*wb\s*кошельк/i,
    /доставк[аеуи]/i,
    /гаранти[ийе]/i,
    /купить|в\s+корзин|в\s+наличии/i,
    /похожее\s+от|витрина\s+бренда/i,
    /сыворотка\s+для\s+лица|крем\s+для\s+лица|средство\s+для\s+(кож|ух)/i,
    /регулиру[ею]т|устраня[ею]т|помога[ею]т|способству[ею]т|раствор[яе][ею]т|отшелуш/i,
    /для\s+(жирной|сухой|проблемной|чувствительной|нормальной|комбинированной)\s+кожи/i,
    /тип\s+кожи|маслотип|эффект\s+от\s+использования/i,
    /чёрн[ыоая]\w{0,2}\s+точк|расширенн[ыоая]?\s+пор|высыпан|себум|матиру/i,
    /бьюти[-\s]+ингредиент|оригинальный\s+товар/i,
  ];

  function looksLikeInci(text) {
    const lower = text.toLowerCase();

    for (const pat of MARKETING_BLOCKERS) {
      if (pat.test(text)) return false;
    }

    const commas = (text.match(/,/g) || []).length;
    const semicolons = (text.match(/;/g) || []).length;
    const periodSep = (text.match(/\.\s*[A-Za-zА-Яа-я]/g) || []).length;
    const dashSep = (text.match(/\s[-–]\s/g) || []).length;
    const bulletSep = (text.match(/[•·|]/g) || []).length;
    const separators = commas + semicolons + periodSep + dashSep + bulletSep;
    if (separators < 2) return false;

    let latinHits = 0;
    for (const m of INCI_MARKERS) {
      if (lower.includes(m)) latinHits++;
      if (latinHits >= 3) break;
    }
    let ruHits = 0;
    for (const m of RU_INCI_MARKERS) {
      if (lower.includes(m)) ruHits++;
      if (ruHits >= 3) break;
    }
    const totalHits = latinHits + ruHits;

    if (totalHits >= 2) return true;
    if (totalHits >= 1 && separators >= 5) return true;
    return false;
  }

  const PAREN_COMMA = "\uE000";
  const PAREN_SEMI = "\uE001";
  function maskSeparatorsInParens(s) {
    let depth = 0;
    let out = "";
    for (const ch of s) {
      if (ch === "(") depth++;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      if (depth > 0 && ch === ",") out += PAREN_COMMA;
      else if (depth > 0 && ch === ";") out += PAREN_SEMI;
      else out += ch;
    }
    return out;
  }
  function unmaskSeparators(s) {
    return s.replaceAll(PAREN_COMMA, ",").replaceAll(PAREN_SEMI, ";");
  }

  // Anchors used to reconstruct commas in space-separated INCI lists
  // (LRP Cicaplast on Lookfantastic etc.). Long phrases come first so they
  // win greedily before single-word standalone names get a chance.
  const SPACE_SEP_ANCHORS = [
    // Multi-word phrases (longest first)
    "Pentaerythrityl Tetra-Di-T-Butyl Hydroxyhydrocinnamate",
    "Aluminum Starch Octenylsuccinate",
    "Acetylated Glycol Stearate",
    "Hydrogenated Polyisobutene",
    "Hydrogenated Castor Oil",
    "Butyrospermum Parkii Butter",
    "Persea Gratissima Oil",
    "Helianthus Annuus Seed Oil",
    "Olea Europaea Fruit Oil",
    "Prunus Amygdalus Dulcis Oil",
    "Cetyl Peg/Ppg-1/1 Dimethicone",
    "Polyglyceryl-4 Isostearate",
    "Polyglyceryl-10 Laurate",
    "Polyglyceryl-10 Oleate",
    "Sodium Hyaluronate",
    "Tocopheryl Acetate",
    "Sodium Ascorbyl Phosphate",
    "Tocopheryl Phosphate",
    "Ethylhexyl Salicylate",
    "Ethylhexyl Triazone",
    "Butyl Methoxydibenzoylmethane",
    "Disodium EDTA",
    "Disodium Edta",
    "Magnesium Sulfate",
    "Zinc Gluconate",
    "Manganese Gluconate",
    "Copper Gluconate",
    "Sodium Gluconate",
    "Capryloyl Glycine",
    "Aluminum Hydroxide",
    "Sodium Hydroxide",
    "Potassium Hydroxide",
    "Butylene Glycol",
    "Propylene Glycol",
    "Hexylene Glycol",
    "Pentylene Glycol",
    "Caprylyl Glycol",
    "Dipropylene Glycol",
    "Stearyl Alcohol",
    "Cetyl Alcohol",
    "Cetearyl Alcohol",
    "Behenyl Alcohol",
    "Citric Acid",
    "Stearic Acid",
    "Palmitic Acid",
    "Oleic Acid",
    "Linoleic Acid",
    "Linolenic Acid",
    "Salicylic Acid",
    "Hyaluronic Acid",
    "Lactic Acid",
    "Ascorbic Acid",
    "Ferulic Acid",
    "Asiatic Acid",
    "Madecassic Acid",
    "Mandelic Acid",
    "Glycolic Acid",
    "Azelaic Acid",
    "Benzoic Acid",
    "Citric Acid",
    "Glycyrrhetinic Acid",
    "Polyglutamic Acid",
    "Caprylhydroxamic Acid",
    "Capryloyl Salicylic Acid",
    "Sorbic Acid",
    "Sodium Lauroyl Lactylate",
    "Isodecyl Salicylate",
    "Sodium Citrate",
    "Sodium PCA",
    "Copper PCA",
    "Sodium Phytate",
    "Sodium Lactate",
    "Ceramide NP",
    "Ceramide NS",
    "Ceramide AP",
    "Ceramide AS",
    "Ceramide EOP",
    "Ceramide EOS",
    "Caprylic/Capric Triglyceride",
    "Caprylic/Capric Triglycerides",
    "Isopropyl Palmitate",
    "Cetearyl Olivate",
    "Sorbitan Olivate",
    "Sorbitan Laurate",
    "Sorbitan Sesquioleate",
    "Tridecyl Stearate",
    "Tridecyl Trimellitate",
    "Glyceryl Stearate",
    "Glyceryl Caprylate",
    "Sodium Stearoyl Glutamate",
    // Single-word standalone names that always start a new INCI
    "Aqua",
    "Water",
    "Eau",
    "Glycerin",
    "Glycerine",
    "Dimethicone",
    "Cyclomethicone",
    "Cyclopentasiloxane",
    "Cyclohexasiloxane",
    "Trihydroxystearin",
    "Trimethylsiloxysilicate",
    "Niacinamide",
    "Panthenol",
    "Tocopherol",
    "Tocotrienol",
    "Madecassoside",
    "Asiaticoside",
    "Allantoin",
    "Squalane",
    "Squalene",
    "Silica",
    "Carbomer",
    "Bisabolol",
    "Adenosine",
    "Bakuchiol",
    "Retinol",
    "Retinal",
    "Caffeine",
    "Theobromine",
    "Octocrylene",
    "Avobenzone",
    "Octinoxate",
    "Octisalate",
    "Homosalate",
    "Oxybenzone",
    "Phenoxyethanol",
    "Ethylhexylglycerin",
    "Methylparaben",
    "Butylparaben",
    "Ethylparaben",
    "Propylparaben",
    "Citral",
    "Limonene",
    "Linalool",
    "Geraniol",
    "Coumarin",
    "Eugenol",
    "Citronellol",
    "Xylitol",
    "Anhydroxylitol",
    "Xylitylglucoside",
    "Mannitol",
    "Rhamnose",
    "Cholesterol",
    "Phytosphingosine",
    "Ozokerite",
    "Propanediol",
    "Isohexadecane",
    "Isododecane",
    "Mica",
    "Talc",
    "Pyridoxine",
    "Carnosine",
    "Betaine",
    "Arginine",
    "Glycine",
    "Serine",
    "Alanine",
    "Threonine",
    "Proline",
    "Lysine",
    "Sucrose",
    "Glucose",
    "Trehalose",
    "Fructose",
    "Polysorbate",
  ];
  function preprocessSpaceSeparated(text) {
    const commas = (text.match(/,/g) || []).length;
    // If the block already has reasonable comma density, leave it alone.
    if (commas >= 5) return text;
    if (text.length < 80) return text;

    const wordCount = (text.match(/\b[A-Za-z][a-z]+\b/g) || []).length;
    if (wordCount < 10) return text;
    const titleCaseCount = (text.match(/\b[A-Z][a-z]+\b/g) || []).length;
    if (titleCaseCount / wordCount < 0.55) return text;

    let t = ` ${text} `;
    for (const anchor of SPACE_SEP_ANCHORS) {
      const esc = anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Match anchor surrounded by whitespace/punct. Case-insensitive to handle
      // "Aqua" vs "AQUA" (some sites uppercase the ingredient list).
      const re = new RegExp(`(?<=[\\s,(])${esc}(?=[\\s,.)])`, "gi");
      t = t.replace(re, `, ${anchor},`);
    }
    return t
      .replace(/\s*,(\s*,)+\s*/g, ", ")
      .replace(/^[\s,]+|[\s,]+$/g, "")
      .trim();
  }

  // OCR / soft-hyphen / wbr артефакты, которые встречаются на Goldapple и
  // нескольких iHerb-страницах. HTML-разметка вставляет визуальные переносы
  // внутри длинных INCI-имён, textContent теряет либо часть букв, либо
  // склеивает части с пробелами. Чиним точечно — каждый паттерн подтверждён
  // на реальных скринах (18.05, аудит «Пока нет в базе»).
  const OCR_REPAIRS = [
    // peptide → "pep tide-N" / "pep de-N" / "pep de N"
    [
      /\b((?:mono|di|tri|tetra|penta|hexa|hepta|octa|nona|deca|oligo|poly))pep\s+(?:ti)?de[\s-]+(\d+)\b/gi,
      "$1peptide-$2",
    ],
    // palmitic → "palmi c", "palmi tic"
    [/\bpalmi\s+(?:ti)?c\s+(acid|alcohol)\b/gi, "palmitic $1"],
    // aspartic → "aspar c"
    [/\baspar\s+(?:ti)?c\s+acid\b/gi, "aspartic acid"],
    // histidine → "his dine" / "his tidine"
    [/\bhis\s+(?:ti)?dine\b/gi, "histidine"],
    // madecassic → "made-cassic"
    [/\bmade-cassic\b/gi, "madecassic"],
    // BHT → "bb ht" / "bb t" (Г лядет двойная B как stutter)
    [/\bbb\s+ht\b/gi, "BHT"],
    // aleth-N → "aketh-N" (OCR k↔l)
    [/\b(c\d{1,2}-\d{1,2})\s+aketh-(\d+)\b/gi, "$1 aleth-$2"],
    // glycerin → "gl ycerin" (Druni разрывает span внутри слова)
    [/\bgl\s+ycerin\b/gi, "glycerin"],
    // collapse stray whitespace
    [/\s+/g, " "],
  ];

  function repairOcrArtifacts(s) {
    let v = s;
    for (const [re, rep] of OCR_REPAIRS) {
      v = v.replace(re, rep);
    }
    return v.trim();
  }

  // Strip noise from a single split fragment so it actually matches the DB:
  //  - "Avobenzone 2.3%" -> "Avobenzone"
  //  - "Sunscreen Homosalate 10.0%" -> "Homosalate"
  //  - "Avobenzone 2.5% (Sunscreen)" -> "Avobenzone"
  //  - leading/trailing punctuation, double spaces.
  // Conservative: numbers without "%" stay (Polyamide-8, Red 33, C12-15, Beheneth-20).
  function normalizeIngredientPart(s) {
    let v = s;
    v = v.replace(/^(?:sunscreen|active|inactive|other)\s+/i, "");
    v = v.replace(/\(\s*sunscreen\s*\)/gi, "");
    v = v.replace(/\b\d+(?:[.,]\d+)?\s*%/g, "");
    v = v.replace(/\s+/g, " ").trim();
    v = v.replace(/^[\s,.;:•·|]+|[\s,.;:•·|]+$/g, "");
    v = repairOcrArtifacts(v);
    return v;
  }

  // Маркетинговые фразы, которые иногда попадают в split (описание эффекта
  // продукта, бенефиты, заголовки секций), – отсеиваются по плотности
  // не-INCI стоп-слов и пунктуации. INCI-имена даже из 4–5 слов содержат
  // максимум одно служебное слово (Acid/Extract/Oil), маркетинговые фразы
  // строятся почти полностью из артиклей и предлогов.
  const MARKETING_STOPWORDS = new Set([
    // ES
    "es", "para", "todo", "todos", "tipo", "tipos", "de", "del", "la", "el",
    "los", "las", "un", "una", "con", "y", "en", "sin", "que", "su", "sus",
    "tu", "tus", "mas", "más", "muy", "ideal", "ayuda", "deja", "dejando",
    "dejándola", "mejora", "potencia", "incluso", "buscan", "quienes",
    "saludable", "uniforme", "brillo", "rostro", "piel", "pieles",
    "seguro", "soluciones", "fórmula", "formula", "acabado", "fresco",
    "suave", "tersa", "radiante", "luminoso", "jugosa", "flexible",
    "firme", "opaca", "opacidad", "desigual", "perdida", "pérdida",
    "envejecimiento", "líneas", "lineas", "finas", "exfolia", "ilumina",
    "suaviza", "reducir", "promover", "regeneración", "regeneracion",
    "celular", "apariencia", "poros", "dilatados", "exceso", "sebo",
    "textura", "irregular", "grasa", "diaria", "skincare", "rutina",
    "aplicar", "capa", "dejar", "secar", "retirar", "agua", "ingredientes",
    "siguiente", "más", "necesitas", "saber", "molestias", "persisten",
    "qué", "que", "cómo", "como", "fórmula:", "formula:",
    // EN
    "for", "with", "and", "the", "all", "your", "skin", "feel", "look",
    "leaves", "ideal", "more", "very", "even", "out", "appearance",
    "reduces", "improves", "enhances", "promotes", "types",
    // RU
    "для", "как", "при", "без", "не", "ваша", "ваш", "ваши", "вашу",
    "оставляя", "помогает", "улучшает", "уменьшает", "способствует",
    "кожа", "кожи", "коже", "лицо", "лица", "выглядит", "эффект",
    "идеальный", "идеальная", "идеально", "очень", "более", "наиболее",
  ]);

  // Слова, на которых INCI-имена реально строятся. Если такое слово есть в
  // токене – он, скорее всего, ингредиент, даже если рядом стоп-слова.
  const INCI_ANCHOR_WORDS = new Set([
    "acid", "extract", "oil", "butter", "wax", "alcohol", "glycol",
    "ether", "ester", "peptide", "ferment", "hyaluronate", "polymer",
    "copolymer", "silicate", "stearate", "palmitate", "laurate", "oleate",
    "glucoside", "sulfate", "sulphate", "chloride", "sodium", "potassium",
    "calcium", "magnesium", "ammonium", "zinc", "tocopherol", "ascorbyl",
    "ascorbate", "retinol", "retinyl", "niacinamide", "panthenol", "amide",
    "amine", "phosphate", "carbonate", "hydroxide", "lactobacillus",
    "extracellular", "vesicles",
  ]);

  function looksLikeMarketingPhrase(token) {
    const tokens = token
      .toLowerCase()
      .replace(/[.,;:!?()[\]"]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
    if (tokens.length < 3) return false;
    if (tokens.some((w) => INCI_ANCHOR_WORDS.has(w))) return false;
    let stop = 0;
    for (const w of tokens) {
      if (MARKETING_STOPWORDS.has(w)) stop++;
    }
    // ≥40% стоп-слов в коротком токене (3-6 слов) или ≥3 стоп-слов
    // в длинном – почти наверняка маркетинговая фраза.
    if (tokens.length >= 6 && stop >= 3) return true;
    if (stop / tokens.length >= 0.4) return true;
    return false;
  }

  // Trailing disclaimers Sephora ES/FR, Druni, Look Fantastic and similar
  // shops append after the INCI list. They often glue onto the last
  // ingredient without a separator (e.g. "tocopherolesta lista de
  // ingredientes está sujeta a cambios"), so substring search is used –
  // a word boundary would miss the no-space case.
  //
  // Also covers «free-from» blocks (Formulado sin: parabenos, sulfatos…),
  // marketing section headers (Fórmula:, Tipo de piel:, Soluciones para:,
  // Acabado:, Qué más necesitas saber:) and application instructions
  // (Modo de empleo, How to use, Способ применения). These come AFTER the
  // INCI list on Druni, Maquillalia, Primor product pages — cutting them
  // here keeps marketing tokens from leaking into the ingredient split.
  const TRAILING_DISCLAIMER_PATTERNS = [
    // ES — disclaimers
    /esta\s+lista\s+de\s+ingredientes/i,
    /consulte\s+el\s+envase/i,
    /la\s+f[oó]rmula\s+puede\s+sufrir/i,
    // ES — «free-from» blocks (Druni, Maquillalia)
    /formulado\s+sin\b/i,
    /libre\s+de\s+(?:parabenos|sulfatos|siliconas|fragancias?|alcohol|aceites?\s+minerales?)/i,
    /sin\s+(?:parabenos|sulfatos|siliconas|fragancias?\s+artificiales?|aceites?\s+minerales?)/i,
    // ES — marketing/product-description section headers
    /\bf[óo]rmula\s*[:：]/i,
    /\btipo\s+de\s+piel\s*[:：]/i,
    /\bsoluciones?\s+para\s*[:：]/i,
    /\bacabado\s*[:：]/i,
    /\bqu[éеe]\s+m[áa]s\s+necesitas\s+saber/i,
    /\bmodo\s+de\s+empleo/i,
    /\bc[óo]mo\s+(?:usar|aplicar)\b/i,
    /\bsuspenda\s+su\s+uso/i,
    // EN
    /ingredients?\s+(?:are\s+|list\s+(?:is|may)\s+)?subject\s+to\s+change/i,
    /(?:please\s+)?refer\s+to\s+(?:the\s+)?(?:product\s+)?(?:packaging|package|box|label)/i,
    /formula(?:tion)?\s+may\s+(?:vary|change)/i,
    /\bfree\s+(?:from|of)\s+(?:parabens|sulfates|silicones|fragrance|alcohol|mineral\s+oils?)/i,
    /\bhow\s+to\s+(?:use|apply)\b/i,
    /\bkey\s+benefits\b/i,
    /\bskin\s+type\s*[:：]/i,
    /\bdirections\s+for\s+use/i,
    // FR
    /cette\s+liste\s+d['e′´]?\s*ingr[eé]dients/i,
    /consultez?\s+l['e′´]?\s*emballage/i,
    /\bformule\s+sans\b/i,
    /\bsans\s+(?:parab[eè]nes|sulfates|silicones|alcool|parfum)/i,
    /\bmode\s+d['e′´]?\s*emploi/i,
    // IT
    /la\s+lista\s+degli?\s+ingredienti/i,
    /consultare\s+(?:la\s+)?confezione/i,
    /\bformulato\s+senza\b/i,
    /\bsenza\s+(?:parabeni|solfati|siliconi|profumo|alcool)/i,
    // DE
    /inhaltsstoffe\s+k[öo]nnen\s+sich\s+[äa]ndern/i,
    /[äa]nderungen\s+vorbehalten/i,
    /\bohne\s+(?:parabene|sulfate|silikone|parf[üu]m|alkohol)/i,
    /\banwendung\s*[:：]/i,
    // RU — «без X», инструкции, маркетинговые секции
    /\bбез\s+(?:парабенов|сульфатов|силиконов|отдушек|спирта|минеральных\s+масел)/i,
    /\bне\s+содержит\s+(?:парабенов|сульфатов|силиконов|отдушек)/i,
    /\bспособ\s+применения/i,
    /\bкак\s+применять/i,
    /\bтип\s+кожи\s*[:：]/i,
  ];

  function stripTrailingDisclaimers(text) {
    let cutAt = -1;
    for (const pattern of TRAILING_DISCLAIMER_PATTERNS) {
      const m = text.search(pattern);
      if (m >= 0 && (cutAt === -1 || m < cutAt)) cutAt = m;
    }
    if (cutAt === -1) return text;
    return text.slice(0, cutAt).replace(/[\s.,;:•·|–—-]+$/, "");
  }

  function splitIngredients(text) {
    let clean = stripTrailingDisclaimers(text)
      .replace(
        /^.*?(состав|ingredients|inci|inhaltsstoffe|zutaten|ingr[ée]dients|composition|ingredienti|composizione|ingredientes|composici[óo]n|sk[łl]adniki|sk[łl]ad|slo[zž]en[íi]|[öo]sszetev[öo]k|zlo[zž]enie|ingredi[eë]nten|samenstelling)\s*[:：]/i,
        "",
      )
      // Strip leftover section headers ("Active Ingredients:", "Inactive Ingredients:",
      // "Key Ingredients:") that appear mid-text on Sephora/Ulta sunscreen pages.
      .replace(/(active|inactive|key|other|main|full)\s+ingredients\s*[:：]/gi, ", ")
      .replace(/\(?\s*(code\s+f\.?i\.?l\.?|batch|lot)\s*[:№]?\s*[A-Za-z0-9/\-.]+\s*\)?\.?/gi, "")
      .replace(/\.\s*$/, "")
      .trim();

    // Space-separated INCI lists (La Roche-Posay Cicaplast style, where the
    // ingredient block is rendered as "Aqua Hydrogenated Polyisobutene
    // Dimethicone Glycerin ..." with no commas at all). Insert commas around
    // known INCI anchors so the standard splitter can take over.
    clean = preprocessSpaceSeparated(clean);

    clean = maskSeparatorsInParens(clean);

    const commas = (clean.match(/,/g) || []).length;
    const periodSeps = (clean.match(/\.\s*[A-Za-z]/g) || []).length;
    const dashSeps = (clean.match(/\s[-–]\s/g) || []).length;
    const bulletSeps = (clean.match(/[•·|]/g) || []).length;

    const candidates = [
      { type: "bullet", count: bulletSeps, regex: /[•·|]/ },
      { type: "dash", count: dashSeps, regex: /\s[-–]\s/ },
      { type: "period", count: periodSeps, regex: /\.\s*(?=[A-Za-zА-Яа-я])/ },
      { type: "comma", count: commas, regex: /[,;]/ },
    ];
    candidates.sort((a, b) => b.count - a.count);
    const winner = candidates[0];

    let parts;
    if (winner && winner.count >= 3) {
      parts = clean
        .split(new RegExp(winner.regex.source, "g"))
        .map((s) => unmaskSeparators(s).trim().replace(/\s+/g, " "))
        .map(normalizeIngredientPart)
        .filter((s) => s.length > 1 && s.length < 100)
        .filter((s) => !looksLikeMarketingPhrase(s));
    } else {
      parts = clean
        .split(/[,;•·|]|\s[-–]\s/)
        .map((s) => unmaskSeparators(s).trim().replace(/\s+/g, " "))
        .map(normalizeIngredientPart)
        .filter((s) => s.length > 1 && s.length < 100)
        .filter((s) => !looksLikeMarketingPhrase(s));
    }

    const expanded = [];
    for (const part of parts) {
      if (/[\/\\]/.test(part)) {
        // Slash-split is dangerous: it shreds names like
        //   "Peg/Ppg-9/2 Dimethyl Ether"
        //   "Eucheuma Serra/Grateloupia Sparsa/.../Pinnatifida Extract"
        // into nonsense fragments. Only split when every chunk looks like a
        // short single-word synonym (Aqua/Water/Eau, Parfum/Fragrance).
        const subs = part
          .split(/[\/\\]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        const looksLikeSynonyms =
          subs.length >= 2 && subs.length <= 4 && subs.every((s) => !/\s/.test(s) && s.length <= 8);
        if (looksLikeSynonyms) {
          for (const sub of subs) expanded.push(sub);
        } else {
          expanded.push(part);
        }
      } else {
        expanded.push(part);
      }
    }

    const expandedFinal = [];
    for (const part of expanded) {
      const m = part.match(/^(.+?)\s*\(([^()]+,[^()]+)\)\s*$/);
      if (m) {
        const subItems = m[2]
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 1 && s.length < 80);
        if (subItems.length >= 2) {
          for (const s of subItems) expandedFinal.push(s);
          continue;
        }
      }
      expandedFinal.push(part);
    }
    return expandedFinal;
  }

  // ============================================================
  // ANALYZE + RENDER
  // ============================================================

  async function analyze(parseResult) {
    if (/\.{3}|…/.test(parseResult.text)) {
      LOG("Text contains ellipsis – truncated preview, skipping");
      return;
    }

    const ingredients = splitIngredients(parseResult.text);

    if (ingredients.length < 7) {
      LOG("Split produced too few items (<7), not analyzing");
      return;
    }

    // Re-analyze when the source text actually changed (e.g. SPA navigated to
    // another product). Previously this guarded by ingredient count, which
    // silently skipped a new product if it had fewer ingredients than the old.
    const fingerprint = parseResult.text.replace(/\s+/g, " ").slice(0, 240);
    if (analyzed && fingerprint === lastAnalyzedKey) {
      return;
    }

    analyzed = true;
    lastAnalyzedKey = fingerprint;
    LOG(
      "Split into",
      ingredients.length,
      "ingredients:",
      ingredients.slice(0, 5).join(", "),
      "...",
    );
    if (ingredients.length === 0) return;

    const storeSlug = resolveStoreSlug(host);
    track("SCAN", { store: storeSlug, totalCount: ingredients.length });

    const safeIngredients = ingredients
      .filter((s) => typeof s === "string")
      .map((s) => s.slice(0, 200))
      .slice(0, 200);
    const postMatch = () =>
      fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ingredients: safeIngredients }),
        credentials: "omit",
        referrer: "",
        mode: "cors",
      });

    let data;
    try {
      let res;
      try {
        res = await postMatch();
      } catch (err) {
        // "Failed to fetch" means the connection dropped, usually for seconds:
        // a VPN switching exits, Wi-Fi waking up. In July 2026 a user's next
        // attempt on the same Sephora page went through 4 s after the error.
        // A second failure falls through to the outer catch and is reported.
        LOG("API fetch failed, retrying once:", err);
        await new Promise((r) => setTimeout(r, MATCH_RETRY_DELAY_MS));
        // The page may have moved on to another product while we waited.
        if (lastAnalyzedKey !== fingerprint) return;
        res = await postMatch();
      }
      LOG("API response status:", res.status);
      try {
        const check = globalThis.evgContract?.checkApiVersion(res.headers);
        if (check?.outdated) {
          try {
            chrome.runtime.sendMessage({ action: "apiOutdated" });
          } catch {}
        }
      } catch {}
      if (!res.ok) {
        LOG("API error");
        track("ERROR", {
          store: storeSlug,
          errorCode: `match_http_${res.status}`,
        });
        return;
      }
      data = globalThis.evgContract.sanitizeMatchResponse(await res.json());
    } catch (err) {
      LOG("API fetch failed:", err);
      const offline = navigator.onLine === false;
      track("ERROR", {
        store: storeSlug,
        errorCode: "match_fetch_failed",
        // "(offline)" tells the dashboard reader the user's own connection
        // was down, not our API.
        comment:
          String(err && err.message ? err.message : err).slice(0, 480) +
          (offline ? " (offline)" : ""),
      });
      if (offline) {
        // The browser knows the network is gone, so it will also say when it
        // is back. Analyze the same block then instead of leaving the page
        // without a panel until the next reload.
        window.addEventListener(
          "online",
          () => {
            if (lastAnalyzedKey !== fingerprint) return;
            if (!parseResult.element?.isConnected) return;
            lastAnalyzedKey = "";
            analyze(parseResult);
          },
          { once: true },
        );
      }
      return;
    }

    LOG("API returned", data.matches?.length, "matches,", data.unknown?.length, "unknown");
    if (!data.matches || data.matches.length === 0) return;

    // Load blacklist and health filters for highlighting
    const [blacklist] = await Promise.all([loadBlacklist(), loadHealthFilters()]);

    // Attach blacklist hits + health-risk flags to each match
    for (const m of data.matches) {
      m._blacklistHits = matchesBlacklist(m, blacklist);
      m._healthHits = matchHealthRisk(m);
      // If the user enabled the pregnancy/lactation filter AND this ingredient
      // is AVOID for that state, surface it as a critical risk by ensuring
      // its risk-badge array contains the corresponding marker even when the
      // server response forgot it (defensive — sanitizer might strip new keys).
      if (m._healthHits.length && Array.isArray(m.riskBadges)) {
        for (const h of m._healthHits) {
          if (!m.riskBadges.includes(h)) m.riskBadges.push(h);
        }
      }
    }

    // Store raw data for comparison feature
    data._rawIngredients = ingredients;
    data._totalIngredients = ingredients.length;

    try {
      highlightIngredients(parseResult.element, data.matches);
      for (const extraEl of findAdditionalCompositionElements(parseResult.element)) {
        try {
          highlightIngredients(extraEl, data.matches);
        } catch {}
      }
    } catch (err) {
      LOG("Highlight error:", err);
    }
    try {
      injectPanel(parseResult.element, data, ingredients.length, blacklist);
      // Fires once per analysis success. Counts let the dashboard track DB
      // coverage in the wild (matched/total) and spot parser regressions
      // (sudden drop in matched on a single store).
      track("PANEL_SHOWN", {
        store: storeSlug,
        matchedCount: data.matches.length,
        totalCount: ingredients.length,
        unknownCount: Array.isArray(data.unknown) ? data.unknown.length : 0,
      });
    } catch (err) {
      LOG("Panel inject error:", err);
      track("ERROR", {
        store: storeSlug,
        errorCode: "panel_inject_failed",
        comment: String(err && err.message ? err.message : err).slice(0, 500),
      });
    }
    try {
      injectFloatingBadge(data, ingredients.length, blacklist);
    } catch (err) {
      LOG("Badge error:", err);
    }
  }

  // ============================================================
  // HIGHLIGHT ingredients in the original text
  // ============================================================

  function highlightIngredients(element, matches) {
    for (const span of element.querySelectorAll(".evg-hl")) {
      const parent = span.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(span.textContent || ""), span);
        parent.normalize();
      }
    }

    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.parentElement?.closest?.(".evg-hl")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const textNodes = [];
    let n = walker.nextNode();
    while (n) {
      textNodes.push(n);
      n = walker.nextNode();
    }

    const names = [];
    const byLower = new Map();
    for (const m of matches) {
      if (!m.query) continue;
      const lower = m.query.toLowerCase();
      if (!byLower.has(lower)) {
        byLower.set(lower, m);
        names.push(m.query);
      }
    }
    if (names.length === 0) return;

    names.sort((a, b) => b.length - a.length);
    const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const WORD = "[A-Za-zА-Яа-яЁё0-9]";
    const combined = new RegExp(`(?<!${WORD})(${escaped.join("|")})(?!${WORD})`, "gi");

    for (const node of textNodes) {
      const original = node.textContent || "";
      if (!combined.test(original)) continue;
      combined.lastIndex = 0;

      const frag = document.createDocumentFragment();
      let lastIdx = 0;
      let match = combined.exec(original);

      while (match !== null) {
        const start = match.index;
        const end = start + match[0].length;

        if (start > lastIdx) {
          frag.appendChild(document.createTextNode(original.slice(lastIdx, start)));
        }

        const matchedText = match[0];
        const ingredient = byLower.get(matchedText.toLowerCase());
        if (ingredient) {
          const span = document.createElement("span");
          span.className = "evg-hl";
          // Blacklist items get a distinct highlight
          const isBlacklisted = ingredient._blacklistHits && ingredient._blacklistHits.length > 0;
          if (isBlacklisted) {
            span.style.cssText =
              "background:#fecaca;border-bottom:3px solid #dc2626;border-radius:3px;padding:1px 3px;cursor:help";
          } else if (ingredient.isFunctional) {
            // Functional ingredients go into the "basic" bucket in the side
            // panel (gray dashed dots) regardless of trafficLight. Mirror that
            // here so the body highlight doesn't over-promise: subtle gray
            // underline only, no colored background.
            span.style.cssText =
              "border-bottom:1px dashed #9ca3af;border-radius:3px;padding:1px 3px;cursor:help";
          } else {
            span.style.cssText = `background:${tlColor(ingredient.trafficLight)};border-bottom:2px solid ${tlBorderColor(ingredient.trafficLight)};border-radius:3px;padding:1px 3px;cursor:help`;
          }
          span.title = isBlacklisted
            ? `\u26a0 ${ingredient._blacklistHits.map((h) => (h.type === "allergen" ? t("blAllergenForYou") : h.type === "comedogenic" ? t("blComedogenicForYou") : t("blAvoidForYou"))).join(", ")} – ${primaryName(ingredient)}`
            : (() => {
                const sec = secondaryName(ingredient);
                return sec ? `${primaryName(ingredient)} (${sec})` : primaryName(ingredient);
              })();
          span.textContent = matchedText;
          frag.appendChild(span);
        } else {
          frag.appendChild(document.createTextNode(matchedText));
        }

        lastIdx = end;
        match = combined.exec(original);
      }

      if (lastIdx < original.length) {
        frag.appendChild(document.createTextNode(original.slice(lastIdx)));
      }

      node.parentNode?.replaceChild(frag, node);
    }
  }

  function tlColor(tl) {
    if (tl === "GREEN") return "#dcfce7";
    if (tl === "YELLOW") return "#fef3c7";
    if (tl === "RED") return "#fef2f2";
    if (tl === "PRESCRIPTION") return "#ede9fe";
    return "transparent";
  }

  function tlBorderColor(tl) {
    if (tl === "GREEN") return "#16a34a";
    if (tl === "YELLOW") return "#d97706";
    if (tl === "RED") return "#dc2626";
    if (tl === "PRESCRIPTION") return "#6b21a8";
    return "transparent";
  }

  function tlDotColor(tl) {
    if (tl === "GREEN") return "#16a34a";
    if (tl === "YELLOW") return "#d97706";
    if (tl === "RED") return "#dc2626";
    if (tl === "PRESCRIPTION") return "#6b21a8";
    return "#9ca3af";
  }

  // Лениво: locale грузится async из storage, поэтому t() при загрузке скрипта
  // может вернуть RU вместо EN/ES. Вычисляем в момент рендера панели.
  function getBadges() {
    return {
      allergen: {
        letter: t("badgeAllergenLetter"),
        title: t("badgeAllergenTitle"),
        color: "#dc2626",
      },
      comedogenic: {
        letter: t("badgeComedogenicLetter"),
        title: t("badgeComedogenicTitle"),
        color: "#d97706",
      },
      pregnancy: {
        letter: t("badgePregnancyLetter"),
        title: t("badgePregnancyTitle"),
        color: "#9333ea",
      },
      lactation: {
        letter: globalThis.evgI18n?.locale === "ru" ? "Л" : "L",
        title:
          globalThis.evgI18n?.locale === "es"
            ? "No recomendado durante la lactancia"
            : globalThis.evgI18n?.locale === "ru"
              ? "Не рекомендуют при лактации"
              : "Not recommended during breastfeeding",
        color: "#db2777",
      },
      irritation: {
        letter: t("badgeIrritationLetter"),
        title: t("badgeIrritationTitle"),
        color: "#ca8a04",
      },
      "fabric-stain": {
        letter: globalThis.evgI18n?.locale === "ru" ? "О" : globalThis.evgI18n?.locale === "es" ? "M" : "S",
        title:
          globalThis.evgI18n?.locale === "es"
            ? "Puede manchar la ropa"
            : globalThis.evgI18n?.locale === "ru"
              ? "Может окрашивать одежду"
              : "May stain fabric",
        color: "#0284c7",
      },
      formaldehyde: {
        letter: globalThis.evgI18n?.locale === "ru" ? "Ф" : "FA",
        title:
          globalThis.evgI18n?.locale === "es"
            ? "Libera formaldehído"
            : globalThis.evgI18n?.locale === "ru"
              ? "Выделяет формальдегид"
              : "Releases formaldehyde",
        color: "#4338ca",
      },
    };
  }

  // biome-ignore lint/correctness/noUnusedVariables: tooltip helper, wired up in tooltip.js
  function tlTitle(match) {
    const labels = { GREEN: t("tlGreen"), YELLOW: t("tlYellow"), RED: t("tlRed") };
    let title = `${primaryName(match)} – ${labels[match.trafficLight] || t("tlNoData")}`;
    if (match.positionWarning) title += ` \u26a0 ${match.positionWarning}`;
    return title;
  }

  // ============================================================
  // FLOATING PANEL next to composition
  // ============================================================

  function injectPanel(element, data, totalIngredients, _blacklist) {
    const existingHost = document.getElementById("evigrade-panel-host");
    if (existingHost) existingHost.remove();
    const existing = document.getElementById("evigrade-panel");
    if (existing) existing.remove();

    const seenSlugs = new Set();
    const uniqueMatches = [];
    for (const m of data.matches) {
      if (seenSlugs.has(m.slug)) continue;
      seenSlugs.add(m.slug);
      uniqueMatches.push(m);
    }

    const counts = { green: 0, yellow: 0, red: 0, prescription: 0, functional: 0 };
    for (const m of uniqueMatches) {
      if (m.isFunctional) counts.functional++;
      else if (m.trafficLight === "GREEN") counts.green++;
      else if (m.trafficLight === "YELLOW") counts.yellow++;
      else if (m.trafficLight === "RED") counts.red++;
      else if (m.trafficLight === "PRESCRIPTION") counts.prescription++;
    }

    const warnings = uniqueMatches.filter((m) => m.positionWarning);
    const matched = uniqueMatches.length;

    const compositeWarnings = Array.isArray(data.warnings) ? data.warnings : [];

    // Pregnancy / lactation banner: collect AVOID-flagged matches.
    const pregnancyAvoid = healthFilters.pregnancy
      ? uniqueMatches.filter((m) => m._healthHits?.includes("pregnancy"))
      : [];
    const lactationAvoid = healthFilters.lactation
      ? uniqueMatches.filter((m) => m._healthHits?.includes("lactation"))
      : [];

    // Check blacklist matches
    const blacklistMatches = uniqueMatches.filter(
      (m) => m._blacklistHits && m._blacklistHits.length > 0,
    );

    // Display order requested by the editor:
    //  1. Blacklist (user's personal red flags)
    //  2. UV filters (grouped together)
    //  3. RED / PRESCRIPTION – "не работает" должно быть сразу видно
    //  4. GREEN – подтверждённые активы
    //  5. YELLOW с риск-бейджами (аллерген / комедоген / беременность /
    //     раздражение) – пользователь должен видеть риски, а не зарывать
    //     их в самый низ
    //  6. YELLOW без риск-бейджей – нейтральные «спорные»
    //  7. functional – базовые компоненты, не должны заглушать сигнал
    const genOrder = { MODERN: 0, ESTABLISHED: 1, LEGACY: 2, DISCOURAGED: 3 };
    const trafficGroup = (m) => {
      if (m.isFunctional) return 6;
      if (m.trafficLight === "RED") return 2;
      if (m.trafficLight === "PRESCRIPTION") return 2;
      if (m.trafficLight === "GREEN") return 3;
      if (m.trafficLight === "YELLOW") {
        const hasRisk = Array.isArray(m.riskBadges) && m.riskBadges.length > 0;
        return hasRisk ? 4 : 5;
      }
      return 6;
    };
    const sorted = [...uniqueMatches].sort((a, b) => {
      // Pregnancy/lactation AVOID first when the user has the filter enabled.
      const hhA = a._healthHits && a._healthHits.length > 0 ? 0 : 1;
      const hhB = b._healthHits && b._healthHits.length > 0 ? 0 : 1;
      if (hhA !== hhB) return hhA - hhB;
      const blA = a._blacklistHits && a._blacklistHits.length > 0 ? 0 : 1;
      const blB = b._blacklistHits && b._blacklistHits.length > 0 ? 0 : 1;
      if (blA !== blB) return blA - blB;
      const uvA = a.filterGeneration ? 0 : 1;
      const uvB = b.filterGeneration ? 0 : 1;
      if (uvA !== uvB) return uvA - uvB;
      if (uvA === 0) {
        return (genOrder[a.filterGeneration] ?? 4) - (genOrder[b.filterGeneration] ?? 4);
      }
      const gA = trafficGroup(a);
      const gB = trafficGroup(b);
      if (gA !== gB) return gA - gB;
      // Внутри одной группы: впереди те, чей ингредиент в первых 5 INCI
      // (positionWarning = высокая концентрация → больший риск).
      const wA = a.positionWarning ? -1 : 0;
      const wB = b.positionWarning ? -1 : 0;
      return wA - wB;
    });

    // 1%-линия рассчитывается ОДИН раз для всего состава, передаётся в renderRow.
    const onePctLine = findOnePctLine(uniqueMatches);

    const panel = document.createElement("div");
    panel.id = "evigrade-panel";
    panel.innerHTML = `
      <style>
        #evigrade-panel {
          margin-top: 12px;
          border: 1px solid #e5e5e5;
          border-radius: 12px;
          background: #fff;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          font-size: 13px;
          color: #1a1a2e;
          overflow: hidden;
          box-shadow: 0 1px 4px rgba(0,0,0,0.06);
        }
        #evigrade-panel * { box-sizing: border-box; }
        #evigrade-panel h1, #evigrade-panel h2, #evigrade-panel h3,
        #evigrade-panel h4, #evigrade-panel p, #evigrade-panel ul,
        #evigrade-panel ol, #evigrade-panel li, #evigrade-panel figure,
        #evigrade-panel blockquote, #evigrade-panel dl, #evigrade-panel dd {
          margin: 0; padding: 0;
        }
        #evigrade-panel button { margin: 0; padding: 0; border: none; background: none; font: inherit; }
        .evg-header {
          background: #1e3a5f;
          padding: 14px 28px !important;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .evg-logo {
          width: 22px; height: 22px;
          background: #2db5a3;
          color: #fff;
          font-family: Georgia, serif;
          font-weight: 900;
          font-size: 13px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 5px;
          flex-shrink: 0;
        }
        .evg-title {
          color: #fff;
          font-family: Georgia, serif;
          font-weight: 800;
          font-size: 14px;
        }
        .evg-sub {
          color: rgba(255,255,255,0.5);
          font-size: 11px;
        }
        .evg-spacer {
          flex: 1 1 auto;
          min-width: 12px;
        }
        /* id-префикс нужен: правило #evigrade-panel button {padding:0}
           имеет специфичность (1,0,1) и бьёт по .evg-compare-btn без него. */
        #evigrade-panel .evg-compare-btn {
          padding: 8px 18px;
          background: rgba(94,234,212,0.12);
          color: #5eead4;
          border: 1.5px solid rgba(94,234,212,0.55);
          border-radius: 999px;
          font-size: 13px;
          font-weight: 600;
          letter-spacing: 0.2px;
          line-height: 1.2;
          cursor: pointer;
          white-space: nowrap;
          transition: background 0.15s, border-color 0.15s, transform 0.1s;
        }
        #evigrade-panel .evg-compare-btn:hover {
          background: rgba(94,234,212,0.22);
          border-color: rgba(94,234,212,0.85);
          color: #99f6e4;
          transform: translateY(-1px);
        }
        #evigrade-panel .evg-compare-btn:active { transform: translateY(0); }
        #evigrade-panel .evg-compare-btn.evg-added {
          background: rgba(255,255,255,0.08);
          color: rgba(255,255,255,0.6);
          border-color: rgba(255,255,255,0.18);
          cursor: default;
        }
        .evg-blacklist-banner {
          display: flex;
          gap: 8px;
          padding: 14px 28px !important;
          background: #fef2f2;
          border-bottom: 2px solid #dc2626;
          align-items: flex-start;
        }
        .evg-blacklist-icon {
          font-size: 18px;
          flex-shrink: 0;
          line-height: 1;
        }
        .evg-blacklist-text {
          flex: 1;
        }
        .evg-blacklist-title {
          font-weight: 700;
          font-size: 13px;
          color: #991b1b;
        }
        .evg-blacklist-details {
          font-size: 11px;
          color: #dc2626;
          margin-top: 2px;
        }
        .evg-summary {
          display: flex;
          gap: 10px;
          padding: 14px 28px !important;
          border-bottom: 1px solid #f0f0f0;
          font-size: 12px;
          font-weight: 600;
          flex-wrap: wrap;
        }
        .evg-sum-item {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 6px 12px;
          background: #f1f5f9;
          border: 1.5px solid transparent;
          border-radius: 999px;
          font-size: 12px;
          font-weight: 600;
          color: #1e3a5f;
          cursor: pointer;
          transition: all 0.15s;
        }
        .evg-filter-btn:hover { background: #e2e8f0; }
        .evg-filter-btn.evg-filter-active {
          background: #1e3a5f;
          color: #fff;
          border-color: #1e3a5f;
        }
        .evg-filter-btn.evg-filter-active .evg-dot { box-shadow: 0 0 0 2px rgba(255,255,255,0.4); }
        .evg-filter-fn { color: #475569; }
        .evg-cat-chip {
          display: inline-flex;
          align-items: center;
          padding: 3px 9px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 600;
          white-space: nowrap;
          flex-shrink: 0;
          background: #f1f5f9;
          color: #475569;
        }
        .evg-cat-functional {
          background: #f1f5f9;
          color: #64748b;
          font-style: italic;
        }
        .evg-conc-chip {
          display: inline-flex;
          align-items: center;
          padding: 3px 9px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 700;
          white-space: nowrap;
          flex-shrink: 0;
          cursor: help;
          margin-right: 6px;
        }
        .evg-conc-eff { background: #dcfce7; color: #166534; }
        .evg-conc-bord { background: #fef3c7; color: #92400e; }
        .evg-conc-dec { background: #fee2e2; color: #991b1b; }
        .evg-disclaimer {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          padding: 10px 24px !important;
          background: #f8fafc;
          border-bottom: 1px solid #f0f0f0;
          font-size: 11px;
          color: #64748b;
          line-height: 1.5;
        }
        .evg-disclaimer-icon {
          flex-shrink: 0;
          width: 16px; height: 16px;
          border-radius: 50%;
          background: #cbd5e1;
          color: #fff;
          font-size: 11px;
          font-weight: 700;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          margin-top: 1px;
        }
        .evg-dot {
          width: 10px; height: 10px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .evg-legend {
          display: flex;
          gap: 10px;
          padding: 12px 28px !important;
          border-bottom: 1px solid #f0f0f0;
          background: #fafafa;
          font-size: 10px;
          color: #6b7280;
          flex-wrap: wrap;
        }
        .evg-legend-item {
          display: flex;
          align-items: center;
          gap: 4px;
        }
        .evg-legend-gen {
          background: #fafafa;
          font-size: 11px;
        }
        .evg-legend-title {
          font-weight: 600;
          color: #374151;
          margin-right: 4px;
        }
        .evg-legend-badge {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 14px; height: 14px;
          border-radius: 3px;
          color: #fff;
          font-weight: 700;
          font-size: 9px;
          font-family: -apple-system, sans-serif;
        }
        .evg-list {
          max-height: 340px;
          overflow-y: auto;
        }
        .evg-list[data-filter="green"] .evg-row:not([data-tl="green"]) { display: none; }
        .evg-list[data-filter="yellow"] .evg-row:not([data-tl="yellow"]) { display: none; }
        .evg-list[data-filter="red"] .evg-row:not([data-tl="red"]) { display: none; }
        .evg-list[data-filter="prescription"] .evg-row:not([data-tl="prescription"]) { display: none; }
        .evg-list[data-filter="functional"] .evg-row:not([data-tl="functional"]) { display: none; }
        .evg-row {
          display: flex;
          align-items: center;
          gap: 16px;
          padding: 12px 28px !important;
          border-bottom: 1px solid #f5f5f5;
          text-decoration: none;
          color: inherit;
          transition: background 0.15s;
        }
        .evg-row:hover { background: #f9fafb; }
        .evg-row:last-child { border-bottom: none; }
        .evg-row.evg-warn { background: #fef2f2; }
        .evg-row.evg-warn:hover { background: #fee2e2; }
        .evg-row.evg-functional { opacity: 0.6; }
        .evg-row.evg-blacklisted {
          background: #fef2f2;
          border-left: 3px solid #dc2626;
        }
        .evg-row.evg-blacklisted:hover { background: #fee2e2; }
        .evg-bl-badge {
          display: inline-flex;
          align-items: center;
          gap: 3px;
          padding: 1px 6px;
          background: #dc2626;
          color: #fff;
          border-radius: 3px;
          font-size: 9px;
          font-weight: 700;
          white-space: nowrap;
          margin-top: 2px;
        }
        .evg-tl {
          width: 18px; height: 18px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .evg-tl-fn {
          width: 18px; height: 18px;
          border-radius: 50%;
          border: 2.5px dashed #64748b;
          background: #f1f5f9;
          flex-shrink: 0;
        }
        .evg-info { flex: 1; min-width: 0; }
        .evg-name {
          font-weight: 600;
          font-size: 13px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .evg-name-en {
          font-size: 11px;
          color: #888;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .evg-warning-text {
          font-size: 11px;
          color: #dc2626;
          margin-top: 2px;
          white-space: normal;
        }
        .evg-badges {
          display: flex;
          gap: 3px;
          flex-shrink: 0;
        }
        .evg-badge {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 18px; height: 18px;
          border-radius: 4px;
          color: #fff;
          font-weight: 700;
          font-size: 11px;
          cursor: help;
        }
        .evg-gen-chip {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          margin-left: 10px;
          padding: 1px 8px;
          height: 18px;
          border-radius: 10px;
          font-size: 10px;
          font-weight: 600;
          cursor: help;
          vertical-align: middle;
          white-space: nowrap;
        }
        .evg-composite-warning {
          display: flex;
          gap: 10px;
          padding: 14px 28px;
          background: #fffbeb;
          border-bottom: 1px solid #fde68a;
          align-items: flex-start;
        }
        .evg-composite-icon {
          font-size: 16px;
          flex-shrink: 0;
        }
        .evg-composite-text {
          flex: 1;
          min-width: 0;
        }
        .evg-composite-title {
          font-weight: 600;
          font-size: 12px;
          color: #92400e;
        }
        .evg-composite-details {
          font-size: 11px;
          color: #6b7280;
          margin-top: 2px;
        }
      </style>
      <div class="evg-header">
        <span class="evg-logo">E</span>
        <span class="evg-title">Evigrade</span>
        <span class="evg-sub">${esc(t("panelMatchOf", matched, totalIngredients))}</span>
        <span class="evg-spacer"></span>
        <button class="evg-compare-btn" id="evigrade-open-site-btn" title="${esc(t("panelOpenSiteTitle"))}">${esc(t("panelOpenSite"))}</button>
        <button class="evg-compare-btn" id="evigrade-compare-btn">${esc(t("panelAddCompare"))}</button>
        <button id="evigrade-close" class="evg-close" aria-label="${esc(t("panelClose"))}" title="${esc(t("panelClose"))}">\u00d7</button>
      </div>
      ${
        blacklistMatches.length > 0
          ? `
      <div class="evg-blacklist-banner">
        <span class="evg-blacklist-icon">\u26a0\ufe0f</span>
        <div class="evg-blacklist-text">
          <div class="evg-blacklist-title">${esc(t("panelBlacklistTitle"))}</div>
          <div class="evg-blacklist-details">${blacklistMatches
            .map((m) => {
              const types = m._blacklistHits.map((h) =>
                h.type === "allergen"
                  ? t("blAllergen")
                  : h.type === "comedogenic"
                    ? t("blComedogenic")
                    : t("blAvoid"),
              );
              return `${esc(primaryName(m))} (${types.join(", ")})`;
            })
            .join("; ")}</div>
        </div>
      </div>
      `
          : ""
      }
      ${
        pregnancyAvoid.length > 0
          ? `
      <div class="evg-health-banner" style="background:#fdf2f8;border-left:4px solid #db2777;padding:10px 14px;margin:8px 12px;border-radius:6px;display:flex;gap:10px;align-items:flex-start">
        <span style="font-size:18px">\u{1F6AB}</span>
        <div style="flex:1;color:#831843">
          <div style="font-weight:600;margin-bottom:2px">${esc(t("healthAvoidPregnancy"))}</div>
          <div style="font-size:12px;line-height:1.4">${pregnancyAvoid.map((m) => esc(primaryName(m))).join(", ")}</div>
        </div>
      </div>
      `
          : ""
      }
      ${
        lactationAvoid.length > 0
          ? `
      <div class="evg-health-banner" style="background:#fdf2f8;border-left:4px solid #be185d;padding:10px 14px;margin:8px 12px;border-radius:6px;display:flex;gap:10px;align-items:flex-start">
        <span style="font-size:18px">\u{1F37C}</span>
        <div style="flex:1;color:#831843">
          <div style="font-weight:600;margin-bottom:2px">${esc(t("healthAvoidLactation"))}</div>
          <div style="font-size:12px;line-height:1.4">${lactationAvoid.map((m) => esc(primaryName(m))).join(", ")}</div>
        </div>
      </div>
      `
          : ""
      }
      <div class="evg-summary">
        ${counts.green > 0 ? `<button type="button" class="evg-sum-item evg-filter-btn" data-filter="green"><span class="evg-dot" style="background:#16a34a"></span>${esc(t("countWorks", counts.green))}</button>` : ""}
        ${counts.yellow > 0 ? `<button type="button" class="evg-sum-item evg-filter-btn" data-filter="yellow"><span class="evg-dot" style="background:#d97706"></span>${esc(t("countUncertain", counts.yellow))}</button>` : ""}
        ${counts.red > 0 ? `<button type="button" class="evg-sum-item evg-filter-btn" data-filter="red"><span class="evg-dot" style="background:#dc2626"></span>${esc(t("countDoesntWork", counts.red))}</button>` : ""}
        ${counts.prescription > 0 ? `<button type="button" class="evg-sum-item evg-filter-btn" data-filter="prescription"><span class="evg-dot" style="background:#6b21a8"></span>${counts.prescription} Rx</button>` : ""}
        ${counts.functional > 0 ? `<button type="button" class="evg-sum-item evg-filter-btn evg-filter-fn" data-filter="functional">${esc(t("countFunctional", counts.functional))}</button>` : ""}
        ${warnings.length > 0 ? `<span class="evg-sum-item" style="color:#dc2626">\u26a0 ${warnings.length}</span>` : ""}
      </div>
      <div class="evg-legend">
        <span class="evg-legend-item"><span class="evg-legend-badge" style="background:#dc2626">${esc(t("badgeAllergenLetter"))}</span>${esc(t("legendAllergen"))}</span>
        <span class="evg-legend-item"><span class="evg-legend-badge" style="background:#d97706">${esc(t("badgeComedogenicLetter"))}</span>${esc(t("legendComedogenic"))}</span>
        <span class="evg-legend-item"><span class="evg-legend-badge" style="background:#9333ea">${esc(t("badgePregnancyLetter"))}</span>${esc(t("legendPregnancy"))}</span>
        <span class="evg-legend-item"><span class="evg-legend-badge" style="background:#ca8a04">${esc(t("badgeIrritationLetter"))}</span>${esc(t("legendIrritation"))}</span>
      </div>
      ${
        hasAnyGenerationFilter(uniqueMatches)
          ? `
      <div class="evg-legend evg-legend-gen">
        <span class="evg-legend-title">${esc(t("legendSpfTitle"))}</span>
        <span class="evg-legend-item"><span style="color:#0891b2">\u2728</span>${esc(t("spfModern"))}</span>
        <span class="evg-legend-item"><span style="color:#92400e">\u23F3</span>${esc(t("spfOutdated"))}</span>
        <span class="evg-legend-item"><span style="color:#991b1b">\u26d4</span>${esc(t("spfAvoid"))}</span>
      </div>
      `
          : ""
      }
      ${
        hasAnySurfactant(uniqueMatches)
          ? `
      <div class="evg-legend evg-legend-gen">
        <span class="evg-legend-title">${esc(t("legendSurfTitle"))}</span>
        <span class="evg-legend-item"><span style="color:#166534">\u{1F9FC}</span>${esc(t("surfUltraMild"))}</span>
        <span class="evg-legend-item"><span style="color:#047857">\u{1F9FC}</span>${esc(t("surfMild"))}</span>
        <span class="evg-legend-item"><span style="color:#92400e">\u{1F9FC}</span>${esc(t("surfModerate"))}</span>
        <span class="evg-legend-item"><span style="color:#991b1b">\u{1F9FC}</span>${esc(t("surfHarsh"))}</span>
      </div>
      `
          : ""
      }
      ${compositeWarnings.length > 0 ? compositeWarnings.map((w) => renderCompositeWarning(w, uniqueMatches)).join("") : ""}
      <div class="evg-list">
        ${sorted.map((m) => renderRow(m, totalIngredients, onePctLine)).join("")}
      </div>
      ${
        data.unknown && data.unknown.length > 0
          ? `
      <div class="evg-unknown">
        <div class="evg-unknown-header">${esc(t("panelUnknownHeader", data.unknown.length))}</div>
        <div class="evg-unknown-list">${data.unknown.map((u) => `<span class="evg-unknown-chip">${esc(u)}</span>`).join("")}</div>
      </div>
      `
          : ""
      }
    `;

    const host = location.hostname;
    const useFloating =
      host.includes("wildberries.") || host.includes("ozon.ru") || host.includes("ozon.com");

    const listStyleInject = document.createElement("style");
    listStyleInject.textContent = `
      #evigrade-panel .evg-list {
        ${useFloating ? "max-height: calc(100vh - 340px) !important;" : ""}
        overflow-y: auto !important;
      }
      #evigrade-panel .evg-close {
        margin-left: 8px;
        width: 24px;
        height: 24px;
        border: none;
        background: rgba(255,255,255,0.1);
        color: #fff;
        font-size: 18px;
        line-height: 1;
        border-radius: 6px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;
      }
      #evigrade-panel .evg-close:hover { background: rgba(255,255,255,0.2); }
      #evigrade-panel .evg-unknown {
        padding: 12px 24px;
        border-top: 1px solid #f0f0f0;
        background: #fafafa;
      }
      #evigrade-panel .evg-unknown-header {
        font-size: 11px;
        font-weight: 600;
        color: #6b7280;
        margin-bottom: 6px;
      }
      #evigrade-panel .evg-unknown-list {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }
      #evigrade-panel .evg-unknown-chip {
        display: inline-block;
        padding: 2px 8px;
        background: #fff;
        border: 1px solid #e5e7eb;
        border-radius: 10px;
        font-size: 11px;
        color: #4b5563;
      }
    `;
    panel.appendChild(listStyleInject);

    const hostEl = document.createElement("div");
    hostEl.id = "evigrade-panel-host";
    const shadow = hostEl.attachShadow({ mode: "open" });
    shadow.appendChild(panel);

    if (useFloating) {
      hostEl.style.cssText = `
        position: fixed !important;
        bottom: 80px !important;
        right: 20px !important;
        width: 380px !important;
        max-width: calc(100vw - 40px) !important;
        max-height: calc(100vh - 140px) !important;
        z-index: 2147483646 !important;
        overflow: hidden !important;
        display: block !important;
      `;
      panel.style.width = "100%";
      panel.style.maxHeight = "100%";
      document.body.appendChild(hostEl);
      LOG("Panel injected inside Shadow DOM, floating overlay");
    } else {
      // Защита: parseResult.element мог отдетачиться от DOM, пока шёл API-запрос
      // (Vue/SPA-перерендер). element.parentNode тогда null → TypeError молча
      // ронял injectPanel и плашка не появлялась. Падаем на floating-fallback.
      if (!element || !element.parentNode) {
        document.body.appendChild(hostEl);
        hostEl.style.cssText = `
          position: fixed !important;
          bottom: 80px !important;
          right: 20px !important;
          width: 380px !important;
          max-width: calc(100vw - 40px) !important;
          max-height: calc(100vh - 140px) !important;
          z-index: 2147483646 !important;
          overflow: hidden !important;
          display: block !important;
        `;
        panel.style.width = "100%";
        panel.style.maxHeight = "100%";
        LOG("Panel: detached element, mounted floating");
      } else {
        hostEl.style.cssText = "display: block; margin-top: 12px;";
        panel.style.marginTop = "0";
        element.parentNode.insertBefore(hostEl, element.nextSibling);
        LOG("Panel injected inside Shadow DOM, inline under composition");
      }
    }

    const closeBtn = shadow.getElementById("evigrade-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        hostEl.style.setProperty("display", "none", "important");
      });
    }

    // Compare button handler
    // Filter buttons: clicking on summary chips ("4 работает", "5 спорно",
    // "21 базовых") narrows the visible list to that group. Clicking the
    // active filter again clears it. Pure CSS-based filtering through
    // data-filter attribute on .evg-list.
    const filterBtns = shadow.querySelectorAll(".evg-filter-btn");
    const listEl = shadow.querySelector(".evg-list");
    if (filterBtns.length > 0 && listEl) {
      filterBtns.forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const f = btn.dataset.filter;
          const wasActive = btn.classList.contains("evg-filter-active");
          filterBtns.forEach((b) => b.classList.remove("evg-filter-active"));
          if (wasActive) {
            listEl.removeAttribute("data-filter");
          } else {
            btn.classList.add("evg-filter-active");
            listEl.setAttribute("data-filter", f);
          }
        });
      });
    }

    // Telemetry: click on an ingredient row → CTA out to evigrade.com.
    // Event delegation lives on the shadow root so we cover every row
    // without re-binding when the list is filtered or re-rendered.
    const panelStoreSlug = resolveStoreSlug(host);
    shadow.addEventListener("click", (ev) => {
      const row = ev.target?.closest?.("a.evg-row[data-slug]");
      if (!row) return;
      track("PANEL_CTA_CLICK", {
        store: panelStoreSlug,
        target: row.getAttribute("data-slug") || null,
      });
    });

    // Cross-promo для Evigrade Meds: показываем раз в N открытий плашки
    // под основными CTA. Локально по chrome.storage.local, без сетевых запросов.
    // Реальное число показов и кликов смотрим через PRO_CTA_CLICK с target=meds_ext.
    try {
      chrome.storage?.local?.get?.(["evgMedsPromoShown", "evgMedsPromoDismissed"], (st) => {
        const dismissed = st?.evgMedsPromoDismissed === true;
        const shown = Number(st?.evgMedsPromoShown) || 0;
        // Показываем каждое 5-е открытие плашки, пока юзер не закрыл явно
        if (dismissed) return;
        const shouldShow = shown % 5 === 0;
        chrome.storage.local.set({ evgMedsPromoShown: shown + 1 });
        if (!shouldShow) return;
        const promoUrl = "https://chromewebstore.google.com/detail/evigrade-meds/dgokdkflpnghjjogncpngfeflofmlnbm";
        const promoEl = document.createElement("div");
        promoEl.style.cssText = "background:#eff6ff;border:1px solid #bfdbfe;color:#1e3a8a;padding:8px 12px;margin:8px 12px;border-radius:6px;font-size:12px;display:flex;align-items:center;gap:8px;justify-content:space-between";
        promoEl.innerHTML = `<span>\u{1F48A} ${esc(t("panelMedsExtCta"))}</span><span style="display:flex;gap:6px"><a href="${promoUrl}" target="_blank" rel="noopener noreferrer" id="evg-meds-promo-link" style="color:#1d4ed8;text-decoration:underline;font-weight:600;white-space:nowrap">Install →</a><button id="evg-meds-promo-close" aria-label="close" style="background:transparent;border:0;cursor:pointer;color:#1e3a8a;font-size:14px;line-height:1;padding:0 4px">×</button></span>`;
        const summaryEl = shadow.querySelector(".evg-summary");
        if (summaryEl?.parentNode) summaryEl.parentNode.insertBefore(promoEl, summaryEl);
        promoEl.querySelector("#evg-meds-promo-link")?.addEventListener("click", () => {
          track("PRO_CTA_CLICK", { target: "meds_ext_promo" });
        });
        promoEl.querySelector("#evg-meds-promo-close")?.addEventListener("click", () => {
          chrome.storage.local.set({ evgMedsPromoDismissed: true });
          promoEl.remove();
        });
      });
    } catch (_e) {
      // chrome.storage недоступен в исключительных случаях; промо просто не покажется
    }

    const openSiteBtn = shadow.getElementById("evigrade-open-site-btn");
    if (openSiteBtn) {
      openSiteBtn.addEventListener("click", () => {
        const inci = Array.isArray(data._rawIngredients)
          ? data._rawIngredients
              .slice(0, 200)
              .map((s) => clampStr(s, 200))
              .join(", ")
          : "";
        if (!inci) return;
        const uiLoc = globalThis.evgI18n?.locale;
        const locale = uiLoc === "ru" ? "ru" : uiLoc === "es" ? "es" : "en";
        const url = `${SITE_URL}/${locale}/check?inci=${encodeURIComponent(inci)}&utm_source=ext&utm_medium=panel&utm_campaign=open_on_site`;
        track("PANEL_CTA_CLICK", { target: "open_on_site" });
        window.open(url, "_blank", "noopener,noreferrer");
      });
    }

    const compareBtn = shadow.getElementById("evigrade-compare-btn");
    if (compareBtn) {
      // Check if already added
      loadCompareProducts().then((products) => {
        if (products.some((p) => p.url === location.href)) {
          compareBtn.textContent = t("panelAdded");
          compareBtn.classList.add("evg-added");
        }
      });

      compareBtn.addEventListener("click", async () => {
        if (compareBtn.classList.contains("evg-added")) return;

        const safeUrl = safeCurrentLocation();
        if (!safeUrl) return;

        const product = {
          name: clampStr(getProductName(), 200),
          url: safeUrl,
          ingredients: Array.isArray(data._rawIngredients)
            ? data._rawIngredients.slice(0, 200).map((s) => clampStr(s, 200))
            : [],
          ingredientCount: Number.isFinite(data._totalIngredients)
            ? Math.max(0, data._totalIngredients | 0)
            : 0,
          matches: data.matches
            .slice(0, 500)
            .map((m) => globalThis.evgContract.sanitizeMatchedIngredient(m))
            .filter(Boolean),
          warnings: Array.isArray(data.warnings) ? data.warnings.slice(0, 50) : [],
          unknown: Array.isArray(data.unknown)
            ? data.unknown.slice(0, 500).map((s) => clampStr(s, 200))
            : [],
          addedAt: Date.now(),
        };

        const ok = await addToCompare(product);
        if (ok) {
          compareBtn.textContent = t("panelAdded");
          compareBtn.classList.add("evg-added");
        } else {
          compareBtn.textContent = t("panelMaxCompare");
          setTimeout(() => {
            compareBtn.textContent = t("panelAddCompare");
          }, 2000);
        }
      });
    }
  }

  // Composite warning rendering – covers pilling + surfactant harshness tiers
  function getCompositeWarningMeta() {
    return {
      pilling: {
        icon: "\u{1F9FD}",
        bg: "#fffbeb",
        borderColor: "#fde68a",
        titleColor: "#92400e",
        hint: t("pillingHint"),
      },
      "surfactant-harsh": {
        icon: "\u{1F9FC}",
        bg: "#fef2f2",
        borderColor: "#fecaca",
        titleColor: "#991b1b",
        hint: t("surfactantHarshHint"),
      },
      "surfactant-mixed": {
        icon: "\u{1F9FC}",
        bg: "#fffbeb",
        borderColor: "#fde68a",
        titleColor: "#92400e",
        hint: t("surfactantMixedHint"),
      },
      "surfactant-moderate": {
        icon: "\u{1F9FC}",
        bg: "#fffbeb",
        borderColor: "#fde68a",
        titleColor: "#92400e",
        hint: t("surfactantModerateHint"),
      },
      "surfactant-gentle": {
        icon: "\u{1F9FC}",
        bg: "#ecfdf5",
        borderColor: "#a7f3d0",
        titleColor: "#166534",
        hint: t("surfactantGentleHint"),
      },
      "formaldehyde-multi": {
        icon: "\u2697",
        bg: "#eef2ff",
        borderColor: "#c7d2fe",
        titleColor: "#3730a3",
        hint: t("formaldehydeMultiHint"),
      },
      "nitrosamine-risk": {
        icon: "\u26a0",
        bg: "#fff1f2",
        borderColor: "#fecdd3",
        titleColor: "#9f1239",
        hint: t("nitrosamineRiskHint"),
      },
    };
  }

  // \u0421\u0435\u0440\u0432\u0435\u0440 \u0448\u043B\u0435\u0442 message \u0438 details \u043D\u0430 \u0440\u0443\u0441\u0441\u043A\u043E\u043C (\u0438\u0441\u0442\u043E\u0440\u0438\u0447\u0435\u0441\u043A\u0438). \u041B\u043E\u043A\u0430\u043B\u0438\u0437\u0443\u0435\u043C \u043D\u0430 \u043A\u043B\u0438\u0435\u043D\u0442\u0435,
  // \u0447\u0442\u043E\u0431\u044B ES/EN \u043D\u0435 \u0432\u0438\u0434\u0435\u043B\u0438 "\u0420\u0438\u0441\u043A \u0441\u043A\u0430\u0442\u044B\u0432\u0430\u043D\u0438\u044F" \u0438 \u043A\u0438\u0440\u0438\u043B\u043B\u0438\u0447\u0435\u0441\u043A\u0438\u0435 \u043D\u0435\u0439\u043C\u0438\u043D\u0433\u0438 \u0438\u043D\u0433\u0440\u0435\u0434\u0438\u0435\u043D\u0442\u043E\u0432.
  function localizeCompositeTitle(w) {
    const byType = {
      pilling: "compositeTitlePilling",
      "surfactant-harsh": "compositeTitleSurfactantHarsh",
      "surfactant-mixed": "compositeTitleSurfactantMixed",
      "surfactant-moderate": "compositeTitleSurfactantModerate",
      "formaldehyde-multi": "compositeTitleFormaldehydeMulti",
      "nitrosamine-risk": "compositeTitleNitrosamineRisk",
    };
    let key = byType[w.type];
    if (w.type === "surfactant-gentle") {
      // API \u0448\u043B\u0435\u0442 \u0434\u0432\u0430 \u0432\u0430\u0440\u0438\u0430\u043D\u0442\u0430 \u043F\u043E\u0434 \u043E\u0434\u043D\u0438\u043C \u0442\u0438\u043F\u043E\u043C; \u0440\u0430\u0437\u043B\u0438\u0447\u0430\u0435\u043C \u043F\u043E \u043D\u0430\u0447\u0430\u043B\u0443 \u0441\u0442\u0440\u043E\u043A\u0438.
      key =
        typeof w.message === "string" && w.message.startsWith("\u041E\u0447\u0435\u043D\u044C")
          ? "compositeTitleSurfactantGentleUltra"
          : "compositeTitleSurfactantGentle";
    }
    if (!key) return w.message;
    const translated = t(key);
    return translated && translated !== key ? translated : w.message;
  }

  function localizeCompositeDetails(details, matches) {
    if (!Array.isArray(details) || details.length === 0) return details;
    const loc = globalThis.evgI18n?.locale;
    if (loc === "ru" || !Array.isArray(matches)) return details;
    const byNameRu = new Map();
    for (const m of matches) {
      if (m && typeof m.nameRu === "string") byNameRu.set(m.nameRu, m);
    }
    return details.map((nameRu) => {
      const m = byNameRu.get(nameRu);
      if (!m) return nameRu;
      if (loc === "es" && m.nameEs) return m.nameEs;
      if (loc === "en" && m.nameEn) return m.nameEn;
      return m.nameRu || nameRu;
    });
  }

  function renderCompositeWarning(w, matches) {
    const COMPOSITE_WARNING_META = getCompositeWarningMeta();
    const meta = COMPOSITE_WARNING_META[w.type] || {
      icon: "\u26A0",
      bg: "#fffbeb",
      borderColor: "#fde68a",
      titleColor: "#92400e",
      hint: null,
    };
    const title = localizeCompositeTitle(w);
    const details = localizeCompositeDetails(w.details, matches);
    return `
      <div class="evg-composite-warning" style="background:${meta.bg};border-bottom-color:${meta.borderColor}">
        <span class="evg-composite-icon">${meta.icon}</span>
        <div class="evg-composite-text">
          <div class="evg-composite-title" style="color:${meta.titleColor}">${esc(title)}</div>
          ${details && details.length > 0 ? `<div class="evg-composite-details">${esc(t("compositeContains"))} ${details.map(esc).join(", ")}</div>` : ""}
          ${meta.hint ? `<div class="evg-composite-details" style="color:${meta.titleColor};opacity:0.85">${esc(meta.hint)}</div>` : ""}
        </div>
      </div>
    `;
  }

  // Surfactant harshness chip for per-ingredient display.
  // Лениво: locale грузится async, иначе на EN/ES увидим RU-метки.
  function getSurfactantMeta() {
    return {
      ULTRA_MILD: { label: t("surfUltraMild"), bg: "#dcfce7", color: "#166534" },
      MILD: { label: t("surfMild"), bg: "#ecfdf5", color: "#047857" },
      MODERATE: { label: t("surfModerate"), bg: "#fef3c7", color: "#92400e" },
      HARSH: { label: t("surfHarsh"), bg: "#fee2e2", color: "#991b1b" },
    };
  }

  function renderSurfactantChip(harshness) {
    if (!harshness) return "";
    const meta = getSurfactantMeta()[harshness];
    if (!meta) return "";
    return `<span class="evg-gen-chip" style="background:${meta.bg};color:${meta.color}" title="${esc(t("surfTitlePrefix"))}: ${esc(meta.label)}"><span>\u{1F9FC}</span><span>${esc(meta.label)}</span></span>`;
  }

  function renderRow(m, _totalIngredients, _onePctLine) {
    const dotHtml = m.isFunctional
      ? `<span class="evg-tl-fn" title="${esc(t("auxIngredient"))}"></span>`
      : `<span class="evg-tl" style="background:${tlDotColor(m.trafficLight)}" title="${tlTooltip(m.trafficLight)}"></span>`;

    const warn = m.positionWarning
      ? `<div class="evg-warning-text">\u26a0 ${esc(m.positionWarning)}</div>`
      : "";

    const genChip = renderGenerationChip(m.filterGeneration);
    const surfChip = renderSurfactantChip(m.surfactantHarshness);

    const badgeMap = getBadges();
    const badges = (m.riskBadges || [])
      .map((key) => {
        const b = badgeMap[key];
        if (!b) return "";
        return `<span class="evg-badge" style="background:${b.color}" title="${esc(b.title)}">${esc(b.letter)}</span>`;
      })
      .join("");

    const badgesHtml = badges ? `<span class="evg-badges">${badges}</span>` : "";

    // Blacklist badge
    const blHits = m._blacklistHits || [];
    let blBadgeHtml = "";
    if (blHits.length > 0) {
      const labels = blHits.map((h) =>
        h.type === "allergen"
          ? t("blAllergenForYou")
          : h.type === "comedogenic"
            ? t("blComedogenicForYou")
            : t("blAvoidForYou"),
      );
      blBadgeHtml = `<div class="evg-bl-badge">\u26a0 ${labels.join(", ")}</div>`;
    }

    const rowClasses = ["evg-row"];
    if (m.positionWarning) rowClasses.push("evg-warn");
    if (m.isFunctional) rowClasses.push("evg-functional");
    if (blHits.length > 0) rowClasses.push("evg-blacklisted");

    let tlGroup = "functional";
    if (!m.isFunctional) {
      if (m.trafficLight === "GREEN") tlGroup = "green";
      else if (m.trafficLight === "YELLOW") tlGroup = "yellow";
      else if (m.trafficLight === "RED") tlGroup = "red";
      else if (m.trafficLight === "PRESCRIPTION") tlGroup = "prescription";
      else tlGroup = "unknown";
    }

    const catChip = categoryChip(m);
    // Pro-фича оценки концентрации временно убрана из UI: minEffectivePct
    // заполнен в БД точечно (1-2 ингредиента из 8), и chip «работает»
    // у одного из восьми зелёных создавал когнитивный диссонанс.
    // Вернуть когда наберём 200+ ингредиентов с minEffectivePct.

    return `<a class="${esc(rowClasses.join(" "))}" data-tl="${tlGroup}" data-slug="${esc(m.slug || "")}" href="${esc(safeSiteUrl(m.url))}" target="_blank" rel="noopener noreferrer">
      ${dotHtml}
      <div class="evg-info">
        <div class="evg-name">${esc(primaryName(m))}${genChip}${surfChip}</div>
        ${secondaryName(m) ? `<div class="evg-name-en">${esc(secondaryName(m))}</div>` : ""}
        ${blBadgeHtml}
        ${warn}
      </div>
      ${catChip}
      ${badgesHtml}
    </a>`;
  }

  // Returns one-word ingredient role chip for inline display next to the name.
  // Reads from categories array (first match wins) or falls back to a generic
  // functional label. Keeps the panel from being a black-box of "green/yellow"
  // dots without explanation.
  function categoryChip(m) {
    if (m.isFunctional) {
      return `<span class="evg-cat-chip evg-cat-functional">${esc(t("catFunctional"))}</span>`;
    }
    const cats = m.categories || [];
    const priority = [
      "ANTI_AGING",
      "BRIGHTENING",
      "BARRIER_REPAIR",
      "MOISTURIZING",
      "ACNE",
      "PROTECTION",
      "SOOTHING",
    ];
    let pick = null;
    for (const p of priority)
      if (cats.includes(p)) {
        pick = p;
        break;
      }
    if (!pick && cats.length > 0) pick = cats[0];
    if (!pick) return "";
    const map = {
      ANTI_AGING: ["catAntiAging", "#fce7f3", "#9d174d"],
      BRIGHTENING: ["catBrightening", "#fef3c7", "#92400e"],
      BARRIER_REPAIR: ["catBarrier", "#dcfce7", "#166534"],
      MOISTURIZING: ["catMoisturizing", "#dbeafe", "#1e40af"],
      ACNE: ["catAcne", "#fee2e2", "#991b1b"],
      PROTECTION: ["catProtection", "#cffafe", "#155e75"],
      SOOTHING: ["catSoothing", "#f3e8ff", "#6b21a8"],
    };
    const entry = map[pick];
    if (!entry) return "";
    return `<span class="evg-cat-chip" style="background:${entry[1]};color:${entry[2]}">${esc(t(entry[0]))}</span>`;
  }

  // ============================================================
  // CONCENTRATION ESTIMATE (Pro feature)
  // ============================================================
  // Оценка концентрации актива по позиции в INCI. По правилам EU 1223/2009
  // ингредиенты идут в порядке убывания концентрации; ингредиенты <1% могут
  // идти в любом порядке. "1%-линия" определяется по первому маркеру –
  // ингредиенту, чья типичная концентрация известна и не превышает 1%.
  // Всё, что стоит ПОСЛЕ маркера, гарантированно <1%.

  const ONE_PCT_MARKERS = new Set([
    // pH регуляторы (≤0.5%)
    "sodium-hydroxide",
    "citric-acid",
    "sodium-citrate",
    "tromethamine",
    // Хелаторы (≤0.5%)
    "disodium-edta",
    "tetrasodium-edta",
    "sodium-polyaspartate",
    "trisodium-edta",
    // Консерванты (≤1%)
    "phenoxyethanol",
    "sodium-benzoate",
    "potassium-sorbate",
    "chlorphenesin",
    "dehydroacetic-acid",
    "benzyl-alcohol",
    "ethylhexylglycerin",
    // Загустители (обычно ≤0.5%)
    "carbomer",
    "xanthan-gum",
    "sclerotium-gum",
    "cellulose-gum",
    // Полимеры реологии (≤1%)
    "polyquaternium-51",
    "ammonium-acryloyldimethyltaurate-vp-copolymer",
    "hydroxyethyl-acrylate-sodium-acryloyldimethyl-taurate-copolymer",
    // Антиоксиданты формулы (≤0.5%)
    "bht",
    "bha",
    "tocopherol",
    // EU-обязательно-маркируемые аллергены (>0.001% надо указывать,
    // обычно 0.01-0.5% – их позиция надёжно ниже 1%-линии)
    "limonene",
    "linalool",
    "citronellol",
    "geraniol",
    "citral",
    "eugenol",
    "isoeugenol",
    "farnesol",
    "coumarin",
    "amyl-cinnamal",
    "hexyl-cinnamal",
    "cinnamal",
    "cinnamyl-alcohol",
    "anise-alcohol",
    "hydroxycitronellal",
    "benzyl-salicylate",
    "benzyl-benzoate",
    "alpha-isomethyl-ionone",
    // Парфюм
    "fragrance-parfum",
  ]);

  // Возвращает позицию (0-based) первого маркера 1%-линии в составе.
  // Если маркеров нет, возвращает Infinity (1%-линия неопределена).
  function findOnePctLine(matches) {
    let min = Number.POSITIVE_INFINITY;
    for (const m of matches) {
      if (!ONE_PCT_MARKERS.has(m.slug)) continue;
      if (typeof m.position !== "number") continue;
      if (m.position < min) min = m.position;
    }
    return min;
  }

  // 'effective' / 'borderline' / 'decorative' / 'unknown'
  function estimateConcentration(m, onePctLine) {
    if (m.minEffectivePct == null) return "unknown";
    if (m.isFunctional) return "unknown";
    if (typeof m.position !== "number") return "unknown";

    const pos = m.position;
    const minPct = m.minEffectivePct;

    // ПОСЛЕ 1%-линии – почти наверняка <1%
    if (Number.isFinite(onePctLine) && pos >= onePctLine) {
      if (minPct >= 1) return "decorative";
      if (minPct >= 0.1) return "borderline";
      return "effective"; // мин < 0.1%, например пептиды – даже глубоко работают
    }

    // В первых 5 позициях – высокая концентрация
    if (pos < 5) return "effective";

    // 5-10 позиций без маркера 1%-линии – грубо 1-5%
    if (pos < 10) {
      if (minPct <= 2) return "effective";
      if (minPct <= 5) return "borderline";
      return "decorative";
    }

    // Глубже 10 – почти точно <1-2%
    if (minPct >= 5) return "decorative";
    if (minPct >= 1) return "borderline";
    return "effective";
  }

  // True если хотя бы у одного ингредиента в составе мы покажем concentration
  // chip – используется чтобы решить, стоит ли вообще показывать
  // disclaimer-плашку. Учитывает Pro-gating через concentrationBadge.
  function anyConcentrationBadge(matches, onePctLine) {
    for (const m of matches) {
      if (concentrationBadge(m, onePctLine)) return true;
    }
    return false;
  }

  // Pro-фича: для FREE возвращаем badge только при 'effective'
  // (позитивный сигнал). PRO/PROFI видят все варианты включая 'decorative'.
  function concentrationBadge(m, onePctLine) {
    const est = estimateConcentration(m, onePctLine);
    if (est === "unknown") return "";

    const isPro = auth.tier === "PRO" || auth.tier === "PROFI";

    // FREE: показываем только зелёный 'effective', без 'decorative' (это Pro-фича)
    if (!isPro && est !== "effective") return "";

    const minPct = m.minEffectivePct;
    const formatPct = (p) => (p < 1 ? `${p}%` : `${p}%`);

    if (est === "effective") {
      return `<span class="evg-conc-chip evg-conc-eff" title="${esc(t("concEffectiveTitle"))}">
        ✓ ${esc(t("concEffective"))}
      </span>`;
    }
    if (est === "borderline") {
      return `<span class="evg-conc-chip evg-conc-bord" title="${esc(t("concBorderlineTitle", formatPct(minPct)))}">
        ~${esc(t("concBorderline"))}
      </span>`;
    }
    // decorative
    return `<span class="evg-conc-chip evg-conc-dec" title="${esc(t("concDecorativeTitle", formatPct(minPct)))}">
      ⚠ ${esc(t("concDecorative"))}
    </span>`;
  }

  function getGenerationMeta() {
    return {
      MODERN: {
        icon: "\u2728",
        chipText: t("spfModern"),
        label: t("spfModernLong"),
        color: "#0891b2",
        bg: "#cffafe",
      },
      ESTABLISHED: {
        icon: "",
        chipText: "",
        label: t("spfClassicLong"),
        color: "#166534",
        bg: "#dcfce7",
      },
      LEGACY: {
        icon: "\u23F3",
        chipText: t("spfOutdated"),
        label: t("spfOutdatedLong"),
        color: "#92400e",
        bg: "#fef3c7",
      },
      DISCOURAGED: {
        icon: "\u26d4",
        chipText: t("spfAvoid"),
        label: t("spfAvoidLong"),
        color: "#991b1b",
        bg: "#fef2f2",
      },
    };
  }

  function renderGenerationChip(gen) {
    if (!gen) return "";
    const meta = getGenerationMeta()[gen];
    if (!meta || !meta.icon) return "";
    return `<span class="evg-gen-chip" style="background:${meta.bg};color:${meta.color}" title="${esc(meta.label)}"><span>${meta.icon}</span><span>${esc(meta.chipText)}</span></span>`;
  }

  function hasAnyGenerationFilter(matches) {
    return matches.some((m) => m.filterGeneration && m.filterGeneration !== "ESTABLISHED");
  }

  function hasAnySurfactant(matches) {
    return matches.some((m) => m.surfactantHarshness);
  }

  function findAdditionalCompositionElements(primaryEl) {
    const out = [];
    const seen = new Set();
    const candidates = document.querySelectorAll(
      ".mo-typography, [class*='wysiwyg'], [class*='wysiwyg'] p, [class*='cellValue'], dd, td, p, .prodOverviewIngred",
    );
    for (const el of candidates) {
      if (el === primaryEl) continue;
      if (primaryEl && (el.contains(primaryEl) || primaryEl.contains(el))) continue;
      const text = (el.textContent || "").trim();
      if (text.length < 30 || text.length > 5000) continue;
      if (!looksLikeInci(text)) continue;
      const key = text.slice(0, 120);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(el);
      if (out.length >= 8) break;
    }
    return out;
  }

  // biome-ignore lint/correctness/noUnusedVariables: overlay-detection helper, used by tooltip placement
  function isInsideOverlay(el) {
    let node = el;
    while (node && node !== document.body) {
      const style = window.getComputedStyle(node);
      const pos = style.position;
      const zIdx = Number.parseInt(style.zIndex, 10) || 0;
      const role = node.getAttribute?.("role");
      if (
        (pos === "fixed" || pos === "absolute") &&
        (zIdx > 100 || role === "dialog" || role === "modal")
      ) {
        return true;
      }
      if ((pos === "fixed" || pos === "absolute") && style.overflow === "auto") {
        return true;
      }
      node = node.parentElement;
    }
    return false;
  }

  function tlTooltip(tl) {
    if (tl === "GREEN") return t("tlGreenLong");
    if (tl === "YELLOW") return t("tlYellowLong");
    if (tl === "RED") return t("tlRed");
    if (tl === "PRESCRIPTION") return t("tlPrescription");
    return t("tlNoData");
  }

  function injectFloatingBadge(data, totalIngredients, _blacklist) {
    const existingBadge = document.getElementById("evigrade-badge");
    if (existingBadge) existingBadge.remove();

    const seenSlugs = new Set();
    const uniqueMatches = data.matches.filter((m) => {
      if (seenSlugs.has(m.slug)) return false;
      seenSlugs.add(m.slug);
      return true;
    });

    const counts = { green: 0, yellow: 0, red: 0, prescription: 0 };
    for (const m of uniqueMatches) {
      if (m.isFunctional) continue;
      if (m.trafficLight === "GREEN") counts.green++;
      else if (m.trafficLight === "YELLOW") counts.yellow++;
      else if (m.trafficLight === "RED") counts.red++;
    }

    // Count blacklist hits
    const blCount = uniqueMatches.filter(
      (m) => m._blacklistHits && m._blacklistHits.length > 0,
    ).length;

    const badge = document.createElement("div");
    badge.id = "evigrade-badge";
    badge.innerHTML = `
      <style>
        #evigrade-badge {
          position: fixed;
          bottom: 20px;
          right: 20px;
          z-index: 999999;
          background: ${blCount > 0 ? "#991b1b" : "#1a1a2e"};
          color: #fff;
          border-radius: 14px;
          padding: 10px 16px;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          font-size: 13px;
          box-shadow: 0 4px 20px rgba(0,0,0,0.25);
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 10px;
          transition: transform 0.2s;
        }
        #evigrade-badge:hover { transform: scale(1.03); }
        .evg-badge-logo {
          width: 24px; height: 24px;
          background: #2db5a3;
          color: #fff;
          font-family: Georgia, serif;
          font-weight: 900;
          font-size: 14px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 6px;
          flex-shrink: 0;
        }
        .evg-badge-counts {
          display: flex;
          gap: 8px;
          font-weight: 600;
        }
        .evg-badge-item {
          display: flex;
          align-items: center;
          gap: 3px;
        }
        .evg-badge-dot {
          width: 8px; height: 8px;
          border-radius: 50%;
        }
        .evg-badge-bl {
          font-size: 12px;
          font-weight: 700;
        }
      </style>
      <span class="evg-badge-logo">E</span>
      ${blCount > 0 ? `<span class="evg-badge-bl">\u26a0 ${esc(t("badgeBlSuffix", blCount))}</span>` : ""}
      <span class="evg-badge-counts">
        ${counts.green > 0 ? `<span class="evg-badge-item"><span class="evg-badge-dot" style="background:#16a34a"></span>${counts.green}</span>` : ""}
        ${counts.yellow > 0 ? `<span class="evg-badge-item"><span class="evg-badge-dot" style="background:#d97706"></span>${counts.yellow}</span>` : ""}
        ${counts.red > 0 ? `<span class="evg-badge-item"><span class="evg-badge-dot" style="background:#dc2626"></span>${counts.red}</span>` : ""}
        ${counts.prescription > 0 ? `<span class="evg-badge-item"><span class="evg-badge-dot" style="background:#6b21a8"></span>${counts.prescription}</span>` : ""}
      </span>
      <span style="font-size:11px;color:rgba(255,255,255,0.5)">${uniqueMatches.length}/${totalIngredients}</span>
    `;

    badge.addEventListener("click", () => {
      const host = document.getElementById("evigrade-panel-host");
      const panel = host || document.getElementById("evigrade-panel");
      if (!panel) return;
      const isFloating = window.getComputedStyle(panel).position === "fixed";
      if (isFloating) {
        const computedDisplay = window.getComputedStyle(panel).display;
        const isHidden = computedDisplay === "none";
        panel.style.setProperty("display", isHidden ? "flex" : "none", "important");
      } else {
        panel.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });

    document.body.appendChild(badge);
    LOG("Floating badge injected");
  }

  function esc(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function clampStr(s, max) {
    return String(s ?? "").slice(0, max);
  }

  function safeSiteUrl(path) {
    try {
      const u = new URL(String(path ?? ""), SITE_URL);
      if (u.origin !== SITE_URL) return SITE_URL;
      return u.toString();
    } catch {
      return SITE_URL;
    }
  }

  function safeCurrentLocation() {
    try {
      const u = new URL(location.href);
      if (u.protocol !== "https:" && u.protocol !== "http:") return "";
      return u.toString().slice(0, 1000);
    } catch {
      return "";
    }
  }

  // sanitizeMatch / sanitizeApiResponse moved to api-contract.js
  // (globalThis.evgContract.sanitizeMatchedIngredient / .sanitizeMatchResponse)

  // ============================================================
  // AUTO-RUN with observer
  // ============================================================

  const parser = getParser();
  if (!parser) return;

  // Direct analyze – no SPA-hydration gate. Used by tryAnalyzeWhenStable() and
  // by the URL-change handler, which already wait for the new DOM to settle.
  // No analyzed-flag gate here: analyze() itself bails on a duplicate
  // fingerprint, so calling parser() again when the DOM changed is cheap-ish
  // and lets us catch lazy-mounted ingredient blocks on slow sites (Boots,
  // dm.at, occasional Notino/Douglas).
  let lastScanAt = 0;
  function tryAnalyzeNow() {
    const now = Date.now();
    if (now - lastScanAt < 1200) return; // throttle
    lastScanAt = now;
    const result = parser();
    if (result) {
      LOG("Found ingredients:", result.text.slice(0, 100), "...");
      analyze(result);
    }
  }

  // Gated analyze – called by the global mutation observer and click handler.
  // While the SPA is swapping product DOM, the previous product's ingredient
  // block is still attached and would otherwise be analyzed before the new one
  // arrives, locking us onto stale data. We no longer skip on `analyzed` so
  // late-loading content can still be picked up; analyze() dedupes by
  // fingerprint to keep the UI quiet when nothing meaningful changed.
  function tryAnalyze() {
    if (Date.now() - urlChangedAt < 1500) return;
    tryAnalyzeNow();
  }

  // SPA-safe analyze trigger: wait for the DOM to stop mutating for `quietMs`
  // before scanning, so we don't capture a half-hydrated page that still
  // contains the previous product's text. Hard cap via `maxMs`.
  let stabilityObserver = null;
  let stabilityTimer = null;
  function tryAnalyzeWhenStable(quietMs = 1500, maxMs = 6000) {
    if (analyzed) return;
    if (stabilityObserver) stabilityObserver.disconnect();
    if (stabilityTimer) clearTimeout(stabilityTimer);
    const start = Date.now();
    const fire = () => {
      if (stabilityObserver) stabilityObserver.disconnect();
      stabilityObserver = null;
      if (stabilityTimer) clearTimeout(stabilityTimer);
      stabilityTimer = null;
      tryAnalyzeNow();
    };
    const tick = () => {
      if (stabilityTimer) clearTimeout(stabilityTimer);
      if (Date.now() - start > maxMs) {
        fire();
        return;
      }
      stabilityTimer = setTimeout(fire, quietMs);
    };
    stabilityObserver = new MutationObserver(tick);
    stabilityObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    tick();
  }

  // Initial scan: wait up to 8s for DOM to settle. Sites like Lookfantastic
  // and Notino lazy-mount their ingredient accordions well past document_idle;
  // a shorter window locks us in on whatever rendered first.
  tryAnalyzeWhenStable(1500, 8000);

  const observer = new MutationObserver(() => {
    // Catch SPA URL swaps before we analyze – pushState() doesn't fire any
    // event we can listen to from a content script, so this is the fastest
    // hook in practice.
    checkUrlChange();
    tryAnalyze();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  });

  // Words that, when found on a clicked toggle, signal the user is opening an
  // ingredient-section accordion (Rossmann, dm, Sephora, Ulta, etc.) and we
  // should force a re-scan even if we already analyzed something else earlier.
  const INGREDIENT_TOGGLE_RE =
    /(?:^|\b)(ingredient|inhaltsstoff|состав|ингредиент|složení|skład|sk[ł]adnik|inci|inhaltstoffe|ingredienti|ingr[ée]dient|ingredientes)/i;

  document.addEventListener(
    "click",
    (ev) => {
      // Re-check URL right away: clicking a product link updates location.href
      // synchronously on most SPAs (pushState happens in the click handler).
      setTimeout(checkUrlChange, 0);
      setTimeout(tryAnalyze, 300);
      setTimeout(tryAnalyze, 800);
      setTimeout(tryAnalyze, 1500);

      // If the user clicked a button/header that looks like an "open
      // ingredients" toggle, force a re-scan even when we already analyzed
      // some content earlier. Otherwise sites with an initial garbage block
      // (or a lazy-mounted accordion that appeared after our first try) stay
      // stuck on the wrong scan until the user opens the popup.
      const toggle =
        ev.target?.closest?.("button, summary, h2, h3, [role='button'], a") ?? ev.target;
      const toggleText = (toggle?.textContent || "").trim().slice(0, 80);
      if (toggleText && INGREDIENT_TOGGLE_RE.test(toggleText)) {
        analyzed = false;
        lastAnalyzedKey = "";
        setTimeout(() => tryAnalyzeWhenStable(800, 5000), 200);
        return;
      }

      // Sephora-style accordions lazy-fetch the ingredient block well after
      // the click (>1.5 s). If we haven't analyzed by then, fall back to a
      // stability-gated scan that waits up to 5 s for the new DOM to settle.
      setTimeout(() => {
        if (!analyzed) tryAnalyzeWhenStable(800, 5000);
      }, 2000);
    },
    true,
  );

  let lastUrl = location.href;
  function checkUrlChange() {
    if (location.href !== lastUrl) {
      LOG("URL changed:", lastUrl, "\u2192", location.href);
      lastUrl = location.href;
      urlChangedAt = Date.now();

      analyzed = false;
      lastAnalyzedKey = "";

      const oldHost = document.getElementById("evigrade-panel-host");
      if (oldHost) oldHost.remove();
      const oldPanel = document.getElementById("evigrade-panel");
      if (oldPanel) oldPanel.remove();
      const oldBadge = document.getElementById("evigrade-badge");
      if (oldBadge) oldBadge.remove();

      for (const el of document.querySelectorAll(".evg-hl")) {
        el.replaceWith(el.textContent);
      }

      // SPA navigation: wait for new product DOM to settle before scanning.
      tryAnalyzeWhenStable(1500, 10000);
    }
  }

  // 250ms is fast enough to beat most SPA mutation bursts, while still cheap.
  setInterval(checkUrlChange, 250);

  window.addEventListener("popstate", () => {
    setTimeout(checkUrlChange, 0);
  });

  // Listen for blacklist updates from popup
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!sender || sender.id !== chrome.runtime.id) return;
    if (!msg || typeof msg !== "object") return;
    if (msg.action === "parseIngredients") {
      const result = parser();
      sendResponse({ ingredients: result ? splitIngredients(result.text) : null });
    }
    if (msg.action === "getStatus") {
      sendResponse({ analyzed });
    }
    if (msg.action === "blacklistUpdated" || msg.action === "healthFiltersChanged") {
      // Re-analyze with new blacklist or pregnancy/lactation toggle state
      if (analyzed) {
        analyzed = false;
        lastAnalyzedKey = "";
        const oldHost = document.getElementById("evigrade-panel-host");
        if (oldHost) oldHost.remove();
        const oldPanel = document.getElementById("evigrade-panel");
        if (oldPanel) oldPanel.remove();
        const oldBadge = document.getElementById("evigrade-badge");
        if (oldBadge) oldBadge.remove();
        tryAnalyzeNow();
      }
    }
    return true;
  });
})();
