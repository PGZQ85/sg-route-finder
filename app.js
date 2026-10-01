/* global L, Planner */
"use strict";

const BUSROUTER = "https://data.busrouter.sg/v1/";
const ARRIVELAH = "https://arrivelah2.busrouter.sg/?id=";
const DATAGOV = "https://api.data.gov.sg/v1/";
const ONEMAP_SEARCH = "https://www.onemap.gov.sg/api/common/elastic/search?returnGeom=Y&getAddrDetails=Y&pageNum=1&searchVal=";
const LIVE_STOPS = 14;       // origin-area stops to fetch live arrivals for
const REFRESH_MS = 60_000;

const PRESETS = {
  "compass one": { lat: 1.39205, lng: 103.89507, name: "Compass One" },
  harbourfront: { lat: 1.26537, lng: 103.82200, name: "HarbourFront / VivoCity" },
};

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtMin = (m) => (m < 60 ? `${Math.round(m)} min` : `${Math.floor(m / 60)} h ${Math.round(m % 60)} min`);
const fmtKm = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);
const clock = (d) => d.toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit", hour12: false });
const setStatus = (t) => { $("#status").textContent = t; };

const state = {
  net: null, routes: null, from: null, to: null,
  results: { fastest: [], shortest: [] }, mode: "fastest", selected: 0, timer: null,
};

// ---------- data ----------

async function getJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}
// Local copy first (run `npm run fetch-data`), busrouter.sg as fallback.
const loadStatic = (f) => getJSON(`data/${f}`).catch(() => getJSON(BUSROUTER + f));

async function loadNetwork() {
  setStatus("Loading bus stops, services and MRT lines…");
  const [stops, services, routes, mrt] = await Promise.all([
    loadStatic("stops.min.json"), loadStatic("services.min.json"), loadStatic("routes.min.json"),
    getJSON("data/mrt.json").catch(() => { throw new Error("data/mrt.json missing — run: npm run fetch-data"); }),
  ]);
  state.routes = routes;
  state.net = Planner.buildNetwork(stops, services, mrt);
  const nBus = state.net.patterns.filter((p) => p.kind === "bus").length;
  setStatus(`${Object.keys(stops).length.toLocaleString()} stops · ${nBus} bus routes · ${mrt.lines.length} MRT lines`);
}

// Live arrivals (minutes from now) per stop code -> service -> [next, subsequent, …].
async function fetchArrivals(codes, live = new Map()) {
  await Promise.all(codes.map(async (code) => {
    try {
      const j = await getJSON(ARRIVELAH + code);
      const m = new Map();
      for (const s of j.services || []) {
        const times = [s.next, s.subsequent, s.next2, s.next3]
          .filter((x) => x && x.time)
          .map((x) => Math.max(0, (Date.parse(x.time) - Date.now()) / 60000));
        if (times.length) m.set(s.no, times);
      }
      live.set(code, m);
    } catch { /* no live data for this stop: planner falls back to typical waits */ }
  }));
  return live;
}

// Start with the stops you can walk to from the origin.
function originStops(from) {
  return state.net.near(from.lat, from.lng, Planner.params.accessRadius)
    .filter(([i]) => state.net.nodes[i].kind === "bus")
    .sort((a, b) => a[1] - b[1]).slice(0, LIVE_STOPS)
    .map(([i]) => state.net.nodes[i].code);
}

async function conditions(from, to) {
  const nearest = (meta, p) => meta.reduce((best, a) => {
    const d = Planner.hav(p.lat, p.lng, a.label_location.latitude, a.label_location.longitude);
    return d < best.d ? { a, d } : best;
  }, { d: Infinity }).a;

  const [wx, psi, taxi] = await Promise.allSettled([
    getJSON(DATAGOV + "environment/2-hour-weather-forecast"),
    getJSON(DATAGOV + "environment/psi"),
    getJSON(DATAGOV + "transport/taxi-availability"),
  ]);
  const out = {};
  if (wx.status === "fulfilled") {
    const f = new Map(wx.value.items[0].forecasts.map((x) => [x.area, x.forecast]));
    const a = nearest(wx.value.area_metadata, from), b = nearest(wx.value.area_metadata, to);
    out.wxFrom = { area: a.name, text: f.get(a.name) };
    out.wxTo = { area: b.name, text: f.get(b.name) };
    out.wet = /shower|rain|thunder/i.test(`${out.wxFrom.text} ${out.wxTo.text}`);
  }
  if (psi.status === "fulfilled") {
    const r = psi.value.items[0].readings.psi_twenty_four_hourly;
    out.psi = Math.max(...Object.values(r));
  }
  if (taxi.status === "fulfilled") {
    const pts = taxi.value.features[0].geometry.coordinates;
    out.taxis = pts.filter(([lng, lat]) => Planner.hav(from.lat, from.lng, lat, lng) <= 1000).length;
  }
  return out;
}

