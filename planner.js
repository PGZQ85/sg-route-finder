// Multimodal (bus + MRT + walk) journey planner over busrouter.sg and MRT data.
// Works in the browser (window.Planner) and in Node (require) so it can be tested headless.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Planner = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Model parameters. Times are minutes, distances metres.
  const P = {
    walkSpeed: 75,          // m/min
    walkDetour: 1.3,        // street distance vs straight line
    busDetour: 1.25,
    railDetour: 1.1,
    busSpeed: 330,          // m/min (~20 km/h) off-peak, including traffic lights
    busSpeedPeak: 270,      // ~16 km/h
    busDwell: 0.35,         // per stop
    railSpeed: 700,         // ~42 km/h between stations
    railDwell: 0.5,
    busWait: 6,             // expected wait without live data (half a typical headway)
    busWaitPeak: 4.5,
    railWait: 2.5,
    railAccess: 2,          // gantry to platform
    railEgress: 1,
    boardPenaltyMin: 2,     // discourages needless transfers in "fastest"
    boardPenaltyM: 500,     // same, for "shortest"
    accessRadius: 900,      // max walk from origin / to destination
    transferRadius: 350,    // max walk between stops when changing
    stationRadius: 400,     // max walk between an MRT station and a bus stop
    directWalkMax: 2500,
  };

  const LINE_GROUP = { CCLe: "CCL", CGL: "EWL" };
  const NIGHT = /^(NR\d+|\d+N)$/i;
  // City Direct (6xx) and express (…e) services only run on weekday peaks.
  const PEAK_ONLY = /^(6[5-9]\d|\d+e)$/i;

  function hav(aLat, aLng, bLat, bLng) {
    const r = Math.PI / 180;
    const dLat = (bLat - aLat) * r, dLng = (bLng - aLng) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
  }

  // ---------- network ----------

  function buildNetwork(stops, services, mrt) {
    const nodes = [];
    const index = new Map();
    const add = (n) => { index.set(n.id, nodes.length); nodes.push(n); };

    for (const [code, s] of Object.entries(stops)) {
      add({ id: "B" + code, kind: "bus", code, lng: s[0], lat: s[1], name: s[2], road: s[3] });
    }
    for (const [name, s] of Object.entries(mrt.stations)) {
      add({ id: "M" + name, kind: "mrt", name: name + " Stn", station: name, lat: s.lat, lng: s.lng });
    }

    const patterns = [];
    for (const [no, svc] of Object.entries(services)) {
      if (NIGHT.test(no)) continue;
      svc.routes.forEach((route, dir) => {
        const ns = route.map((c) => index.get("B" + c)).filter((x) => x !== undefined);
        if (ns.length > 1) patterns.push({ kind: "bus", line: no, group: "bus:" + no, label: no, title: svc.name, dir, nodes: ns, peakOnly: PEAK_ONLY.test(no) });
      });
    }
    const lineMeta = {};
    for (const l of mrt.lines) {
      const group = LINE_GROUP[l.id] || l.id;
      lineMeta[group] = lineMeta[group] || { name: l.name.replace(/ \(.*\)$/, ""), color: l.color };
      const ns = l.stations.map((n) => index.get("M" + n));
      if (ns.some((x) => x === undefined)) throw new Error(`missing station on ${l.id}`);
      for (const [dir, seq] of [[0, ns], [1, [...ns].reverse()]]) {
        patterns.push({ kind: "mrt", line: l.id, group, label: group, title: `${l.name} towards ${nodes[seq[seq.length - 1]].station}`, color: l.color, dir, nodes: seq });
      }
    }

    // State layout for the search: [node states][origin][dest][onboard states per pattern position].
    let base = nodes.length + 2;
    const atNode = nodes.map(() => []);
    for (let p = 0; p < patterns.length; p++) {
      const pat = patterns[p];
      pat.base = base;
      base += pat.nodes.length;
      pat.seg = [];
      for (let i = 0; i < pat.nodes.length; i++) {
        atNode[pat.nodes[i]].push(p, i);
        if (i > 0) {
          const a = nodes[pat.nodes[i - 1]], b = nodes[pat.nodes[i]];
          pat.seg.push(hav(a.lat, a.lng, b.lat, b.lng) * (pat.kind === "bus" ? P.busDetour : P.railDetour));
        }
      }
    }

    // Walking links between nearby nodes, via a coarse spatial grid.
    const grid = new Map();
    const cell = 0.004; // ~440 m
    const key = (lat, lng) => `${Math.floor(lat / cell)},${Math.floor(lng / cell)}`;
    nodes.forEach((n, i) => {
      const k = key(n.lat, n.lng);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(i);
    });
    function near(lat, lng, radius) {
      const out = [];
      const span = Math.ceil(radius / 440);
      const cy = Math.floor(lat / cell), cx = Math.floor(lng / cell);
      for (let y = cy - span; y <= cy + span; y++) for (let x = cx - span; x <= cx + span; x++) {
        for (const i of grid.get(`${y},${x}`) || []) {
          const d = hav(lat, lng, nodes[i].lat, nodes[i].lng);
          if (d <= radius) out.push([i, d]);
        }
      }
      return out;
    }
    const walks = nodes.map((n, i) => {
      const r = n.kind === "mrt" ? P.stationRadius : P.transferRadius;
      return near(n.lat, n.lng, P.stationRadius).filter(([j, d]) => j !== i && (d <= r || nodes[j].kind === "mrt"));
    });

    return { nodes, patterns, atNode, walks, near, stateCount: base, lineMeta, index };
  }

  // ---------- search ----------

  class Heap {
    constructor() { this.k = []; this.v = []; }
    get size() { return this.k.length; }
    push(cost, s) {
      const k = this.k, v = this.v;
      let i = k.length; k.push(cost); v.push(s);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (k[p] <= cost) break;
        k[i] = k[p]; v[i] = v[p]; i = p;
      }
      k[i] = cost; v[i] = s;
    }
    pop() {
      const k = this.k, v = this.v;
      const top = v[0], lastK = k.pop(), lastV = v.pop();
      if (k.length) {
        let i = 0;
        for (;;) {
          let c = 2 * i + 1;
          if (c >= k.length) break;
          if (c + 1 < k.length && k[c + 1] < k[c]) c++;
          if (k[c] >= lastK) break;
          k[i] = k[c]; v[i] = v[c]; i = c;
        }
        k[i] = lastK; v[i] = lastV;
      }
      return top;
    }
  }

  function isPeak(date) {
    const day = date.getDay(), h = date.getHours() + date.getMinutes() / 60;
    return day > 0 && day < 6 && ((h >= 7 && h < 9.5) || (h >= 17 && h < 20));
  }

  // ctx: { from, to, mode: "fastest"|"shortest", live: Map(stopCode -> Map(service -> [minutes...])), walkPenalty, now }
  function search(net, ctx, banned) {
    const { nodes, patterns, atNode, walks } = net;
    const N = nodes.length, O = N, D = N + 1;
    const fastest = ctx.mode === "fastest";
    const peak = isPeak(ctx.now);
    const busSpeed = peak ? P.busSpeedPeak : P.busSpeed;
    const busWait = peak ? P.busWaitPeak : P.busWait;
    const walkMul = ctx.walkPenalty || 1;

    const cost = new Float64Array(net.stateCount).fill(Infinity);
    const prev = new Int32Array(net.stateCount).fill(-1);
    const elapsed = new Float64Array(net.stateCount); // real minutes, for matching live arrivals
    const heap = new Heap();

    const relax = (s, c, from, t) => {
      if (c < cost[s]) { cost[s] = c; prev[s] = from; elapsed[s] = t; heap.push(c, s); }
    };
    const walkEdge = (d) => {
      const t = (d * P.walkDetour) / P.walkSpeed;
      return [fastest ? t * walkMul : d * P.walkDetour, t];
    };

    cost[O] = 0;
    heap.push(0, O);
    while (heap.size) {
      const s = heap.pop();
      const c = cost[s];
      if (s === D) break;
      const t = elapsed[s];

      if (s === O) {
        for (const [j, d] of ctx.access) { const [w, wt] = walkEdge(d); relax(j, c + w, s, t + wt); }
        if (ctx.direct <= P.directWalkMax) { const [w, wt] = walkEdge(ctx.direct); relax(D, c + w, s, t + wt); }
        continue;
      }

      if (s < N) {
        const n = nodes[s];
        if (ctx.egress.has(s)) { const [w, wt] = walkEdge(ctx.egress.get(s)); relax(D, c + w, s, t + wt); }
        // Only walk onward if we didn't arrive here on foot (no chained walks).
        if (prev[s] >= N + 2) for (const [j, d] of walks[s]) { const [w, wt] = walkEdge(d); relax(j, c + w, s, t + wt); }

        const live = n.kind === "bus" && ctx.live && ctx.live.get(n.code);
        const pats = atNode[s];
        for (let k = 0; k < pats.length; k += 2) {
          const pat = patterns[pats[k]], i = pats[k + 1];
          if (i === pat.nodes.length - 1 || banned.has(pat.group) || (pat.peakOnly && !peak && !live)) continue;
          let wait;
          if (pat.kind === "mrt") wait = P.railAccess + P.railWait;
          else if (live) {
            const times = live.get(pat.line);
            if (!times) continue; // live feed says this service isn't running here now
            const next = times.find((m) => m >= t);
            wait = next === undefined ? busWait : next - t;
          } else wait = busWait;
          const bc = fastest ? wait + P.boardPenaltyMin : P.boardPenaltyM;
          relax(pat.base + i, c + bc, s, t + wait);
        }
        continue;
      }

      // Onboard state: find its pattern by binary search on base offsets.
      let lo = 0, hi = patterns.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (patterns[mid].base <= s) lo = mid; else hi = mid - 1; }
      const pat = patterns[lo], i = s - pat.base;
      const node = pat.nodes[i];
      if (prev[s] < N + 2) {
        // just boarded: must ride at least one stop
      } else {
        const out = pat.kind === "mrt" ? P.railEgress : 0;
        relax(node, c + (fastest ? out : 0), s, t + out);
      }
      if (i + 1 < pat.nodes.length) {
        const d = pat.seg[i];
        const rt = pat.kind === "bus" ? d / busSpeed + P.busDwell : d / P.railSpeed + P.railDwell;
        relax(s + 1, c + (fastest ? rt : d), s, t + rt);
      }
    }

    if (!isFinite(cost[D])) return null;
    const path = [];
    for (let s = D; s !== -1; s = prev[s]) path.push(s);
    path.reverse();
    return toJourney(net, ctx, path, elapsed, peak);
  }

  function patternOf(net, s) {
    const ps = net.patterns;
    let lo = 0, hi = ps.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ps[mid].base <= s) lo = mid; else hi = mid - 1; }
    return lo;
  }

  function toJourney(net, ctx, path, elapsed, peak) {
    const { nodes, patterns } = net;
    const N = nodes.length, O = N, D = N + 1;
    const pt = (s) => (s === O ? { ...ctx.from } : s === D ? { ...ctx.to } : { lat: nodes[s].lat, lng: nodes[s].lng, name: nodes[s].name, node: s });
    const legs = [];
    let k = 0;
    while (k < path.length - 1) {
      const s = path[k], nx = path[k + 1];
      if (nx >= N + 2) {
        // boarding at s, ride until alighting
        const p = patternOf(net, nx), pat = patterns[p];
        let j = k + 1;
        while (j + 1 < path.length && path[j + 1] === path[j] + 1 && path[j + 1] < pat.base + pat.nodes.length) j++;
        const i0 = nx - pat.base, i1 = path[j] - pat.base;
        let dist = 0;
        for (let i = i0; i < i1; i++) dist += pat.seg[i];
        legs.push({
          type: pat.kind, pattern: p, line: pat.line, group: pat.group, label: pat.label, title: pat.title, color: pat.color,
          from: pt(pat.nodes[i0]), to: pt(pat.nodes[i1]), stops: i1 - i0, fromIdx: i0, toIdx: i1,
          wait: elapsed[nx] - elapsed[s], waitLive: !!(pat.kind === "bus" && ctx.live && ctx.live.get(nodes[s].code)),
          ride: elapsed[path[j]] - elapsed[nx], distance: dist,
        });
        k = j + 1; // path[j+1] is the alighting node
        if (pat.kind === "mrt" && k < path.length) legs[legs.length - 1].ride += elapsed[path[k]] - elapsed[path[j]];
        continue;
      }
      const a = pt(s), b = pt(nx);
      const d = hav(a.lat, a.lng, b.lat, b.lng) * P.walkDetour;
      const last = legs[legs.length - 1];
      if (last && last.type === "walk") { last.to = b; last.distance += d; last.ride += d / P.walkSpeed; }
      else legs.push({ type: "walk", from: a, to: b, distance: d, ride: d / P.walkSpeed, wait: 0 });
      k++;
    }
    const rides = legs.filter((l) => l.type !== "walk");
    return {
      legs,
      minutes: legs.reduce((s, l) => s + l.wait + l.ride, 0),
      distance: legs.reduce((s, l) => s + l.distance, 0),
      walking: legs.filter((l) => l.type === "walk").reduce((s, l) => s + l.distance, 0),
      transfers: Math.max(0, rides.length - 1),
      signature: rides.map((l) => l.group).join(">") || "walk",
      groups: [...new Set(rides.map((l) => l.group))],
      peak,
    };
  }

  // ---------- k alternatives ----------

  // Diverse alternatives by banning lines: each accepted journey spawns searches that ban one more of its lines.
  function plan(net, { from, to, mode = "fastest", count = 5, live, walkPenalty = 1, now = new Date() }) {
    const access = net.near(from.lat, from.lng, P.accessRadius).map(([i, d]) => [i, d]);
    const egress = new Map(net.near(to.lat, to.lng, P.accessRadius));
    const ctx = { from, to, mode, live, walkPenalty, now, access, egress, direct: hav(from.lat, from.lng, to.lat, to.lng) };
    const score = (j) => (mode === "fastest" ? j.minutes : j.distance + j.transfers * P.boardPenaltyM);

    const tried = new Set();
    const pool = [];
    const seen = new Set();
    const accepted = [];
    const byCorridor = new Map();
    let searches = 0;
    const run = (bans) => {
      const id = [...bans].sort().join("|");
      if (tried.has(id) || searches >= 60) return;
      tried.add(id);
      searches++;
      const j = search(net, ctx, bans);
      if (j && !seen.has(j.signature)) { seen.add(j.signature); j.bans = bans; pool.push(j); }
    };
    // Same boarding/alighting stops for every ride = the same route with a parallel service
    // (e.g. buses 61, 166 and 80 between the same two stops): fold it in as an alternative.
    const corridor = (j) => j.legs.filter((l) => l.type !== "walk").map((l) => `${l.type}:${l.from.node}>${l.to.node}`).join("|");

    run(new Set());
    while (accepted.length < count && pool.length) {
      pool.sort((a, b) => score(a) - score(b));
      const best = pool.shift();
      const key = corridor(best);
      const twin = byCorridor.get(key);
      if (twin) {
        const rides = twin.legs.filter((l) => l.type !== "walk");
        best.legs.filter((l) => l.type !== "walk").forEach((l, k) => {
          const t = rides[k];
          t.alts = t.alts || [];
          if (l.label !== t.label && !t.alts.includes(l.label)) t.alts.push(l.label);
        });
      } else {
        byCorridor.set(key, best);
        accepted.push(best);
      }
      for (const g of best.groups) run(new Set([...best.bans, g]));
    }
    return accepted.sort((a, b) => score(a) - score(b));
  }

  // Bus stops where a journey boards but we hold no live arrivals yet — fetch these, then plan again.
  function unverifiedStops(net, journeys, live) {
    const out = new Set();
    for (const j of journeys) for (const l of j.legs) {
      if (l.type === "bus" && !live.has(net.nodes[l.from.node].code)) out.add(net.nodes[l.from.node].code);
    }
    return [...out];
  }

  return { buildNetwork, plan, unverifiedStops, hav, params: P, isPeak };
});
