# Upgrading to v1.1.0 (if you already have it deployed)

For the **already-deployed** case only — you installed via `./install.sh` (the
default, no-flag run), so the plugin lives at `~/searxng-web-search/`, the
wiring row lives in `$DSH_HOME/cordis.patch.yml`, and SearXNG runs as its own
service at `~/searxng/` on `127.0.0.1:8888`. A fresh install is still just
`./install.sh --install`; this guide is for moving a live deployment forward.

## What changed in 1.1.0

Only **how failures surface** and **one self-guard**. The search behavior,
config surface, and install layout are unchanged:

| Area | 1.0.1 | 1.1.0 |
|---|---|---|
| A failed search (backend down / non-2xx / redirect / non-JSON) | bare `Error`; the harness's lossless-JSON snapshot **emptied the `message`**, so the model saw a blank error and read it as "no results" | throws a **typed `WebError`** with a populated `message` and a machine-routable `code` (`WEB_PROVIDER_ERROR`, or `WEB_ABORTED` if your caller aborted) |
| A cancelled / aborted search | surfaced as a generic provider error | `WEB_ABORTED`, with the caller's abort reason preserved as `cause` |
| Lossless-JSON self-guard | checked `Object.values` only — silently *skipped* sparse holes, so a malformed response slipped through and only tripped the harness's `"value is not lossless JSON"` snapshot | checks own **keys** — a sparse/`undefined` value is dropped at the source |
| Config (`url` / `engines` / `max`) + env vars | `DSH_SEARXNG_URL` / `DSH_SEARXNG_ENGINES` / `DSH_SEARXNG_MAX` | **identical** — no config changes needed to upgrade |
| SearXNG backend (`~/searxng/`) | pinned commit `f5035873` | **untouched** — the plugin bump does not move or restart the backend |

> **Note:** `package.json` says `1.1.0`, but the WebError/abort behavior is the
> same fix that landed in v1.0.1 — the version was never re-cut. If you are
> already running the current `~/searxng-web-search/index.js`, you likely
> **already have** the typed-error behavior; this upgrade re-runs the
> installer for you so the on-disk copy is authoritatively at the latest
> version and you can confirm it below.

## The three things that matter

1. **Re-copy the plugin module.** `install.sh` overwrites the three files in
   `~/searxng-web-search/` (`index.js`, `package.json`, `test.mjs`) from your
   repo checkout — that's the only file change an upgrade involves.
2. **Restart dsh.** The plugin is an ES module; dsh's ESM loader caches it by
   `file://` URL, so a running process keeps the *old* copy it imported at
   boot **no matter how many times you re-run `install.sh`**. The restart is
   what loads the new module. (Renaming the module or bumping `name:` does
   *not* reliably force a re-import in a long-running process, especially a
   `dsh web` GUI session — just restart.)
3. **You do NOT need to touch SearXNG.** A bare `./install.sh` leaves the
   backend alone — no `--install` flag, so `searxng-install.sh` is never
   invoked. SearXNG keeps running on `127.0.0.1:8888` under the same
   `settings.yml` (JSON format, strict safe-search).

## Do the upgrade

From the repo checkout you already have on this machine:

```bash
cd searxng-web-search
./install.sh          # no flags — do NOT use --install here
```

`install.sh` re-copies the plugin, then **merges** (not rewrites) your
`$DSH_HOME/cordis.patch.yml` — it backs it up to `cordis.patch.yml.bak.<ts>`
first, and only touches the SearXNG rows, so your own rows are preserved. It
prints the next steps; the one that matters is **restart dsh**.

> ⚠️ **`dsh web` GUI session:** in a long-running process the config watcher
> can die, after which *no* patch change — config or module — takes effect
> until a restart. Restarting dsh is the reliable path either way.

**Want the backend updated too?** Optional, separate from the plugin:

```bash
bash searxng/searxng-install.sh --update            # reset to the pinned ref
bash searxng/searxng-install.sh --update SEARXNG_REF=<new-sha>   # move the pin
```

This re-clones/`git checkout --detach`s `~/searxng/` and re-applies
`settings.yml`; SearXNG then restarts. You only need this if you are also
bumping the pinned SearXNG commit.

## Verify

**1. The on-disk plugin is the new version:**

```bash
grep '"version"' ~/searxng-web-search/package.json
# →   "version": "1.1.0",
```

**2. The plugin + SearXNG are healthy (18-check smoke test):**

```bash
DSH_SEARXNG_URL=http://127.0.0.1:8888 node ~/searxng-web-search/test.mjs
# →  "All checks passed." (exit 0)
```

This exercises the live search, the typed-error paths (abort / non-2xx /
network / non-JSON / redirect), and the lossless-JSON self-guard — so it
confirms the upgraded module actually behaves like 1.1.0, not just that the
file was copied.

**3. (Optional) confirm the typed error by failing a search on purpose:**

```bash
# SearXNG is down → you should now see a WebError, not a blank message:
# stop the service temporarily, then in a dsh session: web_search "anything"
# expected: WEB_PROVIDER_ERROR with a populated message, e.g.
#   "SearXNG search request failed: TypeError: fetch failed …"
```

In a dsh session a healthy `web_search` returns SearXNG-backed results as
before — the upgrade is invisible on the happy path, which is the point.

## Roll back

```bash
git -C searxng-web-search checkout <old-tag-or-commit>   # e.g. v1.0.1
./install.sh
# restart dsh
```

Because the upgrade is just a file re-copy + a restart, rollback is the same
motion in the other direction — copy the previous `index.js`, restart. (If you
need the previous module without touching your repo, a bare `./install.sh`
from a checkout at the older version is all it takes; nothing else in your
deployment changes.)

## Troubleshooting the upgrade

| Symptom | Cause & fix |
|---|---|
| Still seeing a blank/`null` error message after the upgrade | The running process is on the **old cached module** — restart dsh so it re-imports `~/searxng-web-search/index.js`. Confirm with `grep '"version"' ~/searxng-web-search/package.json` that the *file* is 1.1.0 first. |
| `web_search` still fails after the restart | Not a plugin-version issue — SearXNG itself is down or returning a bad body. Run the smoke test above; it will name the failure (`WEB_PROVIDER_ERROR` + the SearXNG error). Check `curl -s http://127.0.0.1:8888/healthz` → `200`. |
| `install.sh` says it backed up the patch but your rows look different | It only re-merges the three SearXNG rows; if you see a change, compare against the `cordis.patch.yml.bak.<ts>` it created — that backup is your pre-upgrade state. |
| Want to go back to DeepSeek search temporarily | `./install.sh --unwire` (restores the last patch backup), or flip the `web` row's `searchProvider` back to `deepseek` in `cordis.patch.yml`, then restart dsh. |
