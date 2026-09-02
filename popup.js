/**
 * Popup script for Evigrade browser extension.
 *
 * Tabs: Analysis | My Allergens | Compare
 */

// Единый источник правды – api-contract.js. Меняем там, читаем здесь.
const SITE_URL = globalThis.evgContract?.SITE_URL || "https://evigrade.vercel.app";
const API_URL = `${SITE_URL}/api/ingredients/match`;
const SEARCH_URL = `${SITE_URL}/api/search`;
const ME_URL = `${SITE_URL}/api/me/subscription`;
const _STOPLIST_URL = `${SITE_URL}/api/stoplist`;
// Страница входа сайта, а не /api/auth/signin/google: GET на роут провайдера
// в Auth.js v5 невалиден (parseActionAndProviderId кидает UnknownAction), прод
// отдавал 302 на /api/auth/error?error=Configuration – войти из расширения было
// нельзя вообще. /signin показывает и Google, и вход по ссылке на почту.
const SIGNIN_URL = `${SITE_URL}/signin`;

// Free-tier limit: how many user-added items each category may hold.
const FREE_PER_CATEGORY_LIMIT = 5;

// Lightweight telemetry helper. Background service worker has the auth
// state, anonymousId, sessionId and opt-out check — popup just hands off
// the event and forgets. Wrapped so a single throw can never break a click handler.
function track(type, data) {
  try {
    chrome.runtime.sendMessage({ action: "track", type, data });
  } catch {}
}

// Opt-out toggle. We store `true` in chrome.storage.local.evg_telemetry_optout
// to mean "do not send" — opposite to the checkbox semantics in the UI, so
// be careful with negation when wiring it up.
const TELEMETRY_OPTOUT_KEY = "evg_telemetry_optout";
async function loadTelemetryOptOut() {
  try {
    const data = await chrome.storage.local.get(TELEMETRY_OPTOUT_KEY);
    return data?.[TELEMETRY_OPTOUT_KEY] === true;
  } catch {}
  return false;
}
async function setTelemetryOptOut(optOut) {
  try {
    await chrome.storage.local.set({ [TELEMETRY_OPTOUT_KEY]: Boolean(optOut) });
  } catch {}
}

// Locale-aware site paths (filled after evgI18n.init resolves below).
let LOCALE = "en";
const localePath = () => {
  if (LOCALE === "ru") return "/ru";
  if (LOCALE === "es") return "/es";
  return "/en";
};
const PRICING_URL = () => `${SITE_URL}${localePath()}/pricing`;
const ACCOUNT_URL = () => `${SITE_URL}${localePath()}/account`;
const CALLBACK_URL = () => `${SITE_URL}${localePath()}/extension-callback`;

// Tracks whether the user explicitly picked a locale (so host-based hints
// don't override their choice on the next popup open).
let LOCALE_PINNED = false;

// Initial best-guess locale from browser UI lang. Stored preference (if any)
// overrides this in bootstrap() before any UI render.
try {
  const ui = chrome.i18n.getUILanguage() || "";
  if (typeof globalThis.evgI18n === "object") {
    LOCALE = globalThis.evgI18n.init({ uiLang: ui });
  }
} catch {}

const msg = (key, ...args) =>
  typeof globalThis.evgI18n === "object" ? globalThis.evgI18n.t(key, ...args) : key;

function applyI18n() {
  if (typeof globalThis.evgI18n === "object") globalThis.evgI18n.apply(document);
}

function refreshLangSwitchUI() {
  const buttons = document.querySelectorAll(".lang-btn[data-lang]");
  for (const btn of buttons) {
    btn.classList.toggle("active", btn.dataset.lang === LOCALE);
  }
}

async function changeLocale(code) {
  if (typeof globalThis.evgI18n !== "object") return;
  const next = await globalThis.evgI18n.setLocale(code, { persist: true });
  LOCALE = next;
  if (document.documentElement) document.documentElement.lang = next;
  applyI18n();
  refreshLangSwitchUI();
  refreshAccountUI();
  track("LANG_SWITCH", { target: next });
  // Re-render dynamic sections so localized labels update without re-opening
  try {
    renderBlacklist();
  } catch {}
  try {
    loadCompareList();
  } catch {}
}

