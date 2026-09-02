/**
 * Welcome page bootstrap. Stored preference wins over browser UI lang.
 * Renders a small language switcher near the top so new installs in any
 * locale can pick their UI on first launch.
 *
 * Telemetry: fires WELCOME_OPENED on boot, WELCOME_CTA on either CTA
 * click, and LANG_SWITCH whenever the user clicks a language button.
 * All proxied through background.js so opt-out + sessionId are honored.
 */
(() => {
  function track(type, data) {
    try {
      chrome.runtime.sendMessage({ action: "track", type, data });
    } catch {}
  }

  async function boot() {
    if (typeof globalThis.evgI18n !== "object") return;
    let uiLang = "";
    try {
      uiLang = chrome.i18n.getUILanguage() || "";
    } catch {}
    const locale = await globalThis.evgI18n.initAsync({ uiLang });
    globalThis.evgI18n.apply(document);
    if (document.documentElement) document.documentElement.lang = locale;
    refreshSwitch(locale);
    globalThis.evgI18n.watchStorage();
    globalThis.evgI18n.onChange((next) => {
      if (document.documentElement) document.documentElement.lang = next;
      globalThis.evgI18n.apply(document);
      refreshSwitch(next);
    });
  }

  function refreshSwitch(active) {
    for (const btn of document.querySelectorAll(".lang-btn[data-lang]")) {
      btn.classList.toggle("active", btn.dataset.lang === active);
    }
  }

  document.addEventListener("click", async (ev) => {
    const btn = ev.target.closest(".lang-btn[data-lang]");
    if (!btn || typeof globalThis.evgI18n !== "object") return;
    track("LANG_SWITCH", { target: btn.dataset.lang });
    // await важен: при первой установке юзер может сразу закрыть welcome,
    // и без await chrome.storage.sync.set не успеет записаться до выгрузки.
    try {
      await globalThis.evgI18n.setLocale(btn.dataset.lang, { persist: true });
    } catch {}
  });

  // Track CTA clicks (primary "Open store" and secondary "Database").
  // dataset.welcomeCta is set in the HTML so we don't have to fingerprint
  // by class or href — easier to maintain when the buttons change.
  document.addEventListener("click", (ev) => {
    const cta = ev.target.closest("[data-welcome-cta]");
    if (!cta) return;
    track("WELCOME_CTA", { target: cta.dataset.welcomeCta });
  });

  // Onboarding health filters (none / pregnancy / lactation).
  document.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".health-onboard-btn[data-health]");
    if (!btn) return;
    track("FILTERS_CHANGED", { target: `welcome:${btn.dataset.health}` });
  });

  // Health-state onboarding (none / pregnancy / lactation).
  // Stored in evgHealthFilters so the parser content script picks it up on
  // the next marketplace visit. Same key as the popup toggles.
  async function loadHealthState() {
    try {
      const data = await chrome.storage.sync.get("evgHealthFilters");
      const s = data?.evgHealthFilters || {};
      const active = s.pregnancy ? "pregnancy" : s.lactation ? "lactation" : "none";
      for (const btn of document.querySelectorAll(".health-onboard-btn[data-health]")) {
        btn.classList.toggle("active", btn.dataset.health === active);
      }
    } catch {}
  }
  document.addEventListener("click", async (ev) => {
    const btn = ev.target.closest(".health-onboard-btn[data-health]");
    if (!btn) return;
    const choice = btn.dataset.health;
    const next = {
      pregnancy: choice === "pregnancy",
      lactation: choice === "lactation",
    };
    try {
      await chrome.storage.sync.set({ evgHealthFilters: next });
    } catch {}
    for (const b of document.querySelectorAll(".health-onboard-btn[data-health]")) {
      b.classList.toggle("active", b === btn);
    }
  });
  loadHealthState();

  // Telemetry opt-out toggle. Mirror of the popup version — same storage
  // key, so flipping it here propagates to the service worker on next event.
  const TELEMETRY_KEY = "evg_telemetry_optout";
  (async () => {
    try {
      const cb = document.getElementById("telemetry-toggle");
      if (!cb) return;
      const data = await chrome.storage.local.get(TELEMETRY_KEY);
      cb.checked = data?.[TELEMETRY_KEY] !== true;
      cb.addEventListener("change", async () => {
        try {
          await chrome.storage.local.set({ [TELEMETRY_KEY]: !cb.checked });
        } catch {}
      });
    } catch {}
  })();

  boot();
  track("WELCOME_OPENED");
})();