function renderConditions(c) {
  const box = (label, value, alert) => `<div class="cond${alert ? " alert" : ""}"><span>${esc(label)}</span><b title="${esc(value)}">${esc(value)}</b></div>`;
  $("#conditions").innerHTML = [
    c.wxFrom ? box(`Weather · ${c.wxFrom.area}`, c.wxFrom.text, /shower|rain|thunder/i.test(c.wxFrom.text)) : "",
    c.wxTo ? box(`Weather · ${c.wxTo.area}`, c.wxTo.text, /shower|rain|thunder/i.test(c.wxTo.text)) : "",
    c.taxis !== undefined ? box("Taxis ≤1 km of start", `${c.taxis} free now`) : "",
    c.psi !== undefined ? box("24h PSI (max)", `${c.psi} · ${c.psi <= 50 ? "good" : c.psi <= 100 ? "moderate" : "unhealthy"}`, c.psi > 100) : "",
    c.wet ? box("Rain", "Walks weighted ×1.5", true) : "",
    box("Traffic model", Planner.isPeak(new Date()) ? "Peak hour buses" : "Off-peak buses"),
  ].join("");
}

// ---------- geocoding ----------

async function geocode(q) {
  const key = q.trim().toLowerCase();
  if (PRESETS[key]) return [PRESETS[key]];
  if (/^\d{5}$/.test(key) && state.net) {
    const i = state.net.index.get("B" + key);
    if (i !== undefined) { const n = state.net.nodes[i]; return [{ lat: n.lat, lng: n.lng, name: `${n.name} (${n.code})` }]; }
  }
  const j = await getJSON(ONEMAP_SEARCH + encodeURIComponent(q));
  return (j.results || []).slice(0, 8).map((r) => ({
    lat: +r.LATITUDE, lng: +r.LONGITUDE,
    name: titleCase(r.BUILDING !== "NIL" ? r.BUILDING : r.SEARCHVAL),
    detail: r.ADDRESS,
  }));
}
const titleCase = (s) => s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());

function setupSuggest(input, list, which) {
  let timer, items = [];
  input.addEventListener("input", () => {
    state[which] = null;
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { list.innerHTML = ""; return; }
    timer = setTimeout(async () => {
      try { items = await geocode(q); } catch { items = []; }
      list.innerHTML = items.map((r, i) => `<li data-i="${i}">${esc(r.name)}${r.detail ? `<small>${esc(r.detail)}</small>` : ""}</li>`).join("");
    }, 350);
  });
  list.addEventListener("mousedown", (e) => {
    const li = e.target.closest("li");
    if (!li) return;
    e.preventDefault();
    state[which] = items[+li.dataset.i];
    input.value = state[which].name;
    list.innerHTML = "";
  });
  input.addEventListener("blur", () => setTimeout(() => { list.innerHTML = ""; }, 150));
}

async function resolve(which) {
  if (state[which]) return state[which];
  const q = $("#" + which).value.trim();
  if (!q) throw new Error(`Enter a ${which === "from" ? "starting point" : "destination"}`);
  const [hit] = await geocode(q);
  if (!hit) throw new Error(`Couldn't find "${q}"`);
  state[which] = hit;
  return hit;
}

// ---------- planning ----------

async function planTrip({ quiet = false } = {}) {
  const btn = $("#go");
  btn.disabled = true;
  try {
    const [from, to] = await Promise.all([resolve("from"), resolve("to")]);
    setStatus(quiet ? "Refreshing live data…" : "Fetching live arrivals, weather and taxis…");
    const [live, cond] = await Promise.all([fetchArrivals(originStops(from)), conditions(from, to)]);
    renderConditions(cond);

    setStatus("Searching routes…");
    await new Promise((r) => setTimeout(r)); // let the status paint before the CPU-bound search
    const t0 = performance.now();
    const now = new Date();
    const opts = { from, to, live, walkPenalty: cond.wet ? 1.5 : 1, now, count: 5 };
    // Plan, then check every bus boarding stop against live arrivals and re-plan
    // so services that aren't running right now drop out (a few rounds at most).
    for (let round = 0; round < 3; round++) {
      state.results.fastest = Planner.plan(state.net, { ...opts, mode: "fastest" });
      state.results.shortest = Planner.plan(state.net, { ...opts, mode: "shortest" });
      const todo = Planner.unverifiedStops(state.net, [...state.results.fastest, ...state.results.shortest], live);
      if (!todo.length) break;
      setStatus(`Checking live arrivals at ${todo.length} transfer stops…`);
      await fetchArrivals(todo, live);
    }
    state.planned = now;
    const liveStops = [...live.values()].filter((m) => m.size).length;
    setStatus(`Updated ${clock(now)} · live arrivals from ${liveStops} stops · ${Math.round(performance.now() - t0)} ms`);
    if (!quiet) state.selected = 0;
    renderResults();
    drawMarkers(from, to);
    clearInterval(state.timer);
    state.timer = setInterval(() => { if (!document.hidden) planTrip({ quiet: true }); }, REFRESH_MS);
  } catch (e) {
    console.error(e);
    setStatus(e.message);
  } finally {
    btn.disabled = false;
  }
}

