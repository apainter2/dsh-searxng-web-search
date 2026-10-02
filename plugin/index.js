/**
 * deepseek-harness web seam plugin: SearXNG search provider (keyless).
 *
 * Registers a search provider for dsh's `web_search` tool backed by a local
 * SearXNG instance. Zero runtime dependencies (Node builtins + global fetch
 * only), so it can live outside dsh's package graph and be wired in with a
 * single plugin row — see ../install.sh and ../cordis.patch.yml.
 *
 * Configuration (patch row `config`, then environment, then defaults):
 *   url     — SearXNG base URL   (env DSH_SEARXNG_URL,     default http://127.0.0.1:8888)
 *   engines — comma string or list (env DSH_SEARXNG_ENGINES, default: a resilient multi-engine set)
 *   max     — per-request result cap (env DSH_SEARXNG_MAX, default 30)
 *
 * The default engine list spans several backends on purpose: some SearXNG
 * instances rate-limit or CAPTCHA the big three (duckduckgo/brave/google)
 * after heavy use, and a wider net keeps `web_search` productive on any
 * instance. Override per machine in the patch row's config block, e.g.
 * `engines: ["google cse", "bing", "mojeek"]` (see the SearXNG admin UI for
 * the instance's enabled engines; names with spaces are fine).
 */

const PROVIDER_ID = "searxng";
const USER_AGENT = "deepseek-harness/0.1.5-rc.3 (+local searxng)";

const DEFAULT_URL = "http://127.0.0.1:8888";
const DEFAULT_ENGINES = "duckduckgo,brave,google,google cse,bing,mojeek,ecosia,startpage,yahoo";
const DEFAULT_MAX = 30;

function envOr(name, fallback) {
  const v = typeof process !== "undefined" ? process.env?.[name] : undefined;
  return v !== undefined && v !== "" ? v : fallback;
}

