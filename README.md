# Laminar Codex Plugin

Trace [OpenAI Codex CLI](https://github.com/openai/codex) sessions in [Laminar](https://laminar.sh). The hook reads Codex rollout JSONL files and exports one Laminar trace per Codex turn.

Each trace contains:

- a root span with the user prompt and final assistant answer
- one LLM span per model step, with model name, GenAI messages, and token usage
- one tool span per shell/MCP/web/custom tool call
- session grouping by Codex thread id

The hook fails open: if Laminar is unreachable or anything goes wrong, Codex is not blocked.

## Installation

```bash
lmnr-cli plugin add codex
```

The CLI logs you in, lets you pick the Laminar project that should receive your
Codex traces, mints a project API key, writes it to
`~/.config/lmnr/codex-plugin.json`, and installs this plugin via Codex's native
plugin marketplace (`codex plugin marketplace add` + `codex plugin add`). Restart
Codex to activate it.

Manual install is equivalent:

```bash
codex plugin marketplace add lmnr-ai/lmnr-codex-plugin
codex plugin add lmnr@lmnr
```

This is a native Codex plugin: `.codex-plugin/plugin.json` declares a `Stop`
hook (`hooks.json`) that runs the committed `dist/hook.cjs`. Codex snapshots the
plugin into its versioned cache and exposes that directory as `$PLUGIN_ROOT` when
running the hook, so no launcher shims are needed.

## Configuration

The project API key and base URL are read from `~/.config/lmnr/codex-plugin.json`
(written by `lmnr-cli plugin add codex`):

```json
{ "projectApiKey": "...", "baseUrl": "https://api.lmnr.ai" }
```

| Source | Default | Description |
| --- | --- | --- |
| `~/.config/lmnr/codex-plugin.json` `projectApiKey` | — | Laminar project API key. If unset (and no env), the hook exits silently. |
| `~/.config/lmnr/codex-plugin.json` `baseUrl` | `https://api.lmnr.ai` | Laminar API base URL; for self-hosted use e.g. `http://localhost:8000`. |
| `LMNR_USER_ID` | `lmnr-cli login` identity, if present | Optional user id. Explicit env wins; otherwise the hook reads `~/.config/lmnr/credentials.json` and prefers `userEmail`, then `userId`. |

The env vars `LMNR_PROJECT_API_KEY` / `LMNR_BASE_URL` (or the `CODEX_LMNR_*`
variants) override the file when set (handy for CI). Advanced env-only knobs:
`CODEX_HOME` changes rollout discovery; `CODEX_LMNR_STATE_DIR` relocates
state/lock/log files; `CODEX_LMNR_MAX_CHARS` caps captured text fields (default
`20000`); `CODEX_LMNR_DEBUG=1` writes debug logs to `lmnr_hook.log`.

## How it works

- Codex writes rollouts under `~/.codex/sessions/YYYY/MM/DD/`.
- The hook incrementally reads appended bytes, decodes raw Codex rows into normalized events, assembles turns, and exports spans to `{LMNR_BASE_URL}/v1/traces` using OTLP/HTTP JSON.
- Span timestamps are backdated to rollout timestamps.
- Export is at-least-once: offsets advance only after successful export, so transient failures retry and may duplicate rather than lose traces.
- Trailing incomplete turns are retried briefly, then held or emitted if they already contain renderable model output.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

`dist/hook.cjs` is committed intentionally so Codex can run the hook with plain `node` and no install step. Rebuild and commit it whenever `src/` changes.

## License

Apache-2.0