// ============================================================
// HEALTH FILTERS (pregnancy / lactation)
// ============================================================
// chrome.storage.local — health data special category по GDPR Art.9.
// Не синхронизируем с Google account servers, оставляем на устройстве.

const HEALTH_FILTERS_KEY = "evgHealthFilters";
const healthFilters = { pregnancy: false, lactation: false };

async function loadHealthFilters() {
  try {
    const data = await chrome.storage.local.get(HEALTH_FILTERS_KEY);
    const stored = data?.[HEALTH_FILTERS_KEY];
    if (stored && typeof stored === "object") {
      healthFilters.pregnancy = Boolean(stored.pregnancy);
      healthFilters.lactation = Boolean(stored.lactation);
    }
  } catch {}
  refreshHealthButtons();
}

async function saveHealthFilters() {
  try {
    await chrome.storage.local.set({
      [HEALTH_FILTERS_KEY]: { pregnancy: healthFilters.pregnancy, lactation: healthFilters.lactation },
    });
  } catch {}
}

function refreshHealthButtons() {
  const $preg = document.getElementById("health-pregnancy");
  const $lact = document.getElementById("health-lactation");
  if ($preg) $preg.classList.toggle("active", healthFilters.pregnancy);
  if ($lact) $lact.classList.toggle("active", healthFilters.lactation);
}

async function toggleHealthFilter(kind) {
  healthFilters[kind] = !healthFilters[kind];
  refreshHealthButtons();
  await saveHealthFilters();
  track("FILTERS_CHANGED", { target: `${kind}:${healthFilters[kind] ? "on" : "off"}` });
  // Tell the active tab's content script to re-render the floating panel
  // immediately so the user sees the badge change without scrolling/reloading.
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { action: "healthFiltersChanged" });
  } catch {}
}

// ============================================================
// AUTH + TIER STATE
// ============================================================
// Effective state for the current popup open. `auth.tier` is "FREE" until we
// confirm otherwise — keeps Free behaviour the safe default if the API call
// fails or the user is offline.

const auth = {
  loaded: false,
  signedIn: false,
  email: null,
  tier: "FREE", // "FREE" | "PRO" | "PROFI"
};

function notifyOutdatedIfNeeded(headers) {
  try {
    const check = globalThis.evgContract?.checkApiVersion(headers);
    if (check?.outdated) {
      try {
        chrome.runtime.sendMessage({ action: "apiOutdated" });
      } catch {
        /* no service worker available */
      }
    }
  } catch {}
}

async function fetchAuthState() {
  try {
    const res = await fetch(ME_URL, { credentials: "include", referrer: "" });
    notifyOutdatedIfNeeded(res.headers);
    if (res.status === 401) {
      auth.signedIn = false;
      auth.email = null;
      auth.tier = "FREE";
    } else if (res.ok) {
      const raw = await res.json();
      const data = globalThis.evgContract.sanitizeMeSubscriptionResponse(raw);
      auth.signedIn = true;
      auth.tier = data.tier;
    }
  } catch {
    // Offline or network issue — leave defaults (FREE).
  } finally {
    auth.loaded = true;
    // Cache tier so content scripts (no fetch/cookie access) can gate Pro UI.
    try {
      await chrome.storage.local.set({ evg_tier_cache: auth.tier });
    } catch {}
    refreshAccountUI();
  }
}

function refreshAccountUI() {
  const $label = document.getElementById("account-label");
  const $badge = document.getElementById("tier-badge");
  if (!$label || !$badge) return;

  if (!auth.signedIn) {
    $label.textContent = msg("accountSignIn");
    $badge.style.display = "none";
    return;
  }
  $label.textContent = auth.email ? auth.email.split("@")[0] : msg("accountProfile");
  if (auth.tier === "PRO" || auth.tier === "PROFI") {
    $badge.textContent = auth.tier === "PROFI" ? msg("tierProfi") : msg("tierPro");
    $badge.className = "tier-badge tier-pro";
    $badge.style.display = "inline-block";
  } else {
    $badge.textContent = msg("tierFree");
    $badge.className = "tier-badge tier-free";
    $badge.style.display = "inline-block";
  }
}