function parseEngines(value) {
  const items = Array.isArray(value) ? value.map(String) : String(value).split(",");
  return items.map((s) => s.trim()).filter((s) => s.length > 0);
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Normalize SearXNG `publishedDate` to an ISO 8601 string. SearXNG versions
 * and individual engines disagree on the shape: current releases emit an ISO
 * string, older ones (and some engines) emit an epoch number (seconds or
 * milliseconds), and some omit it. Anything that does not parse is dropped
 * rather than thrown away — the harness rejects tool values that are not
 * plain lossless JSON, so an Invalid Date here would fail the whole search.
 */
function toIsoDate(value) {
  let ms;
  if (typeof value === "number" && Number.isFinite(value)) {
    ms = Math.abs(value) < 1e12 ? value * 1000 : value; // seconds vs milliseconds
  } else if (typeof value === "string" && value.trim() !== "") {
    ms = Date.parse(value);
  } else {
    return undefined;
  }
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
}

/**
 * Recursively assert that a value is plain lossless JSON: only null, boolean,
 * string, finite non-negative-zero numbers, arrays, and objects with the
 * plain Object.prototype (no undefined values, no exotic prototypes).
 * The harness snapshots tool results with exactly these rules, so checking
 * our own output here guarantees a `web_search` result can never fail the
 * harness's lossless-JSON validation no matter what the instance returns.
 */
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

/**
 * Standard-schema v1 validator for the plugin's config block.
 *
 * Cordis applies it to the row's `config` before `apply` runs (see
 * vendor/cordis/src/fiber.ts `resolveConfig`): sync only, returns
 * `{ value }` on success or `{ issues }` on failure. Field precedence is
 * config > environment > default, so a minimal or absent config block works.
 */
export const Config = {
  "~standard": {
    version: 1,
    validate(input) {
      if (input === undefined || input === null) input = {};
      if (typeof input !== "object" || Array.isArray(input)) {
        return { issues: [{ message: "config must be an object" }] };
      }

      const url = input.url !== undefined
        ? String(input.url).replace(/\/+$/u, "")
        : envOr("DSH_SEARXNG_URL", DEFAULT_URL).replace(/\/+$/u, "");
      if (!/^https?:\/\//u.test(url) || !(() => { try { new URL(url); return true; } catch { return false; } })()) {
        return { issues: [{ message: `url must be an http(s) URL, got ${url}` }] };
      }

      let engines;
      if (input.engines !== undefined) {
        engines = parseEngines(input.engines);
      } else {
        engines = parseEngines(envOr("DSH_SEARXNG_ENGINES", DEFAULT_ENGINES));
      }
      if (engines.length === 0) {
        return { issues: [{ message: "engines must name at least one SearXNG engine" }] };
      }

      const max = toPositiveInt(
        input.max !== undefined ? String(input.max) : envOr("DSH_SEARXNG_MAX", String(DEFAULT_MAX)),
        DEFAULT_MAX,
      );

      return { value: { url, engines, max } };
    },
  },
};

export class SearxngSearchProvider {
  #url;
  #engines;
  #max;

  /**
   * @param {object} [config] - normalized `{ url, engines, max }`. Fields left
   *   undefined fall back to environment, then to defaults, so the provider
   *   also works when constructed directly without the schema.
   */
  constructor(config = {}) {
    this.#url = (config.url ?? envOr("DSH_SEARXNG_URL", DEFAULT_URL)).replace(/\/+$/u, "");
    this.#engines = parseEngines(config.engines ?? envOr("DSH_SEARXNG_ENGINES", DEFAULT_ENGINES));
    this.#max = toPositiveInt(config.max ?? envOr("DSH_SEARXNG_MAX", String(DEFAULT_MAX)), DEFAULT_MAX);
  }

  get id() {
    return PROVIDER_ID;
  }

  get url() {
    return this.#url;
  }

  get engines() {
    return this.#engines;
  }

  get max() {
    return this.#max;
  }

  available() {
    try {
      new URL(this.#url);
      return true;
    } catch {
      return false;
    }
  }

  async search(request, signal) {
    const params = new URLSearchParams();
    params.set("q", request.query);
    params.set("format", "json");
    params.set("per_page", String(Math.min(request.maxResults ?? this.#max, this.#max)));
    if (this.#engines.length > 0) params.set("engines", this.#engines.join(","));

    const url = `${this.#url}/search?${params}`;
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, accept: "application/json" },
      signal,
    });
    if (!res.ok) {
      throw new Error(`SearXNG request failed: HTTP ${res.status} ${res.statusText}`);
    }

    const body = await res.json();
    const results = Array.isArray(body?.results) ? body.results : [];

    // De-duplicate by URL, preserving order (SearXNG may return repeats
    // across engines).
    const seen = new Set();
    const sources = [];
    for (const r of results) {
      if (sources.length >= request.maxResults) break;
      if (!r?.url) continue;
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      const source = { url: String(r.url) };
      if (typeof r.title === "string" && r.title !== "") source.title = r.title;
      if (typeof r.content === "string" && r.content !== "") source.snippet = r.content;
      const publishedAt = toIsoDate(r.publishedDate);
      if (publishedAt !== undefined) source.publishedAt = publishedAt;
      sources.push(source);
    }
    // Defense in depth: guarantee the value is plain lossless JSON before the
    // harness snapshots it (see isLosslessJsonValue). Every field is built
    // from checked strings above, so this normally passes on the first branch.
    const model = `searxng:${this.#engines.join(",")}`;
    const out = { sources, model };
    return isLosslessJsonValue(out)
      ? out
      : { sources: sources.filter(isLosslessJsonValue), model: "searxng" };
  }
}

const plugin = {
  name: "searxng-web-search",
  Config,
  inject: ["web"],

  /**
   * Cordis plugin entry point. `config` is the row's config block normalized
   * by the `Config` schema above; fields still missing (direct construction,
   * or an older caller) fall back to environment then defaults.
   */
  apply(ctx, config) {
    const web = ctx?.web;
    if (!web || typeof web.registerSearchProvider !== "function") return;
    web.registerSearchProvider(new SearxngSearchProvider(config));
  },
};

export default plugin;
