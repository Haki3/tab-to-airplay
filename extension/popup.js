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

function loading() {
  listEl.innerHTML = `<div class="state"><div class="spinner"></div><div class="sub">Buscando videos…</div></div>`;
}

function render(items, tab) {
  if (!items.length) {
    listEl.innerHTML = `<div class="state">
      <div class="big warn">No encontré un video reproducible</div>
      <div class="sub">YouTube y similares cifran el video (no se puede capturar).<br>
      Funciona en X, Reddit, .mp4 directos y reproductores HLS.</div></div>`;
    return;
  }
  listEl.innerHTML = "";
  items.forEach((it) => {
    const chip = it.kind === "hls" ? "HLS" : it.live ? "EN VIVO" : "VIDEO";
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="top"><span class="name">${esc(it.label)}</span>
        <span class="chip ${it.live ? "live" : ""}">${chip}</span></div>
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
  render(await collect(tab), tab);
})();