function openInTab(url) {
  try {
    chrome.tabs.create({ url });
  } catch {
    /* opening tabs requires a user gesture; ignore */
  }
}

function signIn() {
  track("AUTH_LOGIN_CLICK");
  // Open NextAuth sign-in flow. After Google OAuth, evigrade.com sets the
  // session cookie. Popup re-checks auth state periodically while we wait.
  openInTab(`${SIGNIN_URL}?callbackUrl=${encodeURIComponent(CALLBACK_URL())}`);
  // Poll every 2s for up to 60s to detect successful sign-in without
  // requiring the user to click "Refresh".
  let attempts = 0;
  const timer = setInterval(async () => {
    attempts++;
    await fetchAuthState();
    if (auth.signedIn || attempts >= 30) clearInterval(timer);
  }, 2000);
}

function openUpgrade() {
  track("PRO_CTA_CLICK", { target: "upgrade-button" });
  // Pass the install anonymousId so the pricing page can show the early-access
  // discount (first 1000 installers — see /api/early-access).
  chrome.storage.local.get("evigrade_anon_id", (data) => {
    const aid = typeof data?.evigrade_anon_id === "string" ? data.evigrade_anon_id : null;
    const base = PRICING_URL();
    const url = aid ? `${base}?aid=${encodeURIComponent(aid)}` : base;
    openInTab(url);
  });
}

// Tracks each time a Free user hits a Pro-gated wall, so the dashboard
// can show interest signal even when nobody clicks "Upgrade".
function showPaywall(text, feature) {
  const $overlay = document.getElementById("paywall");
  const $text = document.getElementById("paywall-text");
  if (!$overlay || !$text) return;
  $text.textContent = text;
  $overlay.style.display = "flex";
  if (feature) track("PRO_CTA_CLICK", { target: `paywall:${feature}` });
}

function hidePaywall() {
  const $overlay = document.getElementById("paywall");
  if ($overlay) $overlay.style.display = "none";
}

document.getElementById("account-btn")?.addEventListener("click", () => {
  if (auth.signedIn) {
    openInTab(ACCOUNT_URL());
  } else {
    signIn();
  }
});

document.getElementById("paywall-upgrade")?.addEventListener("click", openUpgrade);
document.getElementById("paywall-close")?.addEventListener("click", hidePaywall);

// First i18n pass with browser-UI-lang guess. Re-applied inside init() once
// the active tab host is known (host wins over UI lang).
applyI18n();

// ============================================================
// TABS
// ============================================================

const tabs = document.querySelectorAll(".tab");
const tabContents = document.querySelectorAll(".tab-content");

for (const tab of tabs) {
  tab.addEventListener("click", () => {
    for (const t of tabs) t.classList.remove("active");
    for (const c of tabContents) c.classList.remove("active");
    tab.classList.add("active");
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add("active");

    if (tab.dataset.tab === "compare") loadCompareList();
  });
}

// ============================================================
// TAB 1: ANALYSIS (original logic)
// ============================================================

const $status = document.getElementById("status");
const $results = document.getElementById("results");
const $summary = document.getElementById("summary");
const $manualSection = document.getElementById("manual-section");
const $btnManual = document.getElementById("btn-manual");
const $manualForm = document.getElementById("manual-form");
const $manualInput = document.getElementById("manual-input");
const $btnAnalyze = document.getElementById("btn-analyze");

