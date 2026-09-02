/**
 * Comparison page for Evigrade.
 * Shows side-by-side ingredient analysis of 2-5 products
 * with concentration estimation based on INCI position.
 */

const COMPARE_KEY = "evigrade_compare";
const BLACKLIST_KEY = "evigrade_blacklist";
// Единый источник правды – api-contract.js. Меняем там, читаем здесь.
const SITE_URL = globalThis.evgContract?.SITE_URL || "https://evigrade.vercel.app";

const PRODUCT_COLORS = ["#2db5a3", "#6366f1", "#f59e0b", "#ec4899", "#8b5cf6"];

// Locale: stored preference wins; otherwise fall back to browser UI lang.
let LOCALE = "en";
const t = (key, ...args) =>
  typeof globalThis.evgI18n === "object" ? globalThis.evgI18n.t(key, ...args) : key;

async function bootstrapLocale() {
  if (typeof globalThis.evgI18n !== "object") return;
  let ui = "";
  try {
    ui = chrome.i18n.getUILanguage() || "";
  } catch {}
  LOCALE = await globalThis.evgI18n.initAsync({ uiLang: ui });
  globalThis.evgI18n.apply(document);
  if (document.documentElement) document.documentElement.lang = LOCALE;
  globalThis.evgI18n.watchStorage();
  globalThis.evgI18n.onChange((next) => {
    LOCALE = next;
    if (document.documentElement) document.documentElement.lang = next;
    globalThis.evgI18n.apply(document);
    try {
      if (typeof render === "function") render();
    } catch {}
  });
}
bootstrapLocale();

// ============================================================
// CONCENTRATION ESTIMATION
// ============================================================

/**
 * Estimate approximate concentration based on INCI position.
 *
 * INCI regulation (EU 1223/2009, FDA 21 CFR 701.3):
 *   Ingredients above 1% must be listed in descending order of concentration.
 *   Below 1%, order is arbitrary.
 *
 * We use a harmonic decay model:
 *   - Position 1 (usually water): 30-80%
 *   - Positions 2-5: roughly 5-15% each
 *   - Positions 6-12: roughly 1-5%
 *   - After ~35% of total count: likely <1%
 */
function estimateConcentration(position, totalIngredients) {
  if (position <= 0 || totalIngredients <= 0) return null;

  // Water/Aqua is almost always #1 at 60-80%
  if (position === 1) {
    return { min: 30, max: 80, mid: 55, label: "30\u201380%" };
  }

  // Remaining ~45% distributed among rest using harmonic model
  const remaining = 45;
  const _n = totalIngredients - 1;

  let harmonicSum = 0;
  for (let i = 2; i <= totalIngredients; i++) {
    harmonicSum += 1 / i;
  }

  const raw = (remaining / harmonicSum) * (1 / position);

  // Breakpoint: after this position, ingredients are likely <1%
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
    min = 0.01;
    max = 1.0;
  }

  min = Math.round(min * 10) / 10;
  max = Math.round(max * 10) / 10;
  if (min >= max) max = min + 0.5;

  const mid = (min + max) / 2;

  let label;
  if (max <= 0.1) label = "<0.1%";
  else if (max <= 1) label = "<1%";
  else if (min < 1) label = `${min}\u2013${max}%`;
  else label = `~${Math.round(mid)}%`;

  return { min, max, mid, label };
}

// ============================================================
// DATA LOADING
// ============================================================

async function loadProducts() {
  const data = await chrome.storage.local.get(COMPARE_KEY);
  return sanitizeProducts(data[COMPARE_KEY]);
}

async function loadBlacklist() {
  try {
    const data = await chrome.storage.sync.get(BLACKLIST_KEY);
    return sanitizeBlacklist(data[BLACKLIST_KEY]);
  } catch {
    return { allergens: [], comedogenic: [], avoid: [] };
  }
}

