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
 * A harness-compatible web error, mirroring `dsh-web`'s `WebError`
 * (`class WebError extends HarnessError`, which sets `code` from the second
 * constructor argument and `name` to the class name). We re-implement it
 * here instead of importing `@deepseek-ai/dsh-web`: a Cordis plugin is
 * evaluated at its mount location (e.g. `~/searxng-web-search`) where the
 * dsh workspace is not on the module-resolution path, so a bare import of
 * `@deepseek-ai/dsh-web` would throw at plugin load and break `web_search`
 * outright. The shape below is a faithful stand-in for the dsh-web version
 * — same base class, same `code`/`cause` fields, same `name` — so the seam
 * can route it by code and the tool layer can render its `message`.
 *
 * Why throw instead of returning `{ sources: [], error }`: the harness
 * snapshots tool *values* with lossless-JSON, and an `error` string would
 * round-trip fine but would be swallowed by the model as "no results" —
 * the failure would silently read as an empty search. A thrown `WebError`
 * becomes a structured `isError` tool result whose message the agent sees,
 * and its `code` (WEB_ABORTED, WEB_PROVIDER_ERROR, …) is machine-routable
 * without the agent parsing prose.
 */
class WebError extends Error {
  /** Stable machine-routable failure class. */
  code;
  constructor(message, code, options) {
    super(message, options);
    this.code = code;
    this.name = new.target.name;
  }
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error) {
  return error instanceof DOMException && error.name === "AbortError";
}

/** Build the provider's stable cancellation error while retaining the reason. */
function searchAborted(signal, fallback) {
  return new WebError("SearXNG search aborted", "WEB_ABORTED", {
    cause: signal?.aborted === true ? signal.reason : fallback,
  });
}

/** Throw the provider's stable cancellation error when the caller aborted. */
function throwIfSearchAborted(signal) {
  if (signal?.aborted === true) throw searchAborted(signal);
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
    // Own *keys* (not values) are lossless-JSON-unsafe: a sparse hole or an
    // explicit `undefined` serializes to `{ "k": null }` / drops the key,
    // which the harness's snapshot then rejects. `Object.keys` includes
    // holes and `undefined` values; `Object.values` silently skips holes —
    // this is the exact trap the old check fell into.
    if (Object.keys(value).some((k) => value[k] === undefined)) return false;
    return Object.values(value).every((child) => isLosslessJsonValue(child));
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
    // Cooperative cancellation: the seam forwards the tool's caller signal,
    // and we mirror the DeepSeek provider convention by re-throwing it as a
    // stable WEB_ABORTED WebError (with the caller's reason as `cause`)
    // rather than letting a raw AbortError leak into the tool result.
    throwIfSearchAborted(signal);

    const params = new URLSearchParams();
    params.set("q", request.query);
    params.set("format", "json");
    params.set("per_page", String(Math.min(request.maxResults ?? this.#max, this.#max)));
    if (this.#engines.length > 0) params.set("engines", this.#engines.join(","));

    const url = `${this.#url}/search?${params}`;
    let res;
    try {
      // `redirect: "error"` turns a redirect (a 3xx with a Location header)
      // into a rejection we can classify below, instead of silently
      // following it — SearXNG should answer JSON directly, and a redirect
      // means the instance is misconfigured or the URL was hijacked.
      res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, accept: "application/json" },
        signal,
        redirect: "error",
      });
    } catch (error) {
      // Distinguish caller-side aborts from provider/network failures: the
      // seam already cancelled the caller, so we re-throw as WEB_ABORTED
      // with the caller's reason preserved as `cause`.
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
      // Network / DNS / redirect-error failures: a typed provider error so
      // the tool layer renders a human-readable message and routes on code.
      throw new WebError(
        `SearXNG search request failed: ${String(error)}`,
        "WEB_PROVIDER_ERROR",
        { cause: error },
      );
    }
    if (res.redirected) {
      throw new WebError(
        `SearXNG search followed a redirect to ${res.url}; configure a direct endpoint`,
        "WEB_PROVIDER_ERROR",
      );
    }
    if (!res.ok) {
      throw new WebError(
        `SearXNG search failed: HTTP ${res.status} ${res.statusText}`,
        "WEB_PROVIDER_ERROR",
      );
    }

    let body;
    try {
      body = await res.json();
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
      throw new WebError(
        `SearXNG returned a non-JSON response (${String(error)})`,
        "WEB_PROVIDER_ERROR",
        { cause: error },
      );
    }
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
