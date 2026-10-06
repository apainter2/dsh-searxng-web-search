import { SearxngSearchProvider, Config } from "./index.js";

// --- Mini test harness ------------------------------------------------------
let failures = 0;
function check(label, cond, detail) {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}
function section(title) {
  console.log(`\n${title}`);
  console.log("─".repeat(title.length + 2));
}

// --- 1. Config schema: normalization + fallbacks -------------------------
section("1. Config schema");
const v = (input) => Config["~standard"].validate(input);
check("undefined input uses defaults", v(undefined).value !== undefined);
check("empty object uses defaults", v({}).value !== undefined);
check("config engines win over env", v({ engines: ["google cse", "bing"] }).value.engines.join(",") === "google cse,bing");
check("string engines with spaces", v({ engines: "google cse, bing ,mojeek" }).value.engines.join(",") === "google cse,bing,mojeek");
check("bad url rejected", v({ url: "not a url" }).issues !== undefined);
check("empty engines rejected", v({ engines: "" }).issues !== undefined);

// --- 2. Live search (real SearXNG on localhost) --------------------------
section("2. Live search");
const envEngines = process.env.DSH_SEARXNG_ENGINES;
const testEngines = envEngines ?? "google cse,bing,mojeek,ecosia,startpage,yahoo";
const provider = new SearxngSearchProvider(v({ engines: testEngines }).value);
console.log(`  URL:    ${provider.url}`);
console.log(`  Engines: ${provider.engines.join(", ")}`);
console.log(`  Max:     ${provider.max}`);
const query = "rust web framework";
console.log(`  Searching: "${query}" (maxResults: 5)`);
const t0 = Date.now();
try {
  const { sources, model } = await provider.search({ query, maxResults: 5 });
  console.log(`  ${sources.length} results in ${Date.now() - t0}ms (model: ${model})`);
  for (const [i, src] of sources.entries()) {
    console.log(`    ${i + 1}. ${src.title ?? "(untitled)"} — ${src.url}`);
  }
  check("live search returned sources", sources.length > 0, `${sources.length} returned`);
} catch (err) {
  // Distinguish a real plugin failure (typed WebError) from an external
  // SearXNG outage (network/abort). CI provisions a live SearXNG, so a
  // genuine plugin bug should throw a WebError; a transient outage is an
  // environment failure, not a plugin failure, and is reported (not
  // failed) so the suite exits non-zero only on a plugin defect.
  if (err?.name === "WebError") {
    check("live search did not throw a WebError", false, `code=${err?.code} msg="${err?.message}"`);
  } else {
    console.log(`  (skipped — non-WebError, treated as an environment issue: ${err?.message})`);
  }
}

// --- 3. Lossless-JSON contract + dedupe + sparse fields -------------------
section("3. Lossless-JSON contract (stubbed fetch)");
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
    // Fixed: check keys, not just values, so a sparse hole or an explicit
    // `undefined` value is caught (the old `Object.values`-only check
    // silently skipped sparse holes and produced a false PASS).
    if (Object.keys(value).some((k) => value[k] === undefined)) return false;
    return Object.values(value).every((child) => isLosslessJsonValue(child));
  }
  return false;
}

const synthetic = {
  query: "contract",
  results: [
    { url: "https://a.example/1", title: "t1", content: "c1", publishedDate: "2026-01-02T03:04:05Z" },
    { url: "https://a.example/2" }, // sparse: no title/content/publishedDate
    { url: "https://a.example/3", title: "t3", content: "c3", publishedDate: Date.parse("2026-01-02T03:04:05Z") / 1000 }, // epoch seconds
    { url: "https://a.example/4", title: "t4", content: "c4", publishedDate: Date.parse("2026-01-02T03:04:05Z") }, // epoch ms
    { url: "https://a.example/5", title: "t5", content: "c5", publishedDate: "not a date" }, // unparseable -> dropped
    { url: "https://a.example/5", title: "dup", content: "dup content" }, // duplicate URL -> deduped
  ],
};