function legChip(l) {
  if (l.type === "walk") return `<span class="chip walk" title="Walk">🚶 ${Math.max(1, Math.round(l.ride))}′</span>`;
  if (l.type === "mrt") {
    const meta = state.net.lineMeta[l.group];
    return `<span class="chip" style="background:${meta.color}" title="${esc(meta.name)}">${esc(l.group)}</span>`;
  }
  return `<span class="chip${l.waitLive ? " live" : ""}" title="Bus ${esc(l.label)}${l.waitLive ? " (live arrival)" : ""}">🚌 ${esc(l.label)}</span>`;
}

function stepHTML(l) {
  const n = state.net.nodes;
  if (l.type === "walk") {
    return `<li><span class="bar walk"></span><div>Walk ${fmtKm(l.distance)}<small>to ${esc(l.to.name || $("#to").value)}</small></div><span class="t">${fmtMin(Math.max(1, l.ride))}</span></li>`;
  }
  const pat = state.net.patterns[l.pattern];
  const color = l.type === "mrt" ? state.net.lineMeta[l.group].color : "var(--bus)";
  const head = l.type === "mrt"
    ? `${esc(state.net.lineMeta[l.group].name)} <small>${esc(pat.title.replace(/^.* towards /, "towards "))}</small>`
    : `Bus ${esc(l.label)} <small>${esc(pat.title)}</small>`;
  const from = n[l.from.node], to = n[l.to.node];
  const code = (x) => (x.code ? ` (${x.code})` : "");
  const wait = l.waitLive
    ? `<span class="live-note">next bus in ${Math.round(l.wait)} min · live</span>`
    : `~${Math.round(l.wait)} min wait${l.type === "mrt" ? " incl. walk to platform" : ""}`;
  return `<li><span class="bar" style="background:${color}"></span><div>${head}
    <small>Board at ${esc(from.name)}${esc(code(from))} → alight ${esc(to.name)}${esc(code(to))}</small>
    <small>${l.stops} stop${l.stops > 1 ? "s" : ""} · ${fmtKm(l.distance)} · ${wait}</small></div>
    <span class="t">${fmtMin(l.ride + l.wait)}</span></li>`;
}

function renderResults() {
  const list = state.results[state.mode];
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.mode === state.mode));
  if (!list.length) { $("#results").innerHTML = `<p class="hint">No route found.</p>`; drawRoute(null); return; }
  $("#results").innerHTML = list.map((j, i) => {
    const arrive = new Date(state.planned.getTime() + j.minutes * 60000);
    const chips = j.legs.map(legChip).join('<span class="sep">›</span>');
    const primary = state.mode === "fastest" ? fmtMin(j.minutes) : fmtKm(j.distance);
    const secondary = state.mode === "fastest" ? fmtKm(j.distance) : fmtMin(j.minutes);
    return `<button class="route${i === state.selected ? " on" : ""}" data-i="${i}" aria-expanded="${i === state.selected}">
      <div class="route-top"><span class="rank">#${i + 1}</span><span class="big">${primary}</span><span class="arrive">arrive ~${clock(arrive)}</span></div>
      <div class="route-meta">${secondary} · ${j.transfers} transfer${j.transfers === 1 ? "" : "s"} · ${fmtKm(j.walking)} walking</div>
      <div class="chips">${chips}</div>
      ${i === state.selected ? `<ol class="steps">${j.legs.map(stepHTML).join("")}</ol>` : ""}
    </button>`;
  }).join("");
  drawRoute(list[state.selected]);
}

// ---------- map ----------

const dark = matchMedia("(prefers-color-scheme: dark)").matches;
const map = L.map("map", {
  zoomControl: false, minZoom: 11, maxZoom: 19,
  maxBounds: [[1.13, 103.55], [1.50, 104.15]], maxBoundsViscosity: 0.8,
}).setView([1.33, 103.86], 12);
L.control.zoom({ position: "topright" }).addTo(map);
L.tileLayer(`https://www.onemap.gov.sg/maps/tiles/${dark ? "Night" : "Default"}/{z}/{x}/{y}.png`, {
  detectRetina: true, maxZoom: 19, minZoom: 11,
  attribution: '<a href="https://www.onemap.gov.sg/" target="_blank" rel="noopener">OneMap</a> © contributors | Singapore Land Authority',
}).addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const pinLayer = L.layerGroup().addTo(map);

