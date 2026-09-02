/**
 * Bridge between extension storage and the evigrade.com web app.
 *
 * Writes the install anonymousId into window.localStorage so the pricing
 * page can probe early-access eligibility even when the user opens
 * pricing directly (without the ?aid query param). Without this, users
 * who install the extension and then visit evigrade.com from a bookmark
 * never see the first-1000 ₽199 discount banner.
 *
 * Runs only on evigrade hosts (see manifest match list). Read-only on
 * window – we never read existing localStorage values.
 */
(() => {
  try {
    const host = location.hostname;
    const allowed =
      host === "evigrade.com" || host === "www.evigrade.com" || host === "evigrade.vercel.app";
    if (!allowed) return;

    chrome.storage.local.get("evigrade_anon_id", (data) => {
      const aid = data?.evigrade_anon_id;
      if (typeof aid !== "string" || aid.length === 0 || aid.length > 64) return;
      try {
        localStorage.setItem("evigrade_anon_id", aid);
      } catch {
        // ignore (storage disabled / quota)
      }
    });
  } catch {
    // best-effort; never throw out of a content script
  }
})();
