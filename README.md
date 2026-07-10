# Laminar Codex Plugin

OpenTelemetry/Laminar observability hook for the [OpenAI Codex CLI](https://github.com/openai/codex). It reads Codex rollout JSONL files after each turn and exports one Laminar trace per Codex turn.

Each trace contains:

- a root `DEFAULT` span with the user prompt and final assistant answer
- one `LLM` span per model step, including `gen_ai.*` messages, model, and token usage
- one `TOOL` span per shell/MCP/web/custom tool call

Traces are tagged `codex` and grouped by the Codex thread id as the Laminar session id.

## Installation

Requires Node.js 18+ and a Laminar project API key.

1. Build, or use the committed bundle at `dist/hook.cjs`:

   ```bash
   npm install
   npm run build
   ```

2. Register the hook in `~/.codex/config.toml`.

   Codex >= 0.144:

   ```toml
   [features]
   hooks = true

   [[hooks.Stop]]
   [[hooks.Stop.hooks]]
   type = "command"
   command = "node /path/to/lmnr-codex-plugin/dist/hook.cjs"
   timeout = 30
   ```

   Older Codex versions:

   ```toml
   notify = ["node", "/path/to/lmnr-codex-plugin/dist/hook.cjs"]
   ```

3. Export your Laminar project API key in the environment Codex runs in:

   ```bash
   export LMNR_PROJECT_API_KEY="<your key>"
   ```

The same bundle supports both hook systems.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `LMNR_PROJECT_API_KEY` / `CODEX_LMNR_PROJECT_API_KEY` | — | Laminar project API key. If unset, the hook exits silently. |
| `LMNR_BASE_URL` / `CODEX_LMNR_BASE_URL` | `https://api.lmnr.ai` | Laminar API base URL. |
| `LMNR_USER_ID` | `lmnr-cli login` identity, if present | Optional user id. Explicit env wins; otherwise the hook reads `~/.config/lmnr/credentials.json` and prefers `userEmail`, then `userId`. |
| `CODEX_HOME` | `~/.codex` | Codex home directory, used to locate rollout files in legacy notify mode. |
| `CODEX_LMNR_STATE_DIR` | `<CODEX_HOME>/lmnr` | State, lock, and log directory. |
| `CODEX_LMNR_MAX_CHARS` | `20000` | Max captured chars per input/output before truncation. |
| `CODEX_LMNR_DEBUG` | off | Set to `1` or `true` for debug logging. |

## How it works

- Codex writes rollout JSONL files under `~/.codex/sessions/YYYY/MM/DD/`.
- The hook incrementally reads bytes appended since the previous run, decodes raw Codex rows into normalized events, assembles turns, and exports completed turns to `{LMNR_BASE_URL}/v1/traces` using OTLP/HTTP JSON.
- Span timestamps are backdated to rollout timestamps.
- The hook is fail-open: it always exits 0 and logs errors to `<state dir>/lmnr_hook.log`.
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
