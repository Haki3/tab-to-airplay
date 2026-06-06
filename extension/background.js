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

// ---- Candidate analysis: rank streams by real content / duration --------------
// Chrome (this worker) can fetch the playlists directly (its session + Secure DNS),
// so we download each .m3u8, sum the segment durations, and surface the longest one
// as the likely real video (vs short ads/clips/previews).

async function fetchText(url, ms = 7000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { credentials: "include", signal: ctrl.signal, redirect: "follow" });
    clearTimeout(t);
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, text: await r.text(), finalUrl: r.url, contentType: r.headers.get("content-type") || "" };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, error: String(e) };
  }
}

function sumDurations(playlist) {
  let total = 0, n = 0;
  const re = /#EXTINF:\s*([\d.]+)/g;
  let m;
  while ((m = re.exec(playlist))) { total += parseFloat(m[1]) || 0; n++; }
  return { total, segments: n };
}

// Pick the highest-bandwidth variant URI from a master playlist (absolute URL).
function bestVariant(master, baseUrl) {
  const lines = master.split(/\r?\n/);
  let bestBw = -1, bestUri = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
      const bw = parseInt((lines[i].match(/BANDWIDTH=(\d+)/) || [])[1] || "0", 10);
      // the URI is the next non-comment, non-empty line
      for (let j = i + 1; j < lines.length; j++) {
        const u = lines[j].trim();
        if (!u) continue;
        if (u.startsWith("#")) break;
        if (bw >= bestBw) { bestBw = bw; bestUri = u; }
        break;
      }
    }
  }
  if (!bestUri) return null;
  try { return new URL(bestUri, baseUrl).href; } catch (_) { return null; }
}

async function analyzeOne(it) {
  const out = { url: it.url, kind: it.kind, ok: false, durationSec: 0, isMaster: false, live: !!it.live };
  const isM3u8 = it.kind === "hls" || /\.m3u8(\?|#|$)/i.test(it.url);
  try {
    if (isM3u8) {
      const r = await fetchText(it.url);
      if (r.ok && /#EXTM3U/.test(r.text)) {
        out.ok = true;
        const base = r.finalUrl || it.url;
        if (/#EXT-X-STREAM-INF/.test(r.text)) {
          out.isMaster = true;
          const variant = bestVariant(r.text, base);
          if (variant) {
            const v = await fetchText(variant);
            if (v.ok && /#EXTINF/.test(v.text)) {
              const d = sumDurations(v.text);
              out.durationSec = d.total; out.segments = d.segments;
              out.live = !/#EXT-X-ENDLIST/.test(v.text);
            }
          }
        } else if (/#EXTINF/.test(r.text)) {
          const d = sumDurations(r.text);
          out.durationSec = d.total; out.segments = d.segments;
          out.live = !/#EXT-X-ENDLIST/.test(r.text);
        }
      }
    } else {
      const h = await fetch(it.url, { method: "HEAD", credentials: "include" }).catch(() => null);
      if (h && h.ok) { out.ok = true; out.sizeBytes = parseInt(h.headers.get("content-length") || "0", 10) || 0; }
    }
  } catch (_) { /* leave ok=false */ }
  return out;
}

function scoreOf(a) {
  if (a.durationSec > 0) return a.durationSec;          // real video: longer = better
  if (a.isMaster && a.ok) return 0.5;                   // master playlist, duration unknown
  if (a.sizeBytes) return Math.min(a.sizeBytes / 1e6, 0.4); // mp4 size proxy, capped below real durations
  if (a.ok) return 0.05;
  return 0;
}

async function analyzeCandidates(items) {
  const analyzed = await Promise.all((items || []).map(analyzeOne));
  analyzed.forEach((a) => { a.score = scoreOf(a); });
  analyzed.sort((x, y) => y.score - x.score);
  // Mark the best as the likely stream when we have a meaningful signal.
  if (analyzed.length && analyzed[0].score > 0) analyzed[0].recommended = true;
  return { items: analyzed };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === "analyze") {
    analyzeCandidates(msg.items).then(sendResponse);
    return true; // async
  }

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