function drawMarkers(from, to) {
  pinLayer.clearLayers();
  const pin = (p, cls) => L.marker([p.lat, p.lng], { icon: L.divIcon({ className: "divicon", html: `<div class="pin ${cls}"></div>`, iconSize: [0, 0] }) })
    .bindTooltip(esc(p.name)).addTo(pinLayer);
  pin(from, "pin-a");
  pin(to, "pin-b");
}

function decodePolyline(str) {
  const out = [];
  let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    for (const k of [0, 1]) {
      let shift = 0, result = 0, b;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 31) << shift; shift += 5; } while (b >= 32);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (k === 0) lat += d; else lng += d;
    }
    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}

const shapeCache = new Map();
function busShape(l) {
  const pat = state.net.patterns[l.pattern];
  const enc = state.routes[pat.line] && state.routes[pat.line][pat.dir];
  const nodes = state.net.nodes;
  const fallback = pat.nodes.slice(l.fromIdx, l.toIdx + 1).map((i) => [nodes[i].lat, nodes[i].lng]);
  if (!enc) return fallback;
  const key = pat.line + "/" + pat.dir;
  if (!shapeCache.has(key)) shapeCache.set(key, decodePolyline(enc));
  const line = shapeCache.get(key);
  const nearestIdx = (p, start) => {
    let best = start, bd = Infinity;
    for (let i = start; i < line.length; i++) {
      const d = (line[i][0] - p.lat) ** 2 + (line[i][1] - p.lng) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return [best, bd];
  };
  // Walk the stops in order so loop services slice the right part of the shape.
  let idx = 0, a = null;
  for (let s = 0; s <= l.toIdx; s++) {
    const [i, d] = nearestIdx(nodes[pat.nodes[s]], idx);
    if (d > 0.000004) continue; // stop further than ~200 m from the shape: ignore it
    idx = i;
    if (s === l.fromIdx) a = i;
  }
  if (a === null || idx <= a) return fallback;
  return line.slice(a, idx + 1);
}

function drawRoute(j) {
  routeLayer.clearLayers();
  if (!j) return;
  const nodes = state.net.nodes;
  const css = getComputedStyle(document.documentElement);
  const all = [];
  for (const l of j.legs) {
    let pts, style;
    if (l.type === "walk") {
      pts = [[l.from.lat, l.from.lng], [l.to.lat, l.to.lng]];
      style = { color: css.getPropertyValue("--walk").trim(), weight: 4, dashArray: "2 8", lineCap: "round" };
    } else if (l.type === "mrt") {
      const pat = state.net.patterns[l.pattern];
      pts = pat.nodes.slice(l.fromIdx, l.toIdx + 1).map((i) => [nodes[i].lat, nodes[i].lng]);
      style = { color: state.net.lineMeta[l.group].color, weight: 6, opacity: 0.9 };
    } else {
      pts = busShape(l);
      style = { color: css.getPropertyValue("--bus").trim(), weight: 6, opacity: 0.9 };
    }
    L.polyline(pts, { ...style, interactive: false }).addTo(routeLayer);
    if (l.type !== "walk") {
      for (const p of [l.from, l.to]) {
        L.circleMarker([p.lat, p.lng], { radius: 5, color: style.color, weight: 3, fillColor: "#fff", fillOpacity: 1 })
          .bindTooltip(esc(p.name)).addTo(routeLayer);
      }
    }
    all.push(...pts);
  }
  const panelW = window.innerWidth > 640 ? 420 : 0;
  map.fitBounds(L.latLngBounds(all), { paddingTopLeft: [panelW, 40], paddingBottomRight: [40, window.innerWidth > 640 ? 40 : window.innerHeight * 0.6] });
}

// ---------- wiring ----------

setupSuggest($("#from"), $("#from-suggest"), "from");
setupSuggest($("#to"), $("#to-suggest"), "to");
$("#trip").addEventListener("submit", (e) => { e.preventDefault(); planTrip(); });
$("#swap").addEventListener("click", () => {
  [state.from, state.to] = [state.to, state.from];
  [$("#from").value, $("#to").value] = [$("#to").value, $("#from").value];
  planTrip();
});
document.querySelector(".tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  state.mode = b.dataset.mode;
  state.selected = 0;
  renderResults();
});
$("#results").addEventListener("click", (e) => {
  const card = e.target.closest(".route");
  if (!card) return;
  state.selected = +card.dataset.i;
  renderResults();
});
$("#collapse").addEventListener("click", () => $("#panel").classList.toggle("collapsed"));

loadNetwork().then(() => planTrip()).catch((e) => { console.error(e); setStatus(e.message); });
