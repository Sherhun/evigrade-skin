/**
 * Mirror of src/contracts/extension-api.ts for the Chrome extension.
 *
 * The extension ships without a bundler so we keep this as plain MV3-compatible
 * JS. Single source of truth lives in TypeScript on the site; if you change
 * anything there, mirror it here. The CI script
 * scripts/check-extension-contract.mjs enforces version-constant parity.
 *
 * Loaded as:
 *   - <script src="api-contract.js"> in popup.html / compare.html / welcome.html
 *   - importScripts("api-contract.js") in background.js (MV3 service worker)
 *   - chrome.scripting.executeScript files: ["api-contract.js", ...] before
 *     content/parser.js
 *
 * After load, everything is reachable via `globalThis.evgContract`.
 */

(() => {
  const EXTENSION_API_VERSION = 1;
  const API_VERSION_HEADER = "X-Evigrade-API-Version";
  const MIN_KNOWN_VERSION = 1;
  const MAX_KNOWN_VERSION = 1;

  // Единственное место, где задаётся прод-URL для всех контекстов
  // расширения (popup, compare, content script, background). Раньше
  // дублировалось в трёх файлах – меняли один, забывали другой.
  // Cookie сессии NextAuth выставляется на www.evigrade.com, на vercel.app
  // браузер её не передаст cross-origin – Pro-юзер в popup увидит Free.
  const SITE_URL = "https://www.evigrade.com";

  // ============================================================
  // ENUMS (frozen Sets for O(1) membership checks)
  // ============================================================

  const TRAFFIC_LIGHTS = Object.freeze(new Set(["GREEN", "YELLOW", "RED", "PRESCRIPTION"]));
  const IRRITATION_LEVELS = Object.freeze(new Set(["LOW", "MEDIUM", "HIGH"]));
  const ALLERGEN_RISKS = Object.freeze(new Set(["LOW", "MEDIUM", "HIGH"]));
  const PREGNANCY_SAFETIES = Object.freeze(new Set(["SAFE", "CAUTION", "AVOID", "UNKNOWN"]));
  const LACTATION_SAFETIES = Object.freeze(new Set(["SAFE", "CAUTION", "AVOID", "UNKNOWN"]));
  const FILTER_GENERATIONS = Object.freeze(
    new Set(["MODERN", "ESTABLISHED", "LEGACY", "DISCOURAGED"]),
  );
  const SURFACTANT_HARSHNESSES = Object.freeze(
    new Set(["ULTRA_MILD", "MILD", "MODERATE", "HARSH"]),
  );
  const RISK_BADGES = Object.freeze(
    new Set(["allergen", "comedogenic", "pregnancy", "lactation", "irritation", "fabric-stain", "formaldehyde"]),
  );
  const SUBSCRIPTION_TIERS = Object.freeze(new Set(["FREE", "PRO", "PROFI"]));
  const SUBSCRIPTION_STATUSES = Object.freeze(
    new Set(["ACTIVE", "CANCELED", "PAST_DUE", "EXPIRED", "PENDING"]),
  );
  const BILLING_PROVIDERS = Object.freeze(new Set(["YOOKASSA", "LEMON_SQUEEZY"]));
  const BILLING_PERIODS = Object.freeze(new Set(["MONTHLY", "YEARLY"]));
  // Same taxonomy as ExtensionEventTypeSchema in src/contracts/extension-api.ts.
  // See that file for the per-bucket description.
  // Whitelisted event types. Mirrors ExtensionEventTypeSchema in
  // src/contracts/extension-api.ts — parity is enforced by
  // scripts/check-extension-contract.mjs in CI. The shared enum covers
  // both the cosmetic Evigrade extension and Evigrade Meds; this build
  // only ever fires its own subset, but it must know the full set so
  // the contract check passes.
  const EXTENSION_EVENT_TYPES = Object.freeze(
    new Set([
      "INSTALL",
      "UPDATE",
      "UNINSTALL_FEEDBACK",
      "HEARTBEAT",
      "WELCOME_OPENED",
      "WELCOME_CTA",
      "WELCOME_LEGAL_ACCEPTED",
      "WELCOME_HEALTH_TOGGLED",
      "POPUP_OPEN",
      "COMPARE_OPEN",
      "SCAN",
      "PANEL_SHOWN",
      "FAB_SHOWN",
      "MATCH_FOUND",
      "NO_MATCH",
      "PANEL_CTA_CLICK",
      "PRO_CTA_CLICK",
      "ADVERSE_REPORT_CLICK",
      "AUTH_LOGIN_CLICK",
      "WAITLIST_INTERACTIONS_CLICK",
      "WAITLIST_EMAIL_SUBMITTED",
      "LANG_SWITCH",
      "FILTERS_CHANGED",
      "HEALTH_PROFILE_CHANGED",
      "BLACKLIST_ADD",
      "ERROR",
    ]),
  );
  const EXTENSION_STORES = Object.freeze(
    new Set([
      "wildberries",
      "ozon",
      "iherb",
      "goldapple",
      "sephora",
      "ulta",
      "boots",
      "lookfantastic",
      "cultbeauty",
      "beautybay",
      "notino",
      "douglas",
      "dm",
      "rossmann",
      "druni",
      "primor",
      "maquillalia",
      "elcorteingles",
      "amazon",
      "vitaminshoppe",
      "test",
    ]),
  );
  const SEARCH_RESULT_TYPES = Object.freeze(
    new Set(["drug", "condition", "calculator", "ingredient", "nutrient"]),
  );
  const SEARCH_LOCALES = Object.freeze(new Set(["ru", "en"]));

  // ============================================================
  // JSDoc TYPEDEFS (IDE autocomplete, no runtime cost)
  // ============================================================

  /**
   * @typedef {"GREEN"|"YELLOW"|"RED"|"PRESCRIPTION"} TrafficLight
   * @typedef {"LOW"|"MEDIUM"|"HIGH"} IrritationLevel
   * @typedef {"LOW"|"MEDIUM"|"HIGH"} AllergenRisk
   * @typedef {"SAFE"|"CAUTION"|"AVOID"|"UNKNOWN"} PregnancySafety
   * @typedef {"MODERN"|"ESTABLISHED"|"LEGACY"|"DISCOURAGED"} FilterGeneration
   * @typedef {"ULTRA_MILD"|"MILD"|"MODERATE"|"HARSH"} SurfactantHarshness
   * @typedef {"allergen"|"comedogenic"|"pregnancy"|"irritation"} RiskBadge
   * @typedef {"FREE"|"PRO"|"PROFI"} SubscriptionTier
   * @typedef {"INSTALL"|"UPDATE"|"UNINSTALL_FEEDBACK"|"WELCOME_OPENED"|"WELCOME_CTA"|"POPUP_OPEN"|"COMPARE_OPEN"|"SCAN"|"PANEL_SHOWN"|"PANEL_CTA_CLICK"|"PRO_CTA_CLICK"|"AUTH_LOGIN_CLICK"|"LANG_SWITCH"|"FILTERS_CHANGED"|"BLACKLIST_ADD"|"ERROR"} ExtensionEventType
   * @typedef {"wildberries"|"ozon"|"iherb"|"goldapple"|"sephora"|"ulta"|"boots"|"lookfantastic"|"cultbeauty"|"beautybay"|"notino"|"douglas"|"dm"|"rossmann"|"druni"|"primor"|"maquillalia"|"elcorteingles"} ExtensionStore
   */

  /**
   * @typedef {Object} MatchedIngredient
   * @property {string} query
   * @property {number} position
   * @property {string} slug
   * @property {string} nameRu
   * @property {string} nameEn
   * @property {string|null} nameEs
   * @property {number|null} minEffectivePct
   * @property {TrafficLight|null} trafficLight
   * @property {boolean} isFunctional
   * @property {FilterGeneration|null} filterGeneration
   * @property {SurfactantHarshness|null} surfactantHarshness
   * @property {IrritationLevel} irritationLevel
   * @property {AllergenRisk} allergenRisk
   * @property {PregnancySafety} pregnancySafety
   * @property {PregnancySafety} lactationSafety
   * @property {number|null} comedogenic   Integer 0..5, or null when not assessed.
   * @property {string[]} categories
   * @property {string} url
   * @property {string|null} positionWarning
   * @property {RiskBadge[]} riskBadges
   */

  /**
   * @typedef {Object} MatchWarning
   * @property {string} type
   * @property {string} message
   * @property {string[]} [details]
   */

  /**
   * @typedef {Object} MatchResponse
   * @property {MatchedIngredient[]} matches
   * @property {string[]} unknown
   * @property {MatchWarning[]} warnings
   */

  /**
   * @typedef {Object} SubscriptionSummary
   * @property {string} id
   * @property {SubscriptionTier} tier
   * @property {string} status
   * @property {string} provider
   * @property {string} period
   * @property {string} currency
   * @property {number} priceCents
   * @property {boolean} earlyAccess
   * @property {string|null} currentPeriodEnd
   * @property {string|null} canceledAt
   */

  /**
   * @typedef {Object} MeSubscriptionResponse
   * @property {SubscriptionTier} tier
   * @property {SubscriptionSummary|null} subscription
   */

  /**
   * @typedef {Object} SearchResultItem
   * @property {"drug"|"condition"|"calculator"|"ingredient"} type
   * @property {string} slug
   * @property {string} titleRu
   * @property {string} titleEn
   * @property {string} subtitle
   * @property {string} [extra]
   */

  /**
   * @typedef {Object} ExtensionEventRequest
   * @property {ExtensionEventType} type
   * @property {string|null} [version]
   * @property {string|null} [anonymousId]
   * @property {string|null} [sessionId]
   * @property {string|null} [locale]
   * @property {SubscriptionTier|null} [tier]
   * @property {ExtensionStore|null} [store]
   * @property {number|null} [matchedCount]
   * @property {number|null} [totalCount]
   * @property {number|null} [unknownCount]
   * @property {string|null} [target]
   * @property {string|null} [errorCode]
   * @property {string|null} [reason]
   * @property {string|null} [comment]
   */

  // ============================================================
  // UTILITIES
  // ============================================================

  function clampStr(s, max) {
    return String(s ?? "").slice(0, max);
  }

  function enumOrNull(value, allowedSet) {
    return allowedSet.has(value) ? value : null;
  }

  // Default values for required-but-missing enum fields. Server schema marks
  // irritationLevel / allergenRisk / pregnancySafety as required; if a legacy
  // response omits them we coerce to safe defaults rather than dropping the row.
  function enumOrDefault(value, allowedSet, fallback) {
    return allowedSet.has(value) ? value : fallback;
  }

  // ============================================================
  // SANITIZERS
  // ============================================================

  /**
   * @param {unknown} raw
   * @returns {MatchedIngredient|null}
   */
  function sanitizeMatchedIngredient(raw) {
    if (!raw || typeof raw !== "object") return null;
    const m = /** @type {Record<string, unknown>} */ (raw);
    const comedogenic =
      typeof m.comedogenic === "number" && Number.isFinite(m.comedogenic)
        ? Math.max(0, Math.min(5, Math.floor(m.comedogenic)))
        : null;
    return {
      query: clampStr(m.query, 200),
      position: Number.isFinite(m.position)
        ? Math.max(0, Math.floor(/** @type {number} */ (m.position)))
        : 0,
      slug: clampStr(m.slug, 200),
      nameRu: clampStr(m.nameRu, 200),
      nameEn: clampStr(m.nameEn, 200),
      nameEs: m.nameEs ? clampStr(m.nameEs, 200) : null,
      minEffectivePct:
        typeof m.minEffectivePct === "number" && Number.isFinite(m.minEffectivePct)
          ? Math.max(0, Math.min(100, m.minEffectivePct))
          : null,
      trafficLight: enumOrNull(m.trafficLight, TRAFFIC_LIGHTS),
      isFunctional: Boolean(m.isFunctional),
      filterGeneration: enumOrNull(m.filterGeneration, FILTER_GENERATIONS),
      surfactantHarshness: enumOrNull(m.surfactantHarshness, SURFACTANT_HARSHNESSES),
      irritationLevel: enumOrDefault(m.irritationLevel, IRRITATION_LEVELS, "LOW"),
      allergenRisk: enumOrDefault(m.allergenRisk, ALLERGEN_RISKS, "LOW"),
      pregnancySafety: enumOrDefault(m.pregnancySafety, PREGNANCY_SAFETIES, "UNKNOWN"),
      lactationSafety: enumOrDefault(m.lactationSafety, LACTATION_SAFETIES, "UNKNOWN"),
      comedogenic,
      categories: Array.isArray(m.categories)
        ? m.categories.slice(0, 20).map((c) => clampStr(c, 100))
        : [],
      url: clampStr(m.url, 500),
      positionWarning: m.positionWarning ? clampStr(m.positionWarning, 500) : null,
      riskBadges: Array.isArray(m.riskBadges)
        ? m.riskBadges
            .map((b) => enumOrNull(b, RISK_BADGES))
            .filter((b) => b !== null)
            .slice(0, 20)
        : [],
    };
  }

  /**
   * @param {unknown} raw
   * @returns {MatchResponse}
   */
  function sanitizeMatchResponse(raw) {
    const out = { matches: [], unknown: [], warnings: [] };
    if (!raw || typeof raw !== "object") return out;
    const r = /** @type {Record<string, unknown>} */ (raw);
    if (Array.isArray(r.matches)) {
      out.matches = r.matches
        .slice(0, 500)
        .map(sanitizeMatchedIngredient)
        .filter((m) => m !== null);
    }
    if (Array.isArray(r.unknown)) {
      out.unknown = r.unknown.slice(0, 500).map((u) => clampStr(u, 200));
    }
    if (Array.isArray(r.warnings)) {
      out.warnings = r.warnings
        .slice(0, 50)
        .filter((w) => w && typeof w === "object")
        .map((w) => ({
          type: clampStr(w.type, 50),
          message: clampStr(w.message, 300),
          details: Array.isArray(w.details)
            ? w.details.slice(0, 20).map((s) => clampStr(s, 100))
            : [],
        }));
    }
    return out;
  }

  /**
   * @param {unknown} raw
   * @returns {MeSubscriptionResponse}
   */
  function sanitizeMeSubscriptionResponse(raw) {
    const out = { tier: "FREE", subscription: null };
    if (!raw || typeof raw !== "object") return out;
    const r = /** @type {Record<string, unknown>} */ (raw);
    out.tier = enumOrDefault(r.tier, SUBSCRIPTION_TIERS, "FREE");
    if (r.subscription && typeof r.subscription === "object") {
      const s = /** @type {Record<string, unknown>} */ (r.subscription);
      out.subscription = {
        id: clampStr(s.id, 200),
        tier: enumOrDefault(s.tier, SUBSCRIPTION_TIERS, "FREE"),
        status: enumOrDefault(s.status, SUBSCRIPTION_STATUSES, "EXPIRED"),
        provider: enumOrDefault(s.provider, BILLING_PROVIDERS, "YOOKASSA"),
        period: enumOrDefault(s.period, BILLING_PERIODS, "MONTHLY"),
        currency: clampStr(s.currency, 10),
        priceCents:
          typeof s.priceCents === "number" && Number.isFinite(s.priceCents)
            ? Math.max(0, Math.floor(s.priceCents))
            : 0,
        earlyAccess: Boolean(s.earlyAccess),
        currentPeriodEnd: typeof s.currentPeriodEnd === "string" ? s.currentPeriodEnd : null,
        canceledAt: typeof s.canceledAt === "string" ? s.canceledAt : null,
      };
    }
    return out;
  }

  /**
   * @param {unknown} raw
   * @returns {SearchResultItem[]}
   */
  function sanitizeSearchResponse(raw) {
    // Server returns a plain array; tolerate { results: [...] } for legacy shapes.
    let arr = null;
    if (Array.isArray(raw)) arr = raw;
    else if (raw && typeof raw === "object" && Array.isArray(raw.results)) arr = raw.results;
    if (!arr) return [];

    const out = [];
    for (const item of arr.slice(0, 50)) {
      if (!item || typeof item !== "object") continue;
      const type = enumOrNull(item.type, SEARCH_RESULT_TYPES);
      if (!type) continue;
      const titleRu = clampStr(item.titleRu, 200);
      const titleEn = clampStr(item.titleEn, 200);
      if (!titleRu && !titleEn) continue;
      const entry = {
        type,
        slug: clampStr(item.slug, 200),
        titleRu,
        titleEn,
        subtitle: clampStr(item.subtitle, 300),
      };
      if (typeof item.extra === "string") entry.extra = clampStr(item.extra, 300);
      out.push(entry);
    }
    return out;
  }

  // ============================================================
  // VERSION CHECK
  // ============================================================

  /**
   * Read API version header from a Headers object (or anything with a .get(name)).
   * Returns { version, ok, outdated }. Missing header -> legacy server, ok=true.
   *
   * @param {Headers|Map<string,string>|{get:(k:string)=>(string|null)}|null|undefined} headers
   */
  function checkApiVersion(headers) {
    if (!headers || typeof headers.get !== "function") {
      return { version: null, ok: true, outdated: false };
    }
    const raw = headers.get(API_VERSION_HEADER) || headers.get(API_VERSION_HEADER.toLowerCase());
    if (raw == null) {
      return { version: null, ok: true, outdated: false };
    }
    const version = Number.parseInt(raw, 10);
    if (!Number.isFinite(version) || version < MIN_KNOWN_VERSION) {
      // Server returned garbage in the header — treat as legacy.
      return { version: null, ok: true, outdated: false };
    }
    const outdated = version > MAX_KNOWN_VERSION;
    return { version, ok: !outdated, outdated };
  }

  // ============================================================
  // EXPOSE
  // ============================================================

  globalThis.evgContract = Object.freeze({
    // version constants
    EXTENSION_API_VERSION,
    API_VERSION_HEADER,
    MIN_KNOWN_VERSION,
    MAX_KNOWN_VERSION,
    // URLs
    SITE_URL,
    // enum sets
    TRAFFIC_LIGHTS,
    IRRITATION_LEVELS,
    ALLERGEN_RISKS,
    PREGNANCY_SAFETIES,
    LACTATION_SAFETIES,
    FILTER_GENERATIONS,
    SURFACTANT_HARSHNESSES,
    RISK_BADGES,
    SUBSCRIPTION_TIERS,
    SUBSCRIPTION_STATUSES,
    BILLING_PROVIDERS,
    BILLING_PERIODS,
    EXTENSION_EVENT_TYPES,
    EXTENSION_STORES,
    SEARCH_RESULT_TYPES,
    SEARCH_LOCALES,
    // utilities
    clampStr,
    enumOrNull,
    enumOrDefault,
    // sanitizers
    sanitizeMatchedIngredient,
    sanitizeMatchResponse,
    sanitizeMeSubscriptionResponse,
    sanitizeSearchResponse,
    // version check
    checkApiVersion,
  });
})();
