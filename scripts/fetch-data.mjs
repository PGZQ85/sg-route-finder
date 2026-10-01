// Downloads the static datasets the planner needs into ./data so the app runs from local files.
//   - Bus stops, services and route shapes from busrouter.sg
//   - MRT station coordinates, geocoded through OneMap search (throttled: OneMap returns 429 on bursts)
// Usage: node scripts/fetch-data.mjs [--bus-only | --mrt-only]
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const DATA = new URL("../data/", import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Line definitions, in running order. Station names match OneMap's "<NAME> MRT STATION" entries.
export const LINES = [
  { id: "NEL", name: "North East Line", color: "#9900aa", stations: ["HarbourFront", "Outram Park", "Chinatown", "Clarke Quay", "Dhoby Ghaut", "Little India", "Farrer Park", "Boon Keng", "Potong Pasir", "Woodleigh", "Serangoon", "Kovan", "Hougang", "Buangkok", "Sengkang", "Punggol", "Punggol Coast"] },
  { id: "CCL", name: "Circle Line", color: "#fa9e0d", stations: ["Dhoby Ghaut", "Bras Basah", "Esplanade", "Promenade", "Nicoll Highway", "Stadium", "Mountbatten", "Dakota", "Paya Lebar", "MacPherson", "Tai Seng", "Bartley", "Serangoon", "Lorong Chuan", "Bishan", "Marymount", "Caldecott", "Botanic Gardens", "Farrer Road", "Holland Village", "Buona Vista", "one-north", "Kent Ridge", "Haw Par Villa", "Pasir Panjang", "Labrador Park", "Telok Blangah", "HarbourFront"] },
  { id: "CCLe", name: "Circle Line (Marina Bay branch)", color: "#fa9e0d", stations: ["Promenade", "Bayfront", "Marina Bay"] },
  { id: "NSL", name: "North South Line", color: "#d42e12", stations: ["Jurong East", "Bukit Batok", "Bukit Gombak", "Choa Chu Kang", "Yew Tee", "Kranji", "Marsiling", "Woodlands", "Admiralty", "Sembawang", "Canberra", "Yishun", "Khatib", "Yio Chu Kang", "Ang Mo Kio", "Bishan", "Braddell", "Toa Payoh", "Novena", "Newton", "Orchard", "Somerset", "Dhoby Ghaut", "City Hall", "Raffles Place", "Marina Bay", "Marina South Pier"] },
  { id: "EWL", name: "East West Line", color: "#009645", stations: ["Pasir Ris", "Tampines", "Simei", "Tanah Merah", "Bedok", "Kembangan", "Eunos", "Paya Lebar", "Aljunied", "Kallang", "Lavender", "Bugis", "City Hall", "Raffles Place", "Tanjong Pagar", "Outram Park", "Tiong Bahru", "Redhill", "Queenstown", "Commonwealth", "Buona Vista", "Dover", "Clementi", "Jurong East", "Chinese Garden", "Lakeside", "Boon Lay", "Pioneer", "Joo Koon", "Gul Circle", "Tuas Crescent", "Tuas West Road", "Tuas Link"] },
  { id: "CGL", name: "East West Line (Changi branch)", color: "#009645", stations: ["Tanah Merah", "Expo", "Changi Airport"] },
  { id: "DTL", name: "Downtown Line", color: "#005ec4", stations: ["Bukit Panjang", "Cashew", "Hillview", "Hume", "Beauty World", "King Albert Park", "Sixth Avenue", "Tan Kah Kee", "Botanic Gardens", "Stevens", "Newton", "Little India", "Rochor", "Bugis", "Promenade", "Bayfront", "Downtown", "Telok Ayer", "Chinatown", "Fort Canning", "Bencoolen", "Jalan Besar", "Bendemeer", "Geylang Bahru", "Mattar", "MacPherson", "Ubi", "Kaki Bukit", "Bedok North", "Bedok Reservoir", "Tampines West", "Tampines", "Tampines East", "Upper Changi", "Expo"] },
  { id: "TEL", name: "Thomson-East Coast Line", color: "#9d5b25", stations: ["Woodlands North", "Woodlands", "Woodlands South", "Springleaf", "Lentor", "Mayflower", "Bright Hill", "Upper Thomson", "Caldecott", "Stevens", "Napier", "Orchard Boulevard", "Orchard", "Great World", "Havelock", "Outram Park", "Maxwell", "Shenton Way", "Marina Bay", "Gardens by the Bay", "Tanjong Rhu", "Katong Park", "Tanjong Katong", "Marine Parade", "Marine Terrace", "Siglap", "Bayshore"] },
];

async function getJSON(url, tries = 6) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    if (res.status === 429) { await sleep(5000 * (i + 1)); continue; }
    throw new Error(`${res.status} ${url}`);
  }
  throw new Error(`gave up after ${tries} tries: ${url}`);
}

async function fetchBus() {
  for (const f of ["stops.min.json", "services.min.json", "routes.min.json"]) {
    const json = await getJSON(`https://data.busrouter.sg/v1/${f}`);
    await writeFile(new URL(f, DATA), JSON.stringify(json));
    console.log(`saved data/${f}`);
  }
}

async function fetchMrt() {
  const out = new URL("mrt.json", DATA);
  // Resume from a previous partial run so a 429 storm doesn't cost the whole geocode.
  const prev = existsSync(out) ? JSON.parse(await readFile(out, "utf8")).stations : {};
  const stops = JSON.parse(await readFile(new URL("stops.min.json", DATA), "utf8"));
  const names = [...new Set(LINES.flatMap((l) => l.stations))];
  const stations = {};

  for (const name of names) {
    if (prev[name]) { stations[name] = prev[name]; continue; }
    const q = `${name} MRT STATION`;
    const j = await getJSON(`https://www.onemap.gov.sg/api/common/elastic/search?searchVal=${encodeURIComponent(q)}&returnGeom=Y&getAddrDetails=N&pageNum=1`);
    const hit = j.results.find((r) => r.SEARCHVAL.startsWith(`${q.toUpperCase()} (`)) || j.results.find((r) => r.SEARCHVAL.startsWith(q.toUpperCase()));
    if (hit) {
      stations[name] = { lat: +hit.LATITUDE, lng: +hit.LONGITUDE, label: hit.SEARCHVAL, source: "onemap" };
    } else {
      // Fall back to the bus stops named after the station.
      const pts = Object.values(stops).filter((s) => s[2].toLowerCase().startsWith(`${name.toLowerCase()} stn`));
      if (!pts.length) throw new Error(`no coordinates for ${name}`);
      stations[name] = { lat: avg(pts.map((p) => p[1])), lng: avg(pts.map((p) => p[0])), label: name, source: "busstops" };
    }
    console.log(`${name.padEnd(20)} ${stations[name].lat.toFixed(5)}, ${stations[name].lng.toFixed(5)}  (${stations[name].source})`);
    await writeFile(out, JSON.stringify({ lines: LINES, stations }, null, 1));
    await sleep(1500);
  }
  await writeFile(out, JSON.stringify({ lines: LINES, stations }, null, 1));
  console.log(`saved data/mrt.json (${names.length} stations)`);
}

const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;

await mkdir(DATA, { recursive: true });
const arg = process.argv[2];
if (arg !== "--mrt-only") await fetchBus();
if (arg !== "--bus-only") await fetchMrt();
