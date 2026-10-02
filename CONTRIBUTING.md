# Contributing

Thanks for helping — this is a deliberately small project, and that's a
feature: the whole thing is one zero-dependency plugin plus two install
scripts. Keep it that way.

## Ground rules

- **Zero dependencies.** `plugin/index.js` may use Node builtins and the
  global `fetch` only. No npm packages — the plugin is imported from outside
  dsh's install closure, so it can never resolve a `node_modules`.
- **Keep the installer idempotent.** `searxng/searxng-install.sh` must stay
  safe to re-run; it's the "one-shot deploy" that the README promises.
- **No secrets.** The only generated value is a per-machine SearXNG secret
  key, written with mode `600`. Never commit real settings files or keys.

## Local test loop

You need a SearXNG instance answering JSON on `127.0.0.1:8888` (any recent
build works — the suite doesn't depend on the pinned commit):

```bash
# 1. spin one up (idempotent), e.g. from this checkout
bash searxng/searxng-install.sh

# 2. run the plugin test suite (config cases + a live search)
node plugin/test.mjs
```

The GitHub workflow (`.github/workflows/verify.yml`) does the same thing on
every push and PR, with a disposable SearXNG container.

## Releases

The version is a single source of truth: `plugin/package.json`.

1. Bump `version` in `plugin/package.json` (semver).
2. Add a `CHANGELOG.md` entry (date + what changed).
3. Commit, tag `vX.Y.Z`, and publish a GitHub Release attaching the tarball
   (see README "Sharing") and its `.sha256`.

## Commit conventions

Conventional Commits: `feat: …`, `fix: …`, `docs: …`, `chore: …`, etc.
Changes land on `main` via pull request — no direct pushes.