async function init() {
  try {
    // Stored preference wins. Resolve it first so the initial render is
    // already in the right language (no flash of wrong locale).
    if (typeof globalThis.evgI18n === "object") {
      const ui = (() => {
        try {
          return chrome.i18n.getUILanguage();
        } catch {
          return "";
        }
      })();
      LOCALE = await globalThis.evgI18n.initAsync({ uiLang: ui });
      LOCALE_PINNED = await (async () => {
        try {
          return new Promise((resolve) =>
            chrome.storage.sync.get([globalThis.evgI18n.STORAGE_KEY], (res) =>
              resolve(Boolean(res?.[globalThis.evgI18n.STORAGE_KEY]))
            )
          );
        } catch {
          return false;
        }
      })();
      if (document.documentElement) document.documentElement.lang = LOCALE;
      applyI18n();
      refreshLangSwitchUI();
      refreshAccountUI();
      globalThis.evgI18n.watchStorage();
      globalThis.evgI18n.onChange((next) => {
        LOCALE = next;
        if (document.documentElement) document.documentElement.lang = next;
        applyI18n();
        refreshLangSwitchUI();
        try {
          renderBlacklist();
        } catch {}
        try {
          renderCompareList();
        } catch {}
      });
    }

    // Wire up the language switcher.
    document.querySelectorAll(".lang-btn[data-lang]").forEach((btn) => {
      btn.addEventListener("click", () => changeLocale(btn.dataset.lang));
    });

    // Telemetry opt-out toggle. Default behaviour is opt-IN, so the
    // checkbox is `checked` until storage explicitly says the user
    // turned it off. We persist immediately on change.
    const $telemetry = document.getElementById("telemetry-toggle");
    if ($telemetry) {
      const optedOut = await loadTelemetryOptOut();
      $telemetry.checked = !optedOut;
      $telemetry.addEventListener("change", async () => {
        // Capture the "user just opted out" event before we silence things,
        // and the "user just re-enabled" event right after we lift the gate.
        if (!$telemetry.checked) {
          track("FILTERS_CHANGED", { target: "telemetry:off" });
          await setTelemetryOptOut(true);
        } else {
          await setTelemetryOptOut(false);
          track("FILTERS_CHANGED", { target: "telemetry:on" });
        }
      });
    }

    // Wire up the health-state toggles.
    document.getElementById("health-pregnancy")?.addEventListener("click", () => toggleHealthFilter("pregnancy"));
    document.getElementById("health-lactation")?.addEventListener("click", () => toggleHealthFilter("lactation"));
    loadHealthFilters();

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    let host = "";
    try {
      host = tab?.url ? new URL(tab.url).hostname : "";
    } catch {}

    // Marketplace host hint only refines locale when the user has NOT
    // explicitly chosen one — initAsync already accounts for that.
    if (host && typeof globalThis.evgI18n === "object" && !LOCALE_PINNED) {
      const ui = (() => {
        try {
          return chrome.i18n.getUILanguage();
        } catch {
          return "";
        }
      })();
      LOCALE = globalThis.evgI18n.init({ host, uiLang: ui });
      applyI18n();
      refreshAccountUI();
    }
    const SEPHORA_TLDS = ["com", "fr", "de", "es", "it", "pl"];
    const NOTINO_TLDS = ["cz", "de", "fr", "it", "es", "pl", "hu", "sk", "at", "co.uk"];
    const DOUGLAS_TLDS = ["de", "at", "ch", "it", "es", "nl", "pl", "cz", "hu", "fr"];
    const isSupportedSite =
      host.endsWith("wildberries.ru") ||
      host.endsWith("wildberries.am") ||
      host.endsWith("wildberries.by") ||
      host.endsWith("wildberries.kz") ||
      host.endsWith("ozon.ru") ||
      host.endsWith("ozon.com") ||
      host.endsWith("iherb.com") ||
      host.endsWith("goldapple.ru") ||
      SEPHORA_TLDS.some((tld) => host.endsWith(`sephora.${tld}`)) ||
      host.endsWith("ulta.com") ||
      host.endsWith("boots.com") ||
      host.endsWith("lookfantastic.com") ||
      host.endsWith("cultbeauty.co.uk") ||
      host.endsWith("beautybay.com") ||
      NOTINO_TLDS.some((tld) => host.endsWith(`notino.${tld}`)) ||
      DOUGLAS_TLDS.some((tld) => host.endsWith(`douglas.${tld}`)) ||
      host.endsWith("dm.de") ||
      host.endsWith("dm.at") ||
      host.endsWith("rossmann.de") ||
      host.endsWith("rossmann.pl");

    if (isSupportedSite) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["api-contract.js", "i18n.js", "content/parser.js"],
        });
      } catch {
        /* already injected */
      }

      chrome.tabs.sendMessage(tab.id, { action: "getStatus" }, (response) => {
        if (chrome.runtime.lastError) {
          $status.textContent = msg("statusOpenComposition");
          $status.style.display = "block";
          $manualSection.style.display = "block";
          return;
        }
        if (response?.analyzed) {
          $status.innerHTML = `<span style="color:#16a34a">&#10003;</span> ${esc(msg("statusAnalysisShown"))}`;
        } else {
          $status.textContent = msg("statusOpenComposition");
        }
        $status.style.display = "block";
        $manualSection.style.display = "block";
      });
      return;
    }
    $status.style.display = "none";
    $manualSection.style.display = "block";
    $btnManual.style.display = "none";
    $manualForm.style.display = "block";
  } catch {
    $status.style.display = "none";
    $manualSection.style.display = "block";
  }
}

