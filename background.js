/**
 * Background service worker.
 *
 * Responsibilities:
 *  - Open welcome page on first install.
 *  - Register uninstall URL so users land on our feedback form when they remove the extension.
 *  - Fire anonymous telemetry events to /api/extension/event. Event types are
 *    whitelisted from api-contract.js and extra fields are sanitized per type
 *    before posting. Users can disable telemetry from the popup at any time
 *    (chrome.storage.local.evg_telemetry_optout = true).
 *  - Listen for "apiOutdated" pings from popup/content and surface a red "!" badge so the
 *    user knows the extension needs an update.
 *
 * Telemetry reliability (rewritten 2026-07-30). The previous version was
 * fire-and-forget against a single host, and it showed: over 28 June – 26 July
 * the Chrome Web Store counted 36 installs while the table stored 3. Three
 * things changed here.
 *
 *  1. `channel` marks whether this is a Web Store install or one of our own
 *     unpacked dev builds. Derived from chrome.runtime.id, no `management`
 *     permission needed. 43 of the 49 installs recorded before this date were
 *     our own reloads, which made every retention number meaningless.
 *  2. Failed posts go to a retry queue in chrome.storage.local with the
 *     original client timestamp, and are replayed on the next wake-up. A
 *     transient failure no longer destroys the event. The request also falls
 *     back from www.evigrade.com to evigrade.vercel.app, which both survives a
 *     Cloudflare block and tells us that it happened, via the `via` field.
 *  3. A once-per-day HEARTBEAT fires from chrome.alarms. Every other event
 *     needs the user to click something, so an install that is alive but idle
 *     used to be indistinguishable from one that was removed.
 */

importScripts("api-contract.js");

const SITE_URL = globalThis.evgContract?.SITE_URL || "https://evigrade.vercel.app";
const EVENT_URL = `${SITE_URL}/api/extension/event`;
// Direct-to-Vercel origin, used only when the primary host fails. It skips
// Cloudflare, so a proxy-side block or an SNI-level cut still gets the event
// through, and `via: "vercel"` in the payload records that it was needed.
const FALLBACK_EVENT_URL = "https://evigrade.vercel.app/api/extension/event";
const ANON_ID_KEY = "evigrade_anon_id";
const SESSION_ID_KEY = "evigrade_session_id";
const TIER_CACHE_KEY = "evg_tier_cache";
const OPTOUT_KEY = "evg_telemetry_optout";
const QUEUE_KEY = "evg_event_queue";
const HEARTBEAT_DAY_KEY = "evg_heartbeat_day";
const HEARTBEAT_ALARM = "evg-heartbeat";

// Published Chrome Web Store id. Anything else is an unpacked build, which
// means us. Kept as a literal on purpose: reading it from the manifest would
// just return whatever id the current load has.
const PROD_EXTENSION_ID = "ffipaidpbkbfhdhmijhncneohohbhfml";

// Queue cap. A browser that has been offline for weeks should not grow an
// unbounded blob in storage; oldest entries are dropped first.
const QUEUE_MAX = 100;

// Per-request cap for telemetry POSTs, see postTo().
const POST_TIMEOUT_MS = 15000;

// Whitelist of event types the worker will accept from any sender. Pulled from
// the API contract so adding a type in one place is enough.
const ALLOWED_EVENT_TYPES =
  globalThis.evgContract?.EXTENSION_EVENT_TYPES ??
  new Set(["INSTALL", "UPDATE", "HEARTBEAT", "POPUP_OPEN", "SCAN", "COMPARE_OPEN"]);

// Per-type throttle so a malicious page can't flood our endpoint via the content script.
const EVENT_MIN_INTERVAL_MS = 2000;
const lastSentAt = new Map();

const CHANNEL = (() => {
  try {
    return chrome.runtime.id === PROD_EXTENSION_ID ? "store" : "dev";
  } catch {
    return "unknown";
  }
})();

// Service worker lifetime is short (~30s of idle). Generate a session id once
// per wake-up so events that fire in the same session share an id, without
// us paying a chrome.storage round-trip every time. The browser kills the
// worker → next wake creates a new sessionId, which is what we want.
const SESSION_ID = (() => {
  try {
    return self.crypto.randomUUID();
  } catch {
    return randomId();
  }
})();