function checkBlacklist(name, blacklist) {
  const lower = name.toLowerCase().trim();
  const hits = [];
  for (const n of blacklist.allergens) {
    if (
      lower === n.toLowerCase() ||
      lower.includes(n.toLowerCase()) ||
      n.toLowerCase().includes(lower)
    ) {
      hits.push("allergen");
    }
  }
  for (const n of blacklist.comedogenic) {
    if (
      lower === n.toLowerCase() ||
      lower.includes(n.toLowerCase()) ||
      n.toLowerCase().includes(lower)
    ) {
      hits.push("comedogenic");
    }
  }
  for (const n of blacklist.avoid) {
    if (
      lower === n.toLowerCase() ||
      lower.includes(n.toLowerCase()) ||
      n.toLowerCase().includes(lower)
    ) {
      hits.push("avoid");
    }
  }
  return hits;
}

function tlDotColor(tl) {
  if (tl === "GREEN") return "#16a34a";
  if (tl === "YELLOW") return "#d97706";
  if (tl === "RED") return "#dc2626";
  if (tl === "PRESCRIPTION") return "#6b21a8";
  return "#d1d5db";
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

function safeExternalUrl(u) {
  try {
    const p = new URL(String(u));
    if (p.protocol !== "https:" && p.protocol !== "http:") return "about:blank";
    return p.toString();
  } catch {
    return "about:blank";
  }
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

function sanitizeProducts(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const p of arr) {
    if (!p || typeof p !== "object") continue;
    if (!/^https?:\/\//i.test(String(p.url || ""))) continue;
    out.push({
      name: clampStr(p.name, 200),
      url: clampStr(p.url, 1000),
      ingredientCount: Number.isFinite(p.ingredientCount)
        ? Math.max(0, Math.min(1000, p.ingredientCount | 0))
        : 0,
      matches: Array.isArray(p.matches)
        ? p.matches
            .slice(0, 500)
            .map((m) => globalThis.evgContract?.sanitizeMatchedIngredient(m))
            .filter((m) => m !== null && m !== undefined)
        : [],
      warnings: Array.isArray(p.warnings)
        ? p.warnings
            .slice(0, 50)
            .filter((w) => w && typeof w === "object")
            .map((w) => ({
              type: clampStr(w.type, 50),
              message: clampStr(w.message, 300),
              details: Array.isArray(w.details)
                ? w.details.slice(0, 20).map((s) => clampStr(s, 100))
                : [],
            }))
        : [],
      unknown: Array.isArray(p.unknown) ? p.unknown.slice(0, 500) : [],
      addedAt: Number.isFinite(p.addedAt) ? p.addedAt : Date.now(),
    });
    if (out.length >= 5) break;
  }
  return out;
}

function sanitizeBlacklist(bl) {
  const safe = { allergens: [], comedogenic: [], avoid: [] };
  if (!bl || typeof bl !== "object") return safe;
  for (const cat of ["allergens", "comedogenic", "avoid"]) {
    if (Array.isArray(bl[cat])) {
      for (const raw of bl[cat]) {
        if (typeof raw !== "string") continue;
        const v = raw.trim().slice(0, 80);
        if (v) safe[cat].push(v);
        if (safe[cat].length >= 100) break;
      }
    }
  }
  return safe;
}

// ============================================================
// RENDER
// ============================================================

async function render() {
  const products = await loadProducts();
  const blacklist = await loadBlacklist();

  if (products.length < 2) {
    document.getElementById("empty").style.display = "block";
    document.getElementById("compare-root").style.display = "none";
    return;
  }

  document.getElementById("empty").style.display = "none";
  document.getElementById("compare-root").style.display = "block";

  // Build unified ingredient map: slug -> { nameRu, nameEn, trafficLight, products: { idx: { position, conc } } }
  const ingredientMap = new Map();

  products.forEach((product, pIdx) => {
    // Deduplicate matches by slug
    const seen = new Set();
    for (const m of product.matches) {
      if (seen.has(m.slug)) continue;
      seen.add(m.slug);

      if (!ingredientMap.has(m.slug)) {
        ingredientMap.set(m.slug, {
          slug: m.slug,
          nameRu: m.nameRu,
          nameEn: m.nameEn,
          trafficLight: m.trafficLight,
          isFunctional: m.isFunctional,
          categories: m.categories || [],
          riskBadges: m.riskBadges || [],
          url: m.url,
          products: {},
        });
      }

      const entry = ingredientMap.get(m.slug);
      const conc = estimateConcentration(m.position, product.ingredientCount);
      entry.products[pIdx] = {
        position: m.position,
        conc,
      };
    }
  });

  // 1. Product headers
  renderProductHeaders(products);

  // 2. Blacklist alert
  renderBlacklistAlert(products, ingredientMap, blacklist);

  // 3. Summary comparison
  renderSummary(products);

  // 3.5 Cleanser harshness (if any product contains surfactants)
  renderCleanserHarshness(products);

  // 4. Common active ingredients
  renderCommon(products, ingredientMap);

  // 5. Unique ingredients
  renderUnique(products, ingredientMap);

  // 6. Full table
  renderFullTable(products, ingredientMap, blacklist);
}

function renderProductHeaders(products) {
  const container = document.getElementById("product-headers");
  container.innerHTML = products
    .map((p, i) => {
      const counts = { green: 0, yellow: 0, red: 0 };
      const seen = new Set();
      for (const m of p.matches) {
        if (seen.has(m.slug) || m.isFunctional) continue;
        seen.add(m.slug);
        if (m.trafficLight === "GREEN") counts.green++;
        else if (m.trafficLight === "YELLOW") counts.yellow++;
        else if (m.trafficLight === "RED") counts.red++;
      }

      return `
      <div class="product-card border-${i + 1}">
        <div class="product-num pc-${i + 1}">${i + 1}</div>
        <div class="product-card-name"><a href="${esc(safeExternalUrl(p.url))}" target="_blank" rel="noopener noreferrer">${esc(p.name)}</a></div>
        <div class="product-card-count">${esc(t("compareIngredientCount", p.ingredientCount))}</div>
        <div class="product-card-summary">
          ${counts.green > 0 ? `<span class="pcs-item"><span class="pcs-dot" style="background:#16a34a"></span>${counts.green}</span>` : ""}
          ${counts.yellow > 0 ? `<span class="pcs-item"><span class="pcs-dot" style="background:#d97706"></span>${counts.yellow}</span>` : ""}
          ${counts.red > 0 ? `<span class="pcs-item"><span class="pcs-dot" style="background:#dc2626"></span>${counts.red}</span>` : ""}
        </div>
      </div>
    `;
    })
    .join("");
}

function renderBlacklistAlert(products, ingredientMap, blacklist) {
  const alert = document.getElementById("blacklist-alert");
  const allBl = blacklist.allergens.concat(blacklist.comedogenic, blacklist.avoid);
  if (allBl.length === 0) {
    alert.style.display = "none";
    return;
  }

  const findings = [];
  for (const [_slug, info] of ingredientMap) {
    const hits = checkBlacklist(info.nameRu, blacklist).concat(
      checkBlacklist(info.nameEn, blacklist),
    );
    const uniqueHits = [...new Set(hits)];
    if (uniqueHits.length === 0) continue;
    const inProducts = Object.keys(info.products).map((i) => Number.parseInt(i));
    findings.push({ nameRu: info.nameRu, hits: uniqueHits, inProducts });
  }

  if (findings.length === 0) {
    alert.style.display = "none";
    return;
  }

  alert.style.display = "block";
  alert.innerHTML = `
    <div class="bl-alert-title">${esc(t("compareBlAlertTitle"))}</div>
    ${findings
      .map((f) => {
        const labels = f.hits.map((h) =>
          h === "allergen"
            ? t("blAllergen")
            : h === "comedogenic"
              ? t("blComedogenic")
              : t("blAvoid"),
        );
        const prods = f.inProducts
          .map(
            (i) =>
              `<span style="color:${PRODUCT_COLORS[i]};font-weight:700">${esc(products[i].name.slice(0, 30))}</span>`,
          )
          .join(", ");
        return `<div class="bl-alert-item">${esc(f.nameRu)} (${labels.map(esc).join(", ")}) \u2014 ${prods}</div>`;
      })
      .join("")}
  `;
}

function getHarshnessTier() {
  return {
    ULTRA_MILD: {
      rank: 1,
      label: t("cleanserUltraMild"),
      icon: "\u{1F33F}",
      note: t("cleanserUltraMildNote"),
    },
    MILD: { rank: 2, label: t("cleanserMild"), icon: "\u{1F9FC}", note: t("cleanserMildNote") },
    MODERATE: {
      rank: 3,
      label: t("cleanserModerate"),
      icon: "\u26A0\uFE0F",
      note: t("cleanserModerateNote"),
    },
    HARSH: { rank: 4, label: t("cleanserHarsh"), icon: "\u{1F6A9}", note: t("cleanserHarshNote") },
  };
}

function renderCleanserHarshness(products) {
  const HARSHNESS_TIER = getHarshnessTier();
  const section = document.getElementById("section-cleanser");
  const grid = document.getElementById("cleanser-grid");

  // Find surfactants in each product (top-8 positions)
  const productsWithSurfactants = products.map((p) => {
    const seen = new Set();
    const surfactants = [];
    for (const m of p.matches) {
      if (seen.has(m.slug)) continue;
      seen.add(m.slug);
      if (m.surfactantHarshness && m.position <= 8) {
        surfactants.push(m);
      }
    }
    surfactants.sort((a, b) => a.position - b.position);
    return surfactants;
  });

  // If no product has any surfactant in top-8, hide the section
  if (productsWithSurfactants.every((s) => s.length === 0)) {
    section.style.display = "none";
    return;
  }

  section.style.display = "block";
  grid.innerHTML = products
    .map((p, i) => {
      const surfactants = productsWithSurfactants[i];

      if (surfactants.length === 0) {
        return `
        <div class="cleanser-card border-${i + 1}">
          <div class="cleanser-product-name">${esc(p.name)}</div>
          <div class="cleanser-verdict tier-NONE">
            <span class="cleanser-verdict-icon">\u2014</span>
            <span>${esc(t("cleanserNotApplicable"))}</span>
          </div>
          <div class="cleanser-note">${esc(t("cleanserNoSurfactants"))}</div>
        </div>
      `;
      }

      // Verdict = worst (harshest) tier present, UNLESS there are mild co-surfactants
      // buffering a harsh primary — then downgrade one tier to reflect real-world feel.
      const tiers = surfactants.map((s) => s.surfactantHarshness);
      const hasHarsh = tiers.includes("HARSH");
      const hasModerate = tiers.includes("MODERATE");
      const hasMild = tiers.includes("MILD") || tiers.includes("ULTRA_MILD");

      let verdictTier;
      if (hasHarsh && hasMild) verdictTier = "MODERATE";
      else if (hasHarsh) verdictTier = "HARSH";
      else if (hasModerate && hasMild) verdictTier = "MILD";
      else if (hasModerate) verdictTier = "MODERATE";
      else if (tiers.includes("MILD")) verdictTier = "MILD";
      else verdictTier = "ULTRA_MILD";

      const verdict = HARSHNESS_TIER[verdictTier];

      const items = surfactants
        .map((s) => {
          const tier = HARSHNESS_TIER[s.surfactantHarshness];
          return `
        <div class="cleanser-surf-item">
          <span class="cleanser-surf-dot tier-${s.surfactantHarshness}"></span>
          <span class="cleanser-surf-name">${esc(s.nameRu)}</span>
          <span class="cleanser-surf-pos">#${s.position} · ${esc(tier.label.toLowerCase())}</span>
        </div>
      `;
        })
        .join("");

      return `
      <div class="cleanser-card border-${i + 1}">
        <div class="cleanser-product-name">${esc(p.name)}</div>
        <div class="cleanser-verdict tier-${verdictTier}">
          <span class="cleanser-verdict-icon">${esc(verdict.icon)}</span>
          <span>${esc(verdict.label)}</span>
        </div>
        <div class="cleanser-surfactants">${items}</div>
        <div class="cleanser-note">${esc(verdict.note)}</div>
      </div>
    `;
    })
    .join("");
}

function renderSummary(products) {
  const grid = document.getElementById("summary-grid");

  // Compute per-product stats
  const stats = products.map((p) => {
    const seen = new Set();
    const counts = { green: 0, yellow: 0, red: 0, total: 0, functional: 0 };
    for (const m of p.matches) {
      if (seen.has(m.slug)) continue;
      seen.add(m.slug);
      if (m.isFunctional) {
        counts.functional++;
        continue;
      }
      counts.total++;
      if (m.trafficLight === "GREEN") counts.green++;
      else if (m.trafficLight === "YELLOW") counts.yellow++;
      else if (m.trafficLight === "RED") counts.red++;
    }
    // "score" = green ratio
    counts.greenRatio = counts.total > 0 ? Math.round((counts.green / counts.total) * 100) : 0;
    return counts;
  });

  const rows = [
    {
      label: t("summaryWorking"),
      values: stats.map((s) => s.green),
      color: "#16a34a",
      higher: true,
    },
    {
      label: t("summaryUncertain"),
      values: stats.map((s) => s.yellow),
      color: "#d97706",
      higher: false,
    },
    {
      label: t("summaryNotWorking"),
      values: stats.map((s) => s.red),
      color: "#dc2626",
      higher: false,
    },
    {
      label: t("summaryEffectivePct"),
      values: stats.map((s) => s.greenRatio),
      color: "#166534",
      higher: true,
      suffix: "%",
    },
  ];

  grid.innerHTML = rows
    .map((row) => {
      const best = row.higher ? Math.max(...row.values) : Math.min(...row.values);
      return `
      <div class="summary-row">
        <div class="summary-label">${esc(row.label)}</div>
        <div class="summary-cells">
          ${row.values
            .map((v, _i) => {
              const isBest = v === best && products.length > 1;
              return `<div class="summary-cell ${isBest ? "best" : ""}" style="color:${row.color}">${v}${row.suffix || ""}</div>`;
            })
            .join("")}
        </div>
      </div>
    `;
    })
    .join("");
}

function renderCommon(products, ingredientMap) {
  const section = document.getElementById("section-common");
  const table = document.getElementById("common-table");

  // Find ingredients present in 2+ products (non-functional only)
  const common = [];
  for (const [_slug, info] of ingredientMap) {
    if (info.isFunctional) continue;
    const presentIn = Object.keys(info.products).length;
    if (presentIn >= 2) {
      common.push(info);
    }
  }

  if (common.length === 0) {
    section.style.display = "none";
    return;
  }

  section.style.display = "block";

  // Sort by average position (most concentrated first)
  common.sort((a, b) => {
    const avgA = avg(Object.values(a.products).map((p) => p.position));
    const avgB = avg(Object.values(b.products).map((p) => p.position));
    return avgA - avgB;
  });

  table.innerHTML = common
    .map((info) => {
      // Find which product has highest concentration (lowest position)
      let bestIdx = -1;
      let bestPos = Number.POSITIVE_INFINITY;
      for (const [idx, pData] of Object.entries(info.products)) {
        if (pData.position < bestPos) {
          bestPos = pData.position;
          bestIdx = Number.parseInt(idx);
        }
      }

      // Max concentration for bar scaling
      const maxConc = Math.max(...Object.values(info.products).map((p) => p.conc?.mid || 0), 1);

      return `
      <div class="common-row">
        <div class="common-name">
          <span class="common-tl" style="background:${tlDotColor(info.trafficLight)};display:inline-block;width:10px;height:10px;border-radius:50%;margin-bottom:2px"></span>
          <div class="common-name-ru">${esc(info.nameRu)}</div>
          <div class="common-name-en">${esc(info.nameEn)}</div>
        </div>
        <div class="common-cells">
          ${products
            .map((_, i) => {
              const pData = info.products[i];
              if (!pData) {
                return `<div class="common-cell"><span class="cc-absent">\u2014</span></div>`;
              }
              const conc = pData.conc;
              const isHighest = i === bestIdx && Object.keys(info.products).length > 1;
              const barWidth = conc ? Math.max(5, Math.round((conc.mid / maxConc) * 100)) : 0;
              return `
              <div class="common-cell">
                <div class="cc-position">#${pData.position}</div>
                <div class="cc-conc ${isHighest ? "cc-higher" : "cc-lower"}">${conc ? conc.label : "?"}</div>
                <div class="cc-bar"><div class="cc-bar-fill" style="width:${barWidth}%;background:${PRODUCT_COLORS[i]}"></div></div>
              </div>
            `;
            })
            .join("")}
        </div>
      </div>
    `;
    })
    .join("");
}

function renderUnique(products, ingredientMap) {
  const section = document.getElementById("section-unique");
  const container = document.getElementById("unique-lists");

  const uniqueByProduct = products.map((_, pIdx) => {
    const unique = [];
    for (const [_slug, info] of ingredientMap) {
      if (info.isFunctional) continue;
      const presentIn = Object.keys(info.products);
      if (presentIn.length === 1 && presentIn[0] === String(pIdx)) {
        unique.push(info);
      }
    }
    return unique;
  });

  const hasAny = uniqueByProduct.some((u) => u.length > 0);
  if (!hasAny) {
    section.style.display = "none";
    return;
  }

  section.style.display = "block";

  container.innerHTML = uniqueByProduct
    .map((items, i) => {
      if (items.length === 0) return "";
      items.sort((a, b) => {
        const posA = a.products[i]?.position || 99;
        const posB = b.products[i]?.position || 99;
        return posA - posB;
      });
      return `
      <div class="unique-product">
        <div class="unique-header">
          <span class="product-num pc-${i + 1}" style="width:18px;height:18px;font-size:10px;display:inline-flex;align-items:center;justify-content:center;border-radius:50%;color:#fff">${i + 1}</span>
          ${esc(t("uniqueOnlyIn", products[i].name.slice(0, 40), items.length))}
        </div>
        <div class="unique-chips">
          ${items
            .map((info) => {
              const conc = info.products[i]?.conc;
              return `<span class="unique-chip">
              <span class="uc-dot" style="background:${tlDotColor(info.trafficLight)}"></span>
              ${esc(info.nameRu)}
              ${conc ? `<span style="color:#9ca3af;font-size:10px">${conc.label}</span>` : ""}
            </span>`;
            })
            .join("")}
        </div>
      </div>
    `;
    })
    .join("");
}

function renderFullTable(products, ingredientMap, blacklist) {
  const container = document.getElementById("full-table");

  // Collect all ingredients, sort by slug
  const allIngredients = [...ingredientMap.values()];

  // Sort: non-functional first, then by how many products contain it (desc), then by avg position
  allIngredients.sort((a, b) => {
    if (a.isFunctional !== b.isFunctional) return a.isFunctional ? 1 : -1;
    const countA = Object.keys(a.products).length;
    const countB = Object.keys(b.products).length;
    if (countB !== countA) return countB - countA;
    const avgA = avg(Object.values(a.products).map((p) => p.position));
    const avgB = avg(Object.values(b.products).map((p) => p.position));
    return avgA - avgB;
  });

  const headerCells = products
    .map(
      (p, i) =>
        `<th style="border-bottom:3px solid ${PRODUCT_COLORS[i]}">${esc(p.name.slice(0, 25))}</th>`,
    )
    .join("");

  const rows = allIngredients
    .map((info) => {
      const blHits = checkBlacklist(info.nameRu, blacklist).concat(
        checkBlacklist(info.nameEn, blacklist),
      );
      const isBlacklisted = blHits.length > 0;
      const blTag = isBlacklisted ? `<span class="ft-bl-tag">\u26a0</span>` : "";

      // Find best position across products
      let bestIdx = -1;
      let bestPos = Number.POSITIVE_INFINITY;
      for (const [idx, pData] of Object.entries(info.products)) {
        if (pData.position < bestPos) {
          bestPos = pData.position;
          bestIdx = Number.parseInt(idx);
        }
      }

      const cells = products
        .map((_, i) => {
          const pData = info.products[i];
          if (!pData) {
            return `<td><span class="ft-absent">\u2014</span></td>`;
          }
          const conc = pData.conc;
          const isBest = i === bestIdx && Object.keys(info.products).length > 1;
          return `<td>
        <span class="ft-conc ${isBest ? "ft-best" : ""}">${conc ? conc.label : "?"}</span>
        <span style="color:#9ca3af;font-size:10px;margin-left:4px">#${pData.position}</span>
      </td>`;
        })
        .join("");

      return `<tr class="${isBlacklisted ? "ft-blacklisted" : ""}">
      <td>
        <span class="ft-tl" style="background:${tlDotColor(info.trafficLight)}"></span>
        <a href="${esc(safeSiteUrl(info.url))}" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:none">${esc(info.nameRu)}</a>
        ${blTag}
        <div style="font-size:10px;color:#9ca3af">${esc(info.nameEn)}</div>
      </td>
      ${cells}
    </tr>`;
    })
    .join("");

  container.innerHTML = `
    <table class="full-table">
      <thead>
        <tr>
          <th>${esc(t("tableComponent"))}</th>
          ${headerCells}
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;
}

function avg(nums) {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

// Run
render();