$btnManual.addEventListener("click", () => {
  $btnManual.style.display = "none";
  $manualForm.style.display = "block";
  $manualInput.focus();
});

$btnAnalyze.addEventListener("click", () => {
  const text = $manualInput.value.trim();
  if (!text) return;
  const ingredients = text
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
  if (ingredients.length > 0) analyzeManual(ingredients);
});

$manualInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $btnAnalyze.click();
  }
});

async function analyzeManual(ingredients) {
  $status.textContent = msg("scanning");
  $status.className = "status";
  $status.style.display = "block";
  $results.style.display = "none";
  $summary.style.display = "none";

  try {
    const safeIngredients = ingredients
      .filter((s) => typeof s === "string")
      .map((s) => s.slice(0, 200))
      .slice(0, 200);
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ingredients: safeIngredients }),
      credentials: "omit",
      referrer: "",
    });
    notifyOutdatedIfNeeded(res.headers);
    if (!res.ok) throw new Error("API error");
    const data = globalThis.evgContract.sanitizeMatchResponse(await res.json());
    renderResults(data);
  } catch {
    $status.textContent = msg("error");
    $status.className = "status error";
  }
}

function renderResults(data) {
  $status.style.display = "none";
  $results.style.display = "block";
  $summary.style.display = "flex";

  const counts = { green: 0, yellow: 0, red: 0, unknown: 0 };
  for (const m of data.matches) {
    if (m.trafficLight === "GREEN") counts.green++;
    else if (m.trafficLight === "YELLOW") counts.yellow++;
    else if (m.trafficLight === "RED") counts.red++;
    else counts.unknown++;
  }
  counts.unknown += (data.unknown || []).length;

  $summary.innerHTML = "";
  const labels = {
    green: msg("green"),
    yellow: msg("yellow"),
    red: msg("red"),
    gray: msg("unknown"),
  };
  if (counts.green > 0) $summary.appendChild(summaryItem("green", counts.green, labels.green));
  if (counts.yellow > 0) $summary.appendChild(summaryItem("yellow", counts.yellow, labels.yellow));
  if (counts.red > 0) $summary.appendChild(summaryItem("red", counts.red, labels.red));
  if (counts.unknown > 0) $summary.appendChild(summaryItem("gray", counts.unknown, labels.gray));

  const order = { RED: 0, YELLOW: 1, GREEN: 2 };
  const sorted = [...data.matches].sort((a, b) => {
    const wA = a.positionWarning ? -1 : 0;
    const wB = b.positionWarning ? -1 : 0;
    if (wA !== wB) return wA - wB;
    return (order[a.trafficLight] ?? 3) - (order[b.trafficLight] ?? 3);
  });

  $results.innerHTML = "";
  for (const m of sorted) {
    const cls = tlClass(m.trafficLight);
    const label = tlLabel(m.trafficLight);
    const warningHtml = m.positionWarning
      ? `<div class="position-warning">\u26a0 ${esc(m.positionWarning)}</div>`
      : "";

    const row = document.createElement("a");
    row.className = `ingredient-row${m.positionWarning ? " has-warning" : ""}`;
    row.href = safeSiteUrl(m.url);
    row.target = "_blank";
    row.rel = "noopener noreferrer";
    row.innerHTML = `
      <span class="tl-dot ${cls}"></span>
      <div class="ingredient-info">
        <div class="ingredient-name">${esc(m.nameRu)}</div>
        <div class="ingredient-name-en">${esc(m.nameEn)}</div>
        ${warningHtml}
      </div>
      <span class="tl-label ${cls}">${label}</span>
      <span class="row-arrow">&#8594;</span>
    `;
    $results.appendChild(row);
  }
}