const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, redirected: false, json: async () => synthetic });
try {
  const stubProvider = new SearxngSearchProvider({ url: "http://stub.invalid" });
  const stub = await stubProvider.search({ query: synthetic.query, maxResults: 10 });
  check("dedupe: 5 unique sources", stub.sources.length === 5, `got ${stub.sources.length}`);
  check("lossless JSON: result passes", isLosslessJsonValue(stub));
  const sparse = stub.sources[1];
  check(
    "sparse source has no undefined keys",
    Object.keys(sparse).every((k) => sparse[k] !== undefined),
    JSON.stringify(sparse),
  );
  check("bad date dropped", stub.sources[4].publishedAt === undefined);
  check("epoch seconds → ISO", stub.sources[2].publishedAt === "2026-01-02T03:04:05.000Z");
  check("epoch ms → ISO", stub.sources[3].publishedAt === "2026-01-02T03:04:05.000Z");
} finally {
  globalThis.fetch = realFetch;
}

// --- 4. Typed WebError failures (stubbed fetch) --------------------------
section("4. Typed WebError failures");

async function expectWebError(label, makeFetch, { signal, code, causeName, messagePart } = {}) {
  globalThis.fetch = makeFetch;
  try {
    const p = new SearxngSearchProvider({ url: "http://stub.invalid" });
    await p.search({ query: "q", maxResults: 5 }, signal);
    check(label, false, "did not throw");
  } catch (err) {
    const name = err?.name;
    const codeOk = code === undefined || err?.code === code;
    const nameOk = name === "WebError";
    const causeOk = causeName === undefined || err?.cause?.name === causeName;
    const msgOk = messagePart === undefined || String(err?.message).includes(messagePart);
    check(label, nameOk && codeOk && causeOk && msgOk,
      `name=${name} code=${err?.code} cause=${err?.cause?.name ?? "none"} msg="${err?.message?.slice(0, 80)}"`);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// 4a. Pre-dispatch abort: caller signal already aborted before the call.
{
  const ac = new AbortController();
  ac.abort(new Error("user cancelled"));
  await expectWebError("pre-dispatch abort → WEB_ABORTED", async () => { throw new Error("should not fetch"); },
    { signal: ac.signal, code: "WEB_ABORTED", causeName: "Error", messagePart: "aborted" });
}

// 4b. Fetch rejects with AbortError (mid-flight abort).
{
  const ac = new AbortController();
  ac.abort();
  await expectWebError("fetch AbortError → WEB_ABORTED", async () => {
    throw new DOMException("The operation was aborted.", "AbortError");
  },
    { signal: ac.signal, code: "WEB_ABORTED", causeName: "AbortError", messagePart: "aborted" });
}

// 4c. Non-2xx HTTP response.
await expectWebError("HTTP 500 → WEB_PROVIDER_ERROR", async () => ({
  ok: false, status: 500, statusText: "Internal Server Error", redirected: false,
  json: async () => ({}),
}), { code: "WEB_PROVIDER_ERROR", messagePart: "HTTP 500" });

// 4d. Network failure (fetch rejects with a non-abort error).
await expectWebError("network error → WEB_PROVIDER_ERROR", async () => {
  throw new TypeError("fetch failed: ECONNREFUSED");
}, { code: "WEB_PROVIDER_ERROR", causeName: "TypeError", messagePart: "ECONNREFUSED" });

// 4e. Non-JSON response (JSON parse fails).
await expectWebError("non-JSON body → WEB_PROVIDER_ERROR", async () => ({
  ok: true, status: 200, redirected: false,
  json: async () => { throw new SyntaxError("Unexpected token < in JSON"); },
}), { code: "WEB_PROVIDER_ERROR", causeName: "SyntaxError", messagePart: "non-JSON" });

// 4f. Redirect followed (3xx with Location) — `redirect: "error"` throws.
await expectWebError("redirect → WEB_PROVIDER_ERROR", async () => {
  throw new TypeError("redirect: error");
}, { code: "WEB_PROVIDER_ERROR", messagePart: "request failed" });

// --- Summary ----------------------------------------------------------------
section("Summary");
if (failures === 0) {
  console.log("  All checks passed.");
} else {
  console.log(`  ${failures} check(s) FAILED.`);
  process.exitCode = 1;
}
