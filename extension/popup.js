// Popup: list every playable video/stream found in the active tab and send any to AirPlay.

const AIRPLAY_SVG = `
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M6 16H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-1"
          stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M12 14.2 16.5 20h-9L12 14.2Z" fill="currentColor"/>
  </svg>`;

const listEl = document.getElementById("list");
const toastEl = document.getElementById("toast");
document.getElementById("logo").innerHTML = AIRPLAY_SVG;
document.getElementById("ver").textContent = "v" + (chrome.runtime.getManifest().version || "");

const esc = (s) => String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
function fmtDur(s) {
  if (!s) return ""; s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function collect(tab) {
  const seen = new Set(), items = [];
  let frames = [];
  try {
    frames = await chrome.tabs.sendMessage(tab.id, { type: "getDomVideos" })
      .then((r) => (r && r.items) || []).catch(() => []);
  } catch (_) {}
  for (const d of frames) if (d.playable && d.src && !seen.has(d.src)) {
    seen.add(d.src);
    items.push({ src: d.src, label: d.playing ? "Reproduciéndose ahora" : "Video en la página", kind: d.kind, live: d.playing });
  }
  try {
    const res = await chrome.runtime.sendMessage({ type: "getSniffed", tabId: tab.id });
    for (const s of (res && res.items) || []) if (!seen.has(s.url)) {
      seen.add(s.url);
      items.push({ src: s.url, label: "Stream detectado", kind: s.kind, live: false });
    }
  } catch (_) {}
  return items;
}

let analysisInfo = null;

function loading(msg) {
  listEl.innerHTML = `<div class="state"><div class="spinner"></div><div class="sub">${esc(msg || "Buscando videos…")}</div></div>`;
}

function render(items, tab) {
  if (!items.length) {
    const inner = (analysisInfo && analysisInfo.total > 0)
      ? `<div class="big warn">Ningún stream respondió</div>
         <div class="sub">Detecté ${analysisInfo.total} stream(s), pero ninguno cargó sus segmentos.<br>
         Puede requerir iniciar sesión o el enlace caducó. Recarga el video y reintenta.</div>`
      : `<div class="big warn">No encontré un video reproducible</div>
         <div class="sub">YouTube y similares cifran el video (no se puede capturar).<br>
         Funciona en X, Reddit, .mp4 directos y reproductores HLS.</div>`;
    listEl.innerHTML = `<div class="state">${inner}</div>`;
    return;
  }
  listEl.innerHTML = "";
  items.forEach((it) => {
    const kindLabel = it.kind === "hls" ? (it.live ? "HLS · EN VIVO" : "HLS") : "VIDEO";
    const rec = it.recommended ? `<span class="chip rec">★ Probable</span>` : "";
    const dur = it.durationSec ? `<div class="meta"><span class="dur">⏱ ${fmtDur(it.durationSec)}</span></div>` : "";
    const card = document.createElement("div");
    card.className = "card" + (it.recommended ? " rec" : "");
    card.innerHTML = `
      <div class="top"><span class="name">${esc(it.label)}</span>${rec}
        <span class="chip ${it.live ? "live" : ""}">${kindLabel}</span></div>
      ${dur}
      <div class="url">${esc(it.src)}</div>
      <button>${AIRPLAY_SVG}<span>Enviar a AirPlay</span></button>`;
    card.querySelector("button").onclick = (e) => send(it, tab, e.currentTarget);
    listEl.appendChild(card);
  });
}

function toast(html, cls = "") {
  toastEl.className = "toast show";
  toastEl.innerHTML = `<span class="${cls}">${html}</span>`;
}

async function send(it, tab, btn) {
  btn.disabled = true;
  btn.innerHTML = `${AIRPLAY_SVG}<span>Enviando…</span>`;
  let res;
  try { res = await chrome.runtime.sendMessage({ type: "airplay", url: it.src, referer: tab.url, title: tab.title }); }
  catch (e) { res = { ok: false, error: String(e) }; }

  if (res && res.ok) {
    toast("✓ Enviado — toca AirPlay en la ventana y elige tu TV.", "ok");
    btn.innerHTML = `${AIRPLAY_SVG}<span>Enviado ✓</span>`;
  } else if (res && res.nativeMissing) {
    toast("No encuentro el helper nativo. Ejecuta install.sh una vez.", "warn");
    btn.disabled = false; btn.innerHTML = `${AIRPLAY_SVG}<span>Enviar a AirPlay</span>`;
  } else {
    toast("Error: " + esc((res && res.error) || "desconocido"), "err");
    btn.disabled = false; btn.innerHTML = `${AIRPLAY_SVG}<span>Enviar a AirPlay</span>`;
  }
}

(async () => {
  loading();
  const tab = await activeTab();
  const found = await collect(tab);
  if (!found.length) { render([], tab); return; }

  // Verify which candidates actually play (segments load) BEFORE listing them.
  loading("Comprobando qué stream reproduce…");
  let res;
  try {
    res = await chrome.runtime.sendMessage({
      type: "analyze", items: found.map((c) => ({ url: c.src, kind: c.kind, live: c.live })),
    });
  } catch (_) {}

  let items = found;
  if (res && res.items) {
    const by = {};
    res.items.forEach((a) => { by[a.url] = a; });
    found.forEach((c) => {
      const a = by[c.src];
      if (a) Object.assign(c, {
        durationSec: a.durationSec, recommended: a.recommended, isMaster: a.isMaster,
        live: a.live, score: a.score, playable: a.playable,
      });
    });
    items = found.filter((c) => c.playable).sort((x, y) => (y.score || 0) - (x.score || 0));
    analysisInfo = { total: res.total, viable: res.viable };
  }
  render(items, tab);
})();