function summaryItem(cls, count, label) {
  const el = document.createElement("div");
  el.className = "summary-item";
  el.innerHTML = `<span class="summary-dot ${cls}"></span><span>${count} ${label}</span>`;
  return el;
}

function tlClass(tl) {
  if (tl === "GREEN") return "green";
  if (tl === "YELLOW") return "yellow";
  if (tl === "RED") return "red";
  return "gray";
}

function tlLabel(tl) {
  if (tl === "GREEN") return msg("green");
  if (tl === "YELLOW") return msg("yellow");
  if (tl === "RED") return msg("red");
  return msg("unknown");
}

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

function isHttpUrl(u) {
  try {
    const p = new URL(String(u));
    return p.protocol === "https:" || p.protocol === "http:";
  } catch {
    return false;
  }
}

function clampStr(s, max) {
  return String(s ?? "").slice(0, max);
}

// ============================================================
// TAB 2: BLACKLIST (allergens, comedogenic, avoid)
// ============================================================

const BLACKLIST_KEY = "evigrade_blacklist";

const BL_MAX_ITEM = 80;
const BL_MAX_PER_CAT = 100;

function sanitizeBlacklist(bl) {
  const safe = { allergens: [], comedogenic: [], avoid: [] };
  if (!bl || typeof bl !== "object") return safe;
  for (const cat of ["allergens", "comedogenic", "avoid"]) {
    if (Array.isArray(bl[cat])) {
      const seen = new Set();
      for (const raw of bl[cat]) {
        if (typeof raw !== "string") continue;
        const v = raw.trim().slice(0, BL_MAX_ITEM);
        if (!v) continue;
        const key = v.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        safe[cat].push(v);
        if (safe[cat].length >= BL_MAX_PER_CAT) break;
      }
    }
  }
  return safe;
}

async function loadBlacklist() {
  const data = await chrome.storage.local.get(BLACKLIST_KEY);
  return sanitizeBlacklist(data[BLACKLIST_KEY]);
}

async function saveBlacklist(bl) {
  const sanitized = sanitizeBlacklist(bl);
  await chrome.storage.local.set({ [BLACKLIST_KEY]: sanitized });
  // Notify content scripts about the update
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { action: "blacklistUpdated", blacklist: sanitized });
    }
  } catch {}
}

async function renderBlacklist() {
  const bl = await loadBlacklist();

  renderChips("bl-allergens", bl.allergens, "allergens");
  renderChips("bl-comedogenic", bl.comedogenic, "comedogenic");
  renderChips("bl-avoid", bl.avoid, "avoid");
}

function renderChips(containerId, items, category) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  for (const item of items) {
    const chip = document.createElement("span");
    chip.className = "bl-chip";
    chip.innerHTML = `${esc(item)}<span class="bl-chip-x" data-category="${category}" data-name="${esc(item)}">&times;</span>`;
    container.appendChild(chip);
  }

  // Remove handler
  for (const x of container.querySelectorAll(".bl-chip-x")) {
    x.addEventListener("click", async () => {
      const bl = await loadBlacklist();
      const cat = x.dataset.category;
      bl[cat] = bl[cat].filter((n) => n !== x.dataset.name);
      await saveBlacklist(bl);
      renderBlacklist();
    });
  }
}

