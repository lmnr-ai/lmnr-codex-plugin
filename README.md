# Laminar Codex Plugin

Trace [OpenAI Codex CLI](https://github.com/openai/codex) sessions in [Laminar](https://laminar.sh). The hook reads Codex rollout JSONL files and exports one Laminar trace per Codex turn.

Each trace contains:

- a root span with the user prompt and final assistant answer
- one LLM span per model step, with model name, GenAI messages, and token usage
- one tool span per shell/MCP/web/custom tool call
- session grouping by Codex thread id

The hook fails open: if Laminar is unreachable or anything goes wrong, Codex is not blocked.

## Installation

Recommended:

```bash
lmnr-cli plugin add codex
```

The CLI logs in if needed, lets you pick a Laminar project, mints a project API key, installs the bundled hook under `~/.codex/lmnr/`, and adds a Codex `Stop` hook to `~/.codex/config.toml`.

Manual install is also possible:

```toml
# ~/.codex/config.toml
[features]
hooks = true

[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "node /path/to/lmnr-codex-plugin/dist/hook.cjs"
timeout = 30
```

Then ensure the Codex environment contains:

```bash
export LMNR_PROJECT_API_KEY="<your key>"
```

Older Codex versions can use legacy notify mode:

```toml
notify = ["node", "/path/to/lmnr-codex-plugin/dist/hook.cjs"]
```

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `LMNR_PROJECT_API_KEY` / `CODEX_LMNR_PROJECT_API_KEY` | — | Laminar project API key. If unset, the hook exits silently. |
| `LMNR_BASE_URL` / `CODEX_LMNR_BASE_URL` | `https://api.lmnr.ai` | Laminar API base URL; for self-hosted use e.g. `http://localhost:8000`. |
| `LMNR_USER_ID` | `lmnr-cli login` identity, if present | Optional user id. Explicit env wins; otherwise the hook reads `~/.config/lmnr/credentials.json` and prefers `userEmail`, then `userId`. |

Advanced env-only knobs: `CODEX_HOME` changes rollout discovery; `CODEX_LMNR_STATE_DIR` relocates state/lock/log files; `CODEX_LMNR_MAX_CHARS` caps captured text fields (default `20000`); `CODEX_LMNR_DEBUG=1` writes debug logs to `lmnr_hook.log`.

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
