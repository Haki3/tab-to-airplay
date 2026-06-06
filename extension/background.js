// AirPlay Tab Caster — service worker
// Responsibilities:
//   1. Sniff media URLs (.mp4/.m3u8/.mpd/.webm + video/* responses) per tab so we can
//      surface playable streams even when the page hides them behind a player.
//   2. Relay a chosen video URL to the native macOS helper via Native Messaging,
//      enriching it with Referer / User-Agent / Cookie so protected videos still play.

const NATIVE_HOST = "com.reda.airplaycaster";

// tabId -> Map<url, {url, contentType, kind, ts}>  (insertion order preserved, capped)
const sniffed = new Map();
const MAX_PER_TAB = 30;

const MEDIA_URL_RE = /\.(m3u8|mpd|mp4|m4v|mov|webm|ts|aac|mp3)(\?|#|$)/i;

function classify(url, contentType) {
  const ct = (contentType || "").toLowerCase();
  if (/mpegurl/.test(ct) || /\.m3u8(\?|#|$)/i.test(url)) return "hls";
  if (/dash\+xml/.test(ct) || /\.mpd(\?|#|$)/i.test(url)) return "dash";
  if (/^video\//.test(ct) || /\.(mp4|m4v|mov|webm)(\?|#|$)/i.test(url)) return "file";
  if (/^audio\//.test(ct) || /\.(mp3|aac)(\?|#|$)/i.test(url)) return "audio";
  return "other";
}

function remember(tabId, url, contentType) {
  if (tabId < 0 || !url || url.startsWith("blob:") || url.startsWith("data:")) return;
  const kind = classify(url, contentType);
  if (kind === "other") return; // not something AVPlayer can use
  let m = sniffed.get(tabId);
  if (!m) { m = new Map(); sniffed.set(tabId, m); }
  if (m.has(url)) { m.get(url).ts = Date.now(); return; }
  m.set(url, { url, contentType: contentType || "", kind, ts: Date.now() });
  // cap (drop oldest)
  while (m.size > MAX_PER_TAB) m.delete(m.keys().next().value);
}

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    let ct = "";
    for (const h of details.responseHeaders || []) {
      if (h.name.toLowerCase() === "content-type") { ct = h.value || ""; break; }
    }
    const looksMedia = MEDIA_URL_RE.test(details.url) || details.type === "media" ||
      /^(video|audio)\//i.test(ct) || /mpegurl|dash\+xml/i.test(ct);
    if (looksMedia) remember(details.tabId, details.url, ct);
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// Reset a tab's sniffed list on top-frame navigation, and clean up closed tabs.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) sniffed.delete(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => sniffed.delete(tabId));

function getSniffedList(tabId) {
  const m = sniffed.get(tabId);
  if (!m) return [];
  return Array.from(m.values()).sort((a, b) => b.ts - a.ts);
}

async function buildCookieHeader(url) {
  try {
    const cookies = await chrome.cookies.getAll({ url });
    if (!cookies || !cookies.length) return "";
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch (_) {
    return "";
  }
}

async function sendToNative({ url, referer, title }) {
  const cookie = await buildCookieHeader(url);
  const message = {
    url,
    referer: referer || "",
    title: title || "",
    cookie,
    userAgent: navigator.userAgent || ""
  };
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message, nativeMissing: true });
        } else {
          resolve(response || { ok: true });
        }
      });
    } catch (e) {
      resolve({ ok: false, error: String(e), nativeMissing: true });
    }
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === "getSniffed") {
    const tabId = msg.tabId ?? sender.tab?.id ?? -1;
    sendResponse({ items: getSniffedList(tabId) });
    return; // sync
  }

  if (msg.type === "airplay") {
    sendToNative({ url: msg.url, referer: msg.referer, title: msg.title }).then(sendResponse);
    return true; // async
  }
});