function setupBlacklistInput(inputId, btnId, suggestId, category) {
  const input = document.getElementById(inputId);
  const btn = document.getElementById(btnId);
  const suggestContainer = document.getElementById(suggestId);
  let debounceTimer = null;

  async function addItem(name) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const bl = await loadBlacklist();
    // Free-tier gate: cap user-added items per category. Already-present
    // duplicates are silently ignored (no paywall noise on a re-add).
    if (
      auth.tier === "FREE" &&
      bl[category].length >= FREE_PER_CATEGORY_LIMIT &&
      !bl[category].includes(trimmed)
    ) {
      showPaywall(msg("paywallBlacklistLimit", FREE_PER_CATEGORY_LIMIT), "blacklist-limit");
      input.value = "";
      suggestContainer.innerHTML = "";
      return;
    }
    if (!bl[category].includes(trimmed)) {
      bl[category].push(trimmed);
      await saveBlacklist(bl);
      track("BLACKLIST_ADD", { target: category });
    }
    input.value = "";
    suggestContainer.innerHTML = "";
    renderBlacklist();
  }

  btn.addEventListener("click", () => addItem(input.value));

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addItem(input.value);
    }
  });

  input.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    const q = input.value.trim();
    if (q.length < 2) {
      suggestContainer.innerHTML = "";
      return;
    }
    debounceTimer = setTimeout(() => fetchSuggestions(q, suggestContainer, addItem), 250);
  });

  input.addEventListener("blur", () => {
    // Delay to allow click on suggestion
    setTimeout(() => {
      suggestContainer.innerHTML = "";
    }, 200);
  });
}

async function fetchSuggestions(query, container, onSelect) {
  try {
    const safeQuery = String(query).slice(0, 100);
    const res = await fetch(
      `${SEARCH_URL}?q=${encodeURIComponent(safeQuery)}&locale=${LOCALE}&limit=5`,
      {
        credentials: "omit",
        referrer: "",
      },
    );
    notifyOutdatedIfNeeded(res.headers);
    if (!res.ok) return;
    const items = globalThis.evgContract.sanitizeSearchResponse(await res.json());
    if (items.length === 0) {
      container.innerHTML = "";
      return;
    }

    const list = document.createElement("div");
    list.className = "bl-suggest-list";
    for (const item of items.slice(0, 5)) {
      const primary = LOCALE === "en" ? item.titleEn || item.titleRu : item.titleRu || item.titleEn;
      const secondary = LOCALE === "en" ? item.titleRu : item.titleEn;
      const name = clampStr(primary || safeQuery, BL_MAX_ITEM);
      const nameEn = clampStr(secondary || "", BL_MAX_ITEM);
      if (!name) continue;
      const div = document.createElement("div");
      div.className = "bl-suggest-item";
      const nameSpan = document.createElement("span");
      nameSpan.textContent = name;
      div.appendChild(nameSpan);
      if (nameEn) {
        const enSpan = document.createElement("span");
        enSpan.className = "bl-suggest-en";
        enSpan.textContent = nameEn;
        div.appendChild(enSpan);
      }
      div.addEventListener("mousedown", (e) => {
        e.preventDefault();
        onSelect(name);
      });
      list.appendChild(div);
    }
    container.innerHTML = "";
    container.appendChild(list);
  } catch {
    container.innerHTML = "";
  }
}

setupBlacklistInput("bl-allergen-input", "bl-allergen-add", "bl-allergen-suggest", "allergens");
setupBlacklistInput(
  "bl-comedogenic-input",
  "bl-comedogenic-add",
  "bl-comedogenic-suggest",
  "comedogenic",
);
setupBlacklistInput("bl-avoid-input", "bl-avoid-add", "bl-avoid-suggest", "avoid");
renderBlacklist();

// ============================================================
// TAB 3: COMPARE
// ============================================================

const COMPARE_KEY = "evigrade_compare";

function sanitizeCompareList(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const p of arr) {
    if (!p || typeof p !== "object") continue;
    if (!isHttpUrl(p.url)) continue;
    out.push({
      name: clampStr(p.name, 200),
      url: clampStr(p.url, 1000),
      ingredientCount: Number.isFinite(p.ingredientCount)
        ? Math.max(0, Math.min(1000, p.ingredientCount | 0))
        : 0,
      ingredients: Array.isArray(p.ingredients)
        ? p.ingredients.slice(0, 200).map((s) => clampStr(s, 200))
        : [],
      matches: Array.isArray(p.matches) ? p.matches.slice(0, 500) : [],
      warnings: Array.isArray(p.warnings) ? p.warnings.slice(0, 50) : [],
      unknown: Array.isArray(p.unknown) ? p.unknown.slice(0, 500).map((s) => clampStr(s, 200)) : [],
      addedAt: Number.isFinite(p.addedAt) ? p.addedAt : Date.now(),
    });
    if (out.length >= 5) break;
  }
  return out;
}