function randomId() {
  if (self.crypto?.randomUUID) return self.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  self.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function getAnonymousId() {
  const data = await chrome.storage.local.get(ANON_ID_KEY);
  let id = data[ANON_ID_KEY];
  if (!id || typeof id !== "string" || id.length > 64) {
    id = randomId();
    await chrome.storage.local.set({ [ANON_ID_KEY]: id });
  }
  return id;
}

async function getCachedTier() {
  try {
    const data = await chrome.storage.local.get(TIER_CACHE_KEY);
    const tier = data?.[TIER_CACHE_KEY];
    if (tier === "PRO" || tier === "PROFI" || tier === "FREE") return tier;
  } catch {}
  return "FREE";
}

async function isOptedOut() {
  try {
    const data = await chrome.storage.local.get(OPTOUT_KEY);
    return data?.[OPTOUT_KEY] === true;
  } catch {}
  return false;
}

// Whitelist + clamp every extra field. Anything not listed is dropped so a
// hostile content-script message can't smuggle PII or huge payloads into
// our telemetry table.
function sanitizeExtra(type, extra) {
  if (!extra || typeof extra !== "object") return {};
  const out = {};

  if (typeof extra.store === "string") {
    const store = extra.store.slice(0, 30).replace(/[^a-z0-9_-]/gi, "");
    if (globalThis.evgContract?.EXTENSION_STORES?.has(store)) out.store = store;
  }

  // Counts. Floor + clamp 0..500. Drop NaN/Infinity.
  for (const key of ["matchedCount", "totalCount", "unknownCount"]) {
    const v = extra[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      out[key] = Math.max(0, Math.min(500, Math.floor(v)));
    }
  }

  // Slug / feature key. Lowercase + restricted charset, max 100.
  if (typeof extra.target === "string") {
    const target = extra.target.slice(0, 100).replace(/[^a-z0-9_:\-./]/gi, "");
    if (target) out.target = target;
  }

  // Error code (only meaningful for ERROR events).
  if (type === "ERROR") {
    if (typeof extra.errorCode === "string") {
      out.errorCode = extra.errorCode.slice(0, 64).replace(/[^a-z0-9_\-:.]/gi, "");
    }
    if (typeof extra.comment === "string") {
      out.comment = extra.comment.slice(0, 2000);
    }
  }

  return out;
}

/**
 * One POST attempt against a host. Returns true on a 2xx, false on anything
 * else — a non-2xx is as much a loss as a thrown fetch, and both belong in
 * the retry queue.
 */
async function postTo(url, payload, checkVersionHeader) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    keepalive: true,
    credentials: "omit",
    referrer: "",
    mode: "cors",
    // A hung request would hold the queue lock below for as long as the
    // worker lives, and every event behind it would die with the worker.
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  });
  if (checkVersionHeader) {
    try {
      const check = globalThis.evgContract?.checkApiVersion(res.headers);
      if (check?.outdated) markApiOutdated();
    } catch {}
  }
  return res.ok;
}

/**
 * Deliver one payload. Primary host first, direct-to-Vercel second.
 * Returns true when the event landed somewhere, false when it must be queued.
 */
async function deliver(payload) {
  try {
    if (await postTo(EVENT_URL, { ...payload, via: "com" }, true)) return true;
  } catch {}
  try {
    if (await postTo(FALLBACK_EVENT_URL, { ...payload, via: "vercel" }, false)) return true;
  } catch {}
  return false;
}

async function readQueue() {
  try {
    const data = await chrome.storage.local.get(QUEUE_KEY);
    const q = data?.[QUEUE_KEY];
    return Array.isArray(q) ? q : [];
  } catch {
    return [];
  }
}

async function writeQueue(queue) {
  try {
    await chrome.storage.local.set({ [QUEUE_KEY]: queue.slice(-QUEUE_MAX) });
  } catch {}
}

// Every read-modify-write of the queue goes through this one chain. Without
// it, two wake-ups at once (cold start + hourly alarm) replayed the same event
// twice, and two failed sends at once overwrote each other in storage, losing
// one of them. Both happened on a real install on 9 October 2026: one Sephora
// error arrived as two rows, and the SCAN before it never arrived.
let queueChain = Promise.resolve();

function withQueueLock(fn) {
  const run = queueChain.then(fn);
  queueChain = run.catch(() => {});
  return run;
}

function enqueue(payload) {
  return withQueueLock(async () => {
    const queue = await readQueue();
    queue.push(payload);
    await writeQueue(queue);
  });
}

/**
 * Replay queued events oldest first. Stops at the first failure and keeps the
 * remainder — if the network is down there is no point burning the whole
 * queue against it, and order matters for install-then-activity cohorts.
 * The queue is saved after every delivered event, so a worker killed halfway
 * does not resend on the next wake what already landed.
 */
