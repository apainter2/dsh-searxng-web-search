import { SearxngSearchProvider, Config } from "./index.js";

// --- 1. Config schema: normalization + fallbacks -------------------------
const v = (input) => Config["~standard"].validate(input);

const cases = [
  ["undefined input (env/defaults)", v(undefined)],
  ["empty object (env/defaults)", v({})],
  ["config engines win over env", v({ engines: ["google cse", "bing"] })],
  ["string engines with spaces", v({ engines: "google cse, bing ,mojeek" })],
  ["bad url rejected", v({ url: "not a url" })],
  ["empty engines rejected", v({ engines: "" })],
];
for (const [label, res] of cases) {
  if (res.issues) {
    console.log(`  ok  ${label} -> rejected: ${res.issues[0].message}`);
  } else {
    console.log(`  ok  ${label} -> ${JSON.stringify(res.value)}`);
  }
}

// --- 2. Live search (real SearXNG on localhost) --------------------------
const envEngines = process.env.DSH_SEARXNG_ENGINES;
// Default to the engine set that is responsive on the local instance;
// override with DSH_SEARXNG_ENGINES to test other sets.
const testEngines = envEngines ?? "google cse,bing,mojeek,ecosia,startpage,yahoo";

const provider = new SearxngSearchProvider(v({ engines: testEngines }).value);
console.log(`\nSearXNG URL:    ${provider.url}`);
console.log(`Engines:        ${provider.engines.join(", ")}`);
console.log(`Max results:    ${provider.max}`);
console.log(`available():    ${provider.available()}`);

const query = "rust web framework";
console.log(`\nSearching: "${query}" (maxResults: 5)`);
console.log("─".repeat(40));

const t0 = Date.now();
try {
  const { sources, model } = await provider.search({ query, maxResults: 5 });
  console.log(`\n${sources.length} results in ${Date.now() - t0}ms (model: ${model})`);
  for (const [i, src] of sources.entries()) {
    console.log(`${i + 1}. ${src.title ?? "(untitled)"} — ${src.url}`);
  }
} catch (err) {
  console.log(`\nSearch failed: ${err.message}`);
}

// --- 3. Lossless-JSON contract --------------------------------------------
// The harness snapshots every tool result as plain lossless JSON (only
// null/boolean/string/finite number/array/plain object; no undefined
// values, no -0/NaN). A violation surfaces as:
//   tool "web_search" returned invalid output: value is not lossless JSON
// so the plugin must be structurally incapable of producing one. The checks
// below feed sparse and exotic fields through the same code path.
function isLosslessJsonValue(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false;
    return value.every(isLosslessJsonValue);
  }
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && proto !== Object.prototype) return false;
    return Object.values(value).every((child) => child !== undefined && isLosslessJsonValue(child));
  }
  return false;
}

const synthetic = {
  query: "contract",
  results: [
    { url: "https://a.example/1", title: "t1", content: "c1", publishedDate: "2026-01-02T03:04:05Z" },
    { url: "https://a.example/2" }, // sparse: no title/content/publishedDate
    { url: "https://a.example/3", title: "t3", content: "c3", publishedDate: 1767315845 }, // epoch seconds
    { url: "https://a.example/4", title: "t4", content: "c4", publishedDate: 1767315845000 }, // epoch ms
    { url: "https://a.example/5", title: "t5", content: "c5", publishedDate: "not a date" }, // unparseable -> dropped
    { url: "https://a.example/5", title: "dup", content: "dup content" }, // duplicate URL -> deduped
  ],
};

// Re-implement search()'s mapping locally? No — exercise the real provider
// by pointing it at a stub fetch. Node's global fetch is swappable.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => ({
  ok: true,
  json: async () => synthetic,
});
try {
  const stubProvider = new SearxngSearchProvider({ url: "http://stub.invalid" });
  const stub = await stubProvider.search({ query: synthetic.query, maxResults: 10 });
  console.log(`\nstubbed search: ${stub.sources.length} sources (expect 5 after dedupe)`);
  for (const [i, src] of stub.sources.entries()) {
    console.log(`${i + 1}. ${src.title ?? "(untitled)"} ${src.publishedAt ? `(${src.publishedAt})` : ""} — ${src.url}`);
  }
  const lossless = isLosslessJsonValue(stub);
  console.log(`lossless-JSON check: ${lossless ? "PASS" : "FAIL"}`);
  if (!lossless) process.exitCode = 1;
  if (stub.sources.length !== 5) {
    console.log("dedupe check: FAIL (expected 5 sources)");
    process.exitCode = 1;
  }
  const sparse = stub.sources[1];
  if (sparse.title !== undefined || sparse.snippet !== undefined || sparse.publishedAt !== undefined) {
    console.log("sparse-field check: FAIL (explicit undefined keys present)");
    console.log("  ", JSON.stringify(sparse));
    process.exitCode = 1;
  } else {
    console.log("sparse-field check: PASS (no undefined keys)");
  }
  const bad = stub.sources[4];
  if (bad?.publishedAt !== undefined) {
    console.log("bad-date check: FAIL (unparseable date was kept)");
    process.exitCode = 1;
  } else {
    console.log("bad-date check: PASS (unparseable date dropped)");
  }
} finally {
  globalThis.fetch = realFetch;
}