async function loadCompareProducts() {
  const data = await chrome.storage.local.get(COMPARE_KEY);
  return sanitizeCompareList(data[COMPARE_KEY]);
}

async function saveCompareProducts(products) {
  await chrome.storage.local.set({ [COMPARE_KEY]: sanitizeCompareList(products) });
}

// Free tier: how many products may be compared at once.
const FREE_COMPARE_LIMIT = 3;

async function loadCompareList() {
  const products = await loadCompareProducts();
  const $empty = document.getElementById("compare-empty");
  const $list = document.getElementById("compare-list");
  const $actions = document.getElementById("compare-actions");

  if (products.length === 0) {
    $empty.style.display = "block";
    $list.style.display = "none";
    $actions.style.display = "none";
    return;
  }

  $empty.style.display = "none";
  $list.style.display = "block";
  $actions.style.display = products.length >= 2 ? "flex" : "none";

  // Free-tier soft gate: show only the first FREE_COMPARE_LIMIT products
  // and append an upgrade row for the rest. Hard gate at add-time lives in
  // the content script (Phase 1.5 — see docs/billing-tech-debt.md).
  const isFree = auth.tier === "FREE";
  const visible = isFree ? products.slice(0, FREE_COMPARE_LIMIT) : products;
  const hidden = isFree ? products.length - visible.length : 0;

  $list.innerHTML = "";
  visible.forEach((p, i) => {
    const div = document.createElement("div");
    div.className = "compare-item";
    div.innerHTML = `
      <span class="compare-num">${i + 1}</span>
      <div class="compare-info">
        <div class="compare-name">${esc(p.name)}</div>
        <div class="compare-count">${esc(msg("compareIngredientCount", p.ingredientCount))}</div>
      </div>
      <button class="compare-remove" data-idx="${i}" title="${esc(msg("compareRemoveTitle"))}">&times;</button>
    `;
    $list.appendChild(div);
  });

  if (hidden > 0) {
    const upsell = document.createElement("div");
    upsell.className = "compare-upsell";
    upsell.innerHTML = `
      <div class="compare-upsell-text">${esc(msg("compareUpsellMore", hidden))}</div>
      <button id="compare-upsell-btn" class="compare-upsell-btn">${esc(msg("paywallUpgrade"))}</button>
    `;
    $list.appendChild(upsell);
    document.getElementById("compare-upsell-btn")?.addEventListener("click", openUpgrade);
  }

  for (const btn of $list.querySelectorAll(".compare-remove")) {
    btn.addEventListener("click", async () => {
      const products = await loadCompareProducts();
      products.splice(Number.parseInt(btn.dataset.idx), 1);
      await saveCompareProducts(products);
      loadCompareList();
    });
  }
}

document.getElementById("btn-compare").addEventListener("click", () => {
  // Один обработчик на click: и открыть вкладку, и отправить телеметрию.
  // Раньше было два независимых addEventListener – путало ревью кода.
  track("COMPARE_OPEN");
  chrome.tabs.create({ url: chrome.runtime.getURL("compare.html") });
});

document.getElementById("btn-clear-compare").addEventListener("click", async () => {
  await saveCompareProducts([]);
  loadCompareList();
});

// Listen for compare updates from content script
chrome.runtime.onMessage.addListener((msg, sender, _sendResponse) => {
  if (!sender || sender.id !== chrome.runtime.id) return;
  if (msg && msg.action === "compareUpdated") {
    loadCompareList();
  }
});

init();

// Read auth/tier ПЕРВЫМ, потом рендерим compare-список. Иначе Pro-юзер видит
// FREE-урезанный список на ~200-500ms (loadCompareList читает auth.tier).
(async () => {
  await fetchAuthState();
  loadCompareList();
})();

track("POPUP_OPEN");
