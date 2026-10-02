---
name: Bug report
about: Something in the plugin, installer, or SearXNG backend is not working
title: ''
labels: bug
assignees: ''
---

## What happened

<!-- A short description, and what you expected instead. -->

## Environment

- OS (e.g. macOS 15, Ubuntu 24.04): 
- dsh version / how dsh is started (`dsh web`, CLI, …): 
- How SearXNG is running (this installer / docker / other): 
- SearXNG URL the plugin uses (default `http://127.0.0.1:8888` or custom): 
- `engines` setting in use (default list or custom): 

## What to check first

- `curl -s 'http://127.0.0.1:8888/search?q=test&format=json' | head -c 200`
  — does the instance answer JSON? (a `403` means JSON format is not enabled)
- `curl -s http://127.0.0.1:8888/healthz`
- Does `web_search` fail in **all** dsh sessions, or only some? (config-block
  changes hot-reload only while dsh's config watcher is alive — in long-running
  `dsh web` sessions a restart is the reliable fix)

## Error output

<!-- Paste the relevant dsh error / tool output. Redact anything sensitive. -->
