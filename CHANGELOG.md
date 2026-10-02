# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

The version number mirrors the `version` field in [`plugin/package.json`](plugin/package.json).

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
