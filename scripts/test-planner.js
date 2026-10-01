// Headless check of the planner: Compass One -> HarbourFront, both modes, with live bus arrivals.
const P = require("../planner.js");
const load = (f) => require(`../data/${f}`);

(async () => {
  let t = Date.now();
  const net = P.buildNetwork(load("stops.min.json"), load("services.min.json"), load("mrt.json"));
  console.log(`network: ${net.nodes.length} nodes, ${net.patterns.length} patterns, ${net.stateCount} states (${Date.now() - t} ms)`);

  const from = { lat: 1.39205, lng: 103.89507, name: "Compass One" };
  const to = { lat: 1.26537, lng: 103.822, name: "HarbourFront" };

  const live = new Map();
  const offline = process.argv.includes("--offline");
  const fetchArrivals = (codes) => Promise.all(codes.map(async (code) => {
    try {
      const j = await (await fetch(`https://arrivelah2.busrouter.sg/?id=${code}`)).json();
      live.set(code, new Map(j.services.map((s) => [s.no, [s.next, s.subsequent, s.next2].filter((x) => x && x.time).map((x) => Math.max(0, (Date.parse(x.time) - Date.now()) / 60000))])));
    } catch {}
  }));
  if (!offline) {
    await fetchArrivals(net.near(from.lat, from.lng, P.params.accessRadius).filter(([i]) => net.nodes[i].kind === "bus").sort((a, b) => a[1] - b[1]).slice(0, 14).map(([i]) => net.nodes[i].code));
    console.log(`live arrivals for ${live.size} origin stops`);
  }

  let failed = false;
  for (const mode of ["fastest", "shortest"]) {
    t = Date.now();
    let res;
    for (let round = 0; round < 3; round++) {
      res = P.plan(net, { from, to, mode, live, count: 5 });
      const todo = offline ? [] : P.unverifiedStops(net, res, live);
      if (!todo.length) break;
      await fetchArrivals(todo);
    }
    console.log(`\n== ${mode} (${Date.now() - t} ms)`);
    for (const j of res) {
      const legs = j.legs.map((l) => (l.type === "walk" ? `walk ${Math.round(l.distance)}m` : `${[l.label, ...(l.alts || [])].join("/")}[${net.nodes[l.from.node].name} -> ${net.nodes[l.to.node].name}, ${l.stops} stops]`)).join(" | ");
      console.log(`${j.minutes.toFixed(0).padStart(3)} min ${(j.distance / 1000).toFixed(1).padStart(5)} km  ${j.transfers}x  ${legs}`);
    }
    if (res.length !== 5) { console.error(`expected 5 ${mode} routes, got ${res.length}`); failed = true; }
    if (new Set(res.map((j) => j.signature)).size !== res.length) { console.error("duplicate routes"); failed = true; }
  }
  process.exit(failed ? 1 : 0);
})();
