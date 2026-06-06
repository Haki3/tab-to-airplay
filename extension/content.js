// AirPlay Tab Caster — content script (polished UI)
// A floating AirPlay button detects the video you're watching, asks to confirm, then
// hands the source URL to the background worker -> native macOS helper -> AirPlay.
// UI only renders in the top frame; iframes still report their videos to the popup.

(() => {
  const IS_TOP = window.top === window;

  const AIRPLAY_SVG = `
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M6 16H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-1"
            stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M12 14.2 16.5 20h-9L12 14.2Z" fill="currentColor"/>
    </svg>`;

  // ---- Video discovery -----------------------------------------------------

  const isPlayable = (s) => !!s && /^https?:/i.test(s) && !s.startsWith("blob:") && !s.startsWith("data:");

  function videoSource(v) {
    if (isPlayable(v.currentSrc)) return v.currentSrc;
    if (isPlayable(v.src)) return v.src;
    for (const s of v.querySelectorAll("source")) if (isPlayable(s.src)) return s.src;
    return null;
  }

  function visibleArea(el) {
    const r = el.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    return w * h;
  }

  function domCandidates() {
    const out = [];
    for (const v of document.querySelectorAll("video")) {
      const src = videoSource(v);
      const playing = !v.paused && !v.ended && v.readyState > 2;
      out.push({
        src, playable: !!src, playing, area: visibleArea(v),
        kind: src && /\.m3u8(\?|#|$)/i.test(src) ? "hls" : "file",
      });
    }
    out.sort((a, b) => (b.playing - a.playing) || (b.area - a.area));
    return out;
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg && msg.type === "getDomVideos") {
      sendResponse({ items: domCandidates(), pageUrl: location.href });
    }
  });

  if (!IS_TOP) return;

  // ---- UI -------------------------------------------------------------------

  let host, shadow, fab, badge, panel, open = false;

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
    .wrap { position: fixed; right: 20px; bottom: 20px; z-index: 2147483647; }
    .fab {
      width: 54px; height: 54px; border-radius: 50%; border: none; cursor: pointer;
      background: linear-gradient(180deg, #0a8cff, #0066e0); color: #fff;
      display: grid; place-items: center; position: relative;
      box-shadow: 0 6px 18px rgba(0,0,0,.32), 0 0 0 0 rgba(10,132,255,.5);
      transition: transform .14s cubic-bezier(.2,.8,.3,1), box-shadow .2s ease;
    }
    .fab svg { width: 26px; height: 26px; }
    .fab:hover { transform: translateY(-2px) scale(1.05); box-shadow: 0 10px 26px rgba(0,0,0,.4); }
    .fab:active { transform: scale(.95); }
    .fab.pulse { animation: pulse 2s ease-out infinite; }
    @keyframes pulse {
      0% { box-shadow: 0 6px 18px rgba(0,0,0,.32), 0 0 0 0 rgba(10,132,255,.55); }
      70% { box-shadow: 0 6px 18px rgba(0,0,0,.32), 0 0 0 12px rgba(10,132,255,0); }
      100% { box-shadow: 0 6px 18px rgba(0,0,0,.32), 0 0 0 0 rgba(10,132,255,0); }
    }
    .badge {
      position: absolute; top: -3px; right: -3px; min-width: 19px; height: 19px; padding: 0 5px;
      border-radius: 10px; background: #30d158; color: #04210d; font-size: 11px; font-weight: 800;
      display: none; place-items: center; box-shadow: 0 1px 4px rgba(0,0,0,.35); border: 2px solid #0a0a0a;
    }
    .badge.show { display: grid; }

    .panel {
      position: absolute; right: 0; bottom: 66px; width: 330px; max-width: calc(100vw - 40px);
      background: rgba(30,30,32,.97); color: #f2f2f4; border-radius: 16px;
      box-shadow: 0 18px 50px rgba(0,0,0,.55), inset 0 0 0 .5px rgba(255,255,255,.08);
      backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
      opacity: 0; transform: translateY(8px) scale(.97); pointer-events: none;
      transition: opacity .16s ease, transform .16s cubic-bezier(.2,.8,.3,1);
      overflow: hidden;
    }
    .panel.open { opacity: 1; transform: none; pointer-events: auto; }
    .hd { display: flex; align-items: center; gap: 10px; padding: 15px 16px 10px; }
    .hd .ic { width: 30px; height: 30px; border-radius: 8px; background: rgba(10,132,255,.18);
              color: #4da3ff; display: grid; place-items: center; flex: none; }
    .hd .ic svg { width: 18px; height: 18px; }
    .hd .t { font-size: 14.5px; font-weight: 650; line-height: 1.2; }
    .hd .x { margin-left: auto; background: none; border: none; color: #8e8e93; cursor: pointer;
             font-size: 20px; line-height: 1; padding: 2px 4px; border-radius: 6px; }
    .hd .x:hover { background: rgba(255,255,255,.08); color: #fff; }
    .bd { padding: 4px 16px 16px; }

    .vid { background: rgba(255,255,255,.05); border-radius: 11px; padding: 11px 12px; margin-bottom: 10px; }
    .vid .row1 { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
    .vid .name { font-weight: 600; font-size: 13px; }
    .chip { font-size: 10px; font-weight: 700; letter-spacing: .03em; text-transform: uppercase;
            padding: 2px 7px; border-radius: 999px; background: rgba(10,132,255,.2); color: #6cb2ff; }
    .chip.live { background: rgba(48,209,88,.2); color: #4fd877; }
    .vid .url { font-size: 11px; color: #98989d; word-break: break-all; line-height: 1.35; max-height: 2.7em; overflow: hidden; }

    .switch { display: flex; align-items: center; justify-content: space-between; margin: -2px 0 10px; }
    .switch span { font-size: 11.5px; color: #98989d; }
    .switch button { background: none; border: none; color: #4da3ff; cursor: pointer; font-size: 12px; font-weight: 600; padding: 3px 6px; border-radius: 6px; }
    .switch button:hover { background: rgba(77,163,255,.12); }

    .btns { display: flex; gap: 8px; }
    .btn { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 7px;
           padding: 10px 12px; border-radius: 10px; border: none; cursor: pointer; font-size: 13.5px; font-weight: 650;
           transition: background .12s ease, transform .08s ease; }
    .btn:active { transform: scale(.97); }
    .btn svg { width: 17px; height: 17px; }
    .primary { background: #0a84ff; color: #fff; flex: 1.6; }
    .primary:hover { background: #0a78ec; }
    .ghost { background: rgba(255,255,255,.09); color: #f2f2f4; }
    .ghost:hover { background: rgba(255,255,255,.15); }

    .status { display: flex; align-items: center; gap: 8px; font-size: 12.5px; margin-top: 12px; line-height: 1.4; }
    .status.hide { display: none; }
    .spinner { width: 15px; height: 15px; border-radius: 50%; border: 2px solid rgba(255,255,255,.25);
               border-top-color: #4da3ff; animation: spin .7s linear infinite; flex: none; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .ok { color: #4fd877; } .warn { color: #ffb340; } .err { color: #ff6961; }

    .empty { text-align: center; padding: 6px 6px 10px; }
    .empty .big { font-size: 13px; font-weight: 600; color: #ffb340; margin-bottom: 6px; }
    .empty .sub { font-size: 11.5px; color: #98989d; line-height: 1.5; }

    .toast {
      position: absolute; right: 0; bottom: 66px; background: rgba(30,30,32,.97); color: #f2f2f4;
      border-radius: 12px; padding: 11px 14px; font-size: 12.5px; display: flex; align-items: center; gap: 9px;
      box-shadow: 0 14px 40px rgba(0,0,0,.5), inset 0 0 0 .5px rgba(255,255,255,.08);
      opacity: 0; transform: translateY(8px); pointer-events: none; transition: opacity .2s, transform .2s; white-space: nowrap;
    }
    .toast.show { opacity: 1; transform: none; }
  `;

  function ensureUI() {
    if (host) return;
    host = document.createElement("div");
    host.id = "__airplay_tab_caster__";
    (document.body || document.documentElement).appendChild(host);
    shadow = host.attachShadow({ mode: "open" });

    const st = document.createElement("style");
    st.textContent = STYLE;
    shadow.appendChild(st);

    const wrap = document.createElement("div");
    wrap.className = "wrap";
    wrap.innerHTML = `
      <button class="fab" title="Enviar este video a AirPlay" aria-label="AirPlay">${AIRPLAY_SVG}
        <span class="badge"></span>
      </button>
      <div class="panel" role="dialog" aria-label="AirPlay"></div>
      <div class="toast"></div>`;
    shadow.appendChild(wrap);

    fab = shadow.querySelector(".fab");
    badge = shadow.querySelector(".badge");
    panel = shadow.querySelector(".panel");

    fab.addEventListener("click", (e) => { e.stopPropagation(); open ? closePanel() : openPanel(); });
    document.addEventListener("click", (e) => { if (open && !e.composedPath().includes(host)) closePanel(); });
    document.addEventListener("keydown", (e) => { if (open && e.key === "Escape") closePanel(); });

    refreshBadge();
    document.addEventListener("play", refreshBadge, true);
    setInterval(refreshBadge, 4000);
  }

  let lastCount = -1;
  async function refreshBadge() {
    const dom = domCandidates().filter((d) => d.playable).length;
    let sniff = 0;
    try { const r = await chrome.runtime.sendMessage({ type: "getSniffed" }); sniff = ((r && r.items) || []).length; }
    catch (_) {}
    const count = dom > 0 ? dom : (sniff > 0 ? sniff : 0);
    if (count === lastCount) return;
    lastCount = count;
    if (count > 0) {
      badge.textContent = count > 9 ? "9+" : String(count);
      badge.classList.add("show");
      fab.classList.add("pulse");
    } else {
      badge.classList.remove("show");
      fab.classList.remove("pulse");
    }
  }

  // ---- Panel flow -----------------------------------------------------------

  let candidates = [], idx = 0;

  async function gather() {
    const dom = domCandidates();
    let sniff = [];
    try { const r = await chrome.runtime.sendMessage({ type: "getSniffed" }); sniff = (r && r.items) || []; } catch (_) {}
    const seen = new Set(), list = [];
    for (const d of dom) if (d.playable && !seen.has(d.src)) {
      seen.add(d.src); list.push({ src: d.src, label: d.playing ? "Reproduciéndose ahora" : "Video en la página", kind: d.kind, live: d.playing });
    }
    for (const s of sniff) if (!seen.has(s.url)) {
      seen.add(s.url); list.push({ src: s.url, label: "Stream detectado", kind: s.kind, live: false });
    }
    return list;
  }

  function openPanel() {
    open = true; panel.classList.add("open");
    renderLoading();
    gather().then((list) => { candidates = list; idx = 0; render(); });
  }
  function closePanel() { open = false; panel.classList.remove("open"); }

  const esc = (s) => String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));

  function renderLoading() {
    panel.innerHTML = `
      <div class="hd"><span class="ic">${AIRPLAY_SVG}</span><span class="t">AirPlay</span>
        <button class="x" aria-label="Cerrar">×</button></div>
      <div class="bd"><div class="status"><span class="spinner"></span>Buscando video…</div></div>`;
    panel.querySelector(".x").onclick = closePanel;
  }

  function render() {
    const c = candidates[idx];
    if (!c) {
      panel.innerHTML = `
        <div class="hd"><span class="ic">${AIRPLAY_SVG}</span><span class="t">AirPlay</span>
          <button class="x" aria-label="Cerrar">×</button></div>
        <div class="bd"><div class="empty">
          <div class="big">No encontré un video reproducible</div>
          <div class="sub">Servicios como YouTube cifran el video y no se pueden capturar.<br>
          Prueba en X, Reddit, webs de noticias, .mp4 directos o reproductores HLS.</div>
        </div></div>`;
      panel.querySelector(".x").onclick = closePanel;
      return;
    }
    const more = candidates.length > 1
      ? `<div class="switch"><span>${idx + 1} de ${candidates.length} videos</span><button id="nx">Otro ↻</button></div>` : "";
    panel.innerHTML = `
      <div class="hd"><span class="ic">${AIRPLAY_SVG}</span><span class="t">¿Enviar a tu TV?</span>
        <button class="x" aria-label="Cerrar">×</button></div>
      <div class="bd">
        <div class="vid">
          <div class="row1"><span class="name">${esc(c.label)}</span>
            <span class="chip ${c.live ? "live" : ""}">${c.kind === "hls" ? "HLS" : c.live ? "EN VIVO" : "VIDEO"}</span></div>
          <div class="url">${esc(c.src)}</div>
        </div>
        ${more}
        <div class="btns">
          <button class="btn primary" id="go">${AIRPLAY_SVG}<span>Enviar a AirPlay</span></button>
          <button class="btn ghost" id="cancel">Cancelar</button>
        </div>
        <div class="status hide" id="st"></div>
      </div>`;
    panel.querySelector(".x").onclick = closePanel;
    panel.querySelector("#cancel").onclick = closePanel;
    panel.querySelector("#go").onclick = () => send(c);
    const nx = panel.querySelector("#nx");
    if (nx) nx.onclick = () => { idx = (idx + 1) % candidates.length; render(); };
  }

  function setStatus(html, cls = "") {
    const st = panel.querySelector("#st");
    if (!st) return;
    st.className = "status " + cls;
    st.innerHTML = html;
  }

  async function send(c) {
    const go = panel.querySelector("#go");
    if (go) go.disabled = true;
    setStatus(`<span class="spinner"></span>Enviando a la TV…`);
    let res;
    try { res = await chrome.runtime.sendMessage({ type: "airplay", url: c.src, referer: location.href, title: document.title }); }
    catch (e) { res = { ok: false, error: String(e) }; }

    if (res && res.ok) {
      setStatus(`<span class="ok">✓ Abriendo el reproductor — toca AirPlay y elige tu TV.</span>`, "ok");
      toast(`<span class="ok">✓</span> Enviado a AirPlay`);
      setTimeout(closePanel, 2200);
    } else if (res && res.nativeMissing) {
      setStatus(`<span class="warn">No encuentro el helper nativo. Ejecuta <b>install.sh</b> una vez.</span>`, "warn");
      if (go) go.disabled = false;
    } else {
      setStatus(`<span class="err">Error: ${esc((res && res.error) || "desconocido")}</span>`, "err");
      if (go) go.disabled = false;
    }
  }

  function toast(html) {
    const t = shadow.querySelector(".toast");
    t.innerHTML = html;
    t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), 2600);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ensureUI);
  else ensureUI();
})();
