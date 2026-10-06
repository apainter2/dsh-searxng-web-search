# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

The version number mirrors the `version` field in [`plugin/package.json`](plugin/package.json).

## [1.1.0] - 2026-10-06

### Changed

- **Search failures now surface as typed `WebError`s** (mirroring the dsh
  provider convention used by the built-in DeepSeek/HTTP web providers)
  instead of a bare `Error` whose message the harness's lossless-JSON
  snapshot silently emptied. Previously a failed search read to the model
  as "no results"; now the agent sees a human-readable `message` and a
  machine-routable `code`:
  - `WEB_PROVIDER_ERROR` — non-2xx response, network failure, a followed
    redirect (now `fetch({ redirect: "error" })`), or a non-JSON body.
  - `WEB_ABORTED` — the caller's `AbortSignal` fired (pre-dispatch or mid
    flight), rethrown with the caller's reason preserved as `cause` so a
    cancelled search reads as a cancellation, not a provider error.
- The failure type is a **local** `WebError` (same `code`/`cause`/`name`
  shape as `dsh-web`'s `WebError`) rather than an import of
  `@deepseek-ai/dsh-web`: the plugin is evaluated at its mount path
  (`~/searxng-web-search`) where the dsh workspace is not on the module
  resolution path, so a bare import would crash at plugin load and break
  `web_search` outright. The dsh seam routes on `code`/`message` fields,
  not `instanceof`, so the stand-in is fully interchangeable.

### Fixed

- **Lossless-JSON self-guard rejected the wrong things.** The recursive
  guard checked only `Object.values`, which silently *skips* sparse holes —
  so an object with an `undefined`/hole value passed the check and only blew
  up at the harness's snapshot. It now checks own **keys** (a hole or an
  explicit `undefined` value fails), so a malformed SearXNG response is
  dropped at the source instead of tripping the harness's snapshot with
  "value is not lossless JSON".

### Added

- **Typed-error tests.** `plugin/test.mjs` grew a real PASS/FAIL harness and
  new cases covering the pre-dispatch abort, the mid-flight abort, the
  non-2xx, the network failure, the non-JSON body, and the followed-redirect
  failure — asserting the thrown `WebError`'s `code`, `message`, and
  `cause` in each. The live-search step now fails only on a plugin-defect
  `WebError`, skipping (with a note) a transient environment outage so the
  suite's exit code reflects a plugin bug rather than an external SearXNG
  blip.

## [1.0.1] - 2026-10-02

### Changed

- **Docs**: README now documents the two install paths up front — a bare
  `./install.sh` for machines that already run a JSON-enabled SearXNG, and
  `./install.sh --install` for machines that don't (the installer then builds,
  deploys, and configures SearXNG itself).

## [1.0.0] - 2026-10-02

### Added

- Initial release of the SearXNG-backed `web_search` plugin for DeepSeek
  Harness (dsh), packaged as a self-contained, zero-dependency runbook:

  - `plugin/` — the ES module: routes dsh's `web_search` through a local
    keyless SearXNG instance with a resilient multi-engine fan-out, a
    synchronous lossless-JSON response guard, and per-instance override knobs
    (`url`, `engines`, `max` — via patch config block, env vars, or defaults).
  - `install.sh` — copies the plugin, writes/merges the `$DSH_HOME/cordis.patch.yml`
    wiring, and (with `--install`) runs the SearXNG installer; `--unwire`
    restores the previous patch.
  - `searxng/` — a self-contained SearXNG installer (bootstraps `uv`, clones a
    pinned commit, writes JSON-enabled settings with a generated secret,
    installs a macOS LaunchAgent / Linux systemd service, and self-tests) plus
    the settings template.
  - `cordis.patch.yml` — the patch-row template used by `install.sh`.