function flushQueue() {
  return withQueueLock(async () => {
    if (await isOptedOut()) {
      await writeQueue([]);
      return;
    }
    const queue = await readQueue();
    while (queue.length) {
      const ok = await deliver(queue[0]);
      if (!ok) break;
      queue.shift();
      await writeQueue(queue);
    }
  });
}

async function sendEvent(type, extra = {}) {
  if (!ALLOWED_EVENT_TYPES.has(type)) return;
  if (await isOptedOut()) return;

  // Throttle by type so a tampered tab can't flood our endpoint with
  // PANEL_SHOWN/PANEL_CTA_CLICK. UNINSTALL_FEEDBACK is user-initiated
  // and goes through the /uninstall page, so it never reaches here.
  const now = Date.now();
  const last = lastSentAt.get(type) || 0;
  if (now - last < EVENT_MIN_INTERVAL_MS) return;
  lastSentAt.set(type, now);

  let payload;
  try {
    const [anonymousId, tier] = await Promise.all([getAnonymousId(), getCachedTier()]);
    payload = {
      type,
      version: chrome.runtime.getManifest().version,
      anonymousId,
      sessionId: SESSION_ID,
      locale: chrome.i18n.getUILanguage(),
      tier,
      channel: CHANNEL,
      at: new Date(now).toISOString(),
      ...sanitizeExtra(type, extra),
    };
  } catch {
    return;
  }

  const ok = await deliver(payload);
  if (!ok) {
    await enqueue(payload);
    return;
  }
  // Piggyback the queue on any successful send: if we are online now, the
  // backlog can go out now too.
  await flushQueue();
}

/**
 * One HEARTBEAT per calendar day per install. The alarm ticks hourly because a
 * 24-hour period would silently skip anyone who does not keep the browser open
 * long enough for it to come due.
 */
async function maybeHeartbeat() {
  try {
    if (await isOptedOut()) return;
    const today = new Date().toISOString().slice(0, 10);
    const data = await chrome.storage.local.get(HEARTBEAT_DAY_KEY);
    if (data?.[HEARTBEAT_DAY_KEY] === today) return;
    await chrome.storage.local.set({ [HEARTBEAT_DAY_KEY]: today });
    await sendEvent("HEARTBEAT");
  } catch {}
}

function ensureHeartbeatAlarm() {
  try {
    chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 60 });
  } catch {}
}

function markApiOutdated() {
  try {
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
  } catch {
    /* action API unavailable in some test contexts */
  }
}

async function setUninstallUrl() {
  try {
    const anonymousId = await getAnonymousId();
    let lang = "en";
    try {
      lang = (chrome.i18n.getUILanguage() || "").startsWith("ru") ? "ru" : "en";
    } catch {}
    const url = `${SITE_URL}/${lang}/uninstall?aid=${encodeURIComponent(anonymousId)}&v=${encodeURIComponent(chrome.runtime.getManifest().version)}`;
    await chrome.runtime.setUninstallURL(url);
  } catch {}
}

// Mirror the SESSION_ID to chrome.storage.session so popup/content can read it
// when they want their own events tagged with the same session. Best-effort.
try {
  if (chrome.storage?.session) {
    chrome.storage.session.set({ [SESSION_ID_KEY]: SESSION_ID });
  }
} catch {}

chrome.runtime.onInstalled.addListener(async (details) => {
  await setUninstallUrl();
  ensureHeartbeatAlarm();
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
    await sendEvent("INSTALL");
    // Mark today as heartbeaten: INSTALL already proves the install is alive,
    // and a duplicate ping in the same hour adds nothing.
    try {
      await chrome.storage.local.set({ [HEARTBEAT_DAY_KEY]: new Date().toISOString().slice(0, 10) });
    } catch {}
  } else if (details.reason === "update") {
    await sendEvent("UPDATE");
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await setUninstallUrl();
  ensureHeartbeatAlarm();
  await flushQueue();
  await maybeHeartbeat();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== HEARTBEAT_ALARM) return;
  await flushQueue();
  await maybeHeartbeat();
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  // Reject anything that didn't originate from our own extension (popup, our content scripts).
  // sender.id is the extension id for internal messages. External messages also have sender.id
  // but only if externally_connectable is declared — we don't declare it, so this is a defense in depth.
  if (!sender || sender.id !== chrome.runtime.id) return;

  if (msg && msg.action === "track" && typeof msg.type === "string") {
    sendEvent(msg.type, msg.data);
    return;
  }

  if (msg && msg.action === "apiOutdated") {
    markApiOutdated();
  }
});

// Cold start of the worker for any reason is also a chance to drain the queue.
ensureHeartbeatAlarm();
flushQueue();
