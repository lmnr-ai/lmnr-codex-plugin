# codex-plugin

Laminar observability hook for the OpenAI Codex CLI. Parses Codex rollout JSONL files and exports completed turns as OTLP traces to Laminar. Lives in the lmnr monorepo for now; planned to split into its own repo later.

## Layout

- `src/hook.ts` — entrypoint. Reads the hook payload (stdin for the >=0.144 hooks system, last argv arg for legacy `notify`), resolves the session id + rollout path, and runs the emit pipeline. Always exits 0.
- `src/config.ts` — config resolution. The project API key + base URL come from `~/.config/lmnr/codex-plugin.json` (written by `lmnr-cli plugin add codex`); `LMNR_*` / `CODEX_LMNR_*` env vars OVERRIDE the file when set. Zero-config `user_id` from `lmnr-cli login`. State-dir paths, limits.
- `src/rollout.ts` — rollout JSONL reading: timestamp parsing, incremental byte-offset reads with partial-line buffering, truncation, rollout-path discovery by thread id.
- `src/codex-events.ts` — Codex raw-row decoder: line typing, content extraction, injected-user-text filtering, tool-call normalization, usage-key normalization, session metadata decoding.
- `src/turns.ts` — pure state machine grouping decoded Codex events into turns (user message → steps → task_complete/turn_aborted).
- `src/emit.ts` — turn → span-tree construction (root DEFAULT span + LLM spans per step + TOOL spans per call), Laminar association attributes, session-state orchestration under the state lock.
- `src/tracer.ts` — OTel BasicTracerProvider with a collecting processor, OTLP/HTTP JSON export with Bearer auth and a hard timeout.
- `src/state.ts` — per-session state (`offset`, `buffer`, `turnCount`, `pendingTurnEvents`, `lastModel`, `meta`), atomic writes, proper-lockfile locking. Legacy `pendingTurnRows` is decoded on load for migration only.
- `src/logger.ts` — file logger with 5 MB rotation.
- `src/types.ts`, `src/util.ts` — shared types and helpers.
- `tests/` — `node:test` suites run via tsx (`npm test`).
- `dist/hook.cjs` — committed esbuild bundle. This is the deployable artifact; rebuild (`npm run build`) and commit it with any `src/` change.
- `.codex-plugin/plugin.json` — native Codex plugin manifest (`name`/`version`/`description` + `"hooks": "./hooks.json"`). The `hooks` path resolves relative to the plugin **root**, not to `.codex-plugin/`.
- `hooks.json` — declares the `Stop` command hook. The command is `node "$PLUGIN_ROOT/dist/hook.cjs"` — see the packaging invariant below.
- `.agents/plugins/marketplace.json` — marketplace manifest (`source: "./"`) so `codex plugin marketplace add <repo|owner/repo|ssh-url>` + `codex plugin add lmnr@lmnr` install the plugin.

## Rollout format notes (verified against openai/codex rust-v0.144.0)

- Every line is `{"timestamp","type","payload"}`. Types: `session_meta`, `turn_context` (carries model), `response_item`, `event_msg`, `compacted`.
- `response_item` subtypes: `message`, `reasoning`, `function_call` (its `arguments` is a raw JSON **string** — double-parse), `function_call_output`, `local_shell_call`, `custom_tool_call`/`_output`, `web_search_call`.
- Turn boundaries come from `event_msg` payloads: `task_started`, `task_complete` (carries `last_agent_message`), `turn_aborted`.
- `token_count` events carry `info.last_token_usage`; `input_tokens` already INCLUDES cached tokens (OpenAI convention), so `llm.usage.total_tokens = input + output` — do not add `cache_read` again.
- Forked sessions copy history, so a rollout can contain multiple `session_meta` lines: **first one wins** (`captureSessionMeta`).
- User messages beginning with `<environment_context>` / `<user_instructions>` (any case) are Codex-injected, not real prompts — filtered out.

## Hook invocation modes

- **Hooks system (>= 0.144):** JSON on stdin with `session_id`, `transcript_path`, `hook_event_name`. Only `Stop`/`SubagentStop` events trigger emission.
- **Legacy `notify`:** JSON as the final argv argument, kebab-case keys (`thread-id`), no transcript path — the rollout is found by scanning `<CODEX_HOME>/sessions` (depth ≤ 3) for `rollout-*-<threadId>.jsonl`, newest mtime wins.

## Plugin packaging invariants — do not break these

- **The hook command MUST reference the bundle via `$PLUGIN_ROOT`, not a relative path.** Codex runs plugin `Stop` hooks with the working directory set to the **session cwd** (the dir the user launched Codex in), NOT the plugin dir — and provides no substitution token. A relative `node dist/hook.cjs` therefore only works when the user happens to run Codex from a dir containing `dist/hook.cjs`, and silently no-ops (fail-open) everywhere else. Codex sets `PLUGIN_ROOT` (and a `CLAUDE_PLUGIN_ROOT` alias) in the hook's environment to the installed plugin dir, and `type: "command"` hooks run through a shell that expands it — so `node "$PLUGIN_ROOT/dist/hook.cjs"` is the correct, cwd-independent form. Verified end-to-end (a `codex exec` run from an unrelated dir fires the hook and lands a trace).
- **Install snapshots the whole plugin dir** into `~/.codex/plugins/cache/lmnr/lmnr/<version>/`; `dist/hook.cjs` must be committed so it rides along. `codex plugin marketplace add owner/repo` clones over **HTTPS** (anonymous) — so a private repo needs an SSH URL until the repo is public.

## Behavior invariants — do not break these

- **Fail-open:** the hook must never break Codex. `main()` always resolves to exit code 0; top-level catch also exits 0. Errors go to `lmnr_hook.log` only.
- **At-least-once export:** state (offset/turnCount) is persisted only AFTER a successful export. Duplicates on retry are acceptable; silent data loss is not.
- **Per-turn emit failures** (malformed rows) are logged and the turn is skipped — it would fail identically on retry, so it must not poison the offset.
- **Incomplete trailing turns** (no `task_complete` yet) trigger a short retry/poll window first, because `Stop` can fire just before Codex appends `task_complete` and one-shot `codex exec` may not invoke the hook again. If the turn already has renderable model output after the retry window, emit it without `task_complete`; a later lone completion row cannot duplicate it. User-only trailing turns are held via `pendingTurnEvents` and replayed on the next invocation, unless `flushIncompleteTurns` is set.
- **Partial trailing lines:** the reader keeps an unterminated final line in `sessionState.buffer`, but `readNewJsonl` ALWAYS attempts to parse the buffered line on every read (a complete-but-unterminated row — often `task_complete` — is consumed; a genuinely partial line fails JSON.parse and stays buffered). This must be unconditional: the offset advances to EOF regardless, so once no more bytes are appended a gated flush would strand the row forever.
- **File shrink detection:** if the rollout is smaller than the stored offset, reset offset/buffer AND clear `pendingTurnEvents`/`lastModel`, then re-read from zero — the re-read includes the rows that fed the held state, so stale pending events would be prepended twice and mis-assemble turns. `turnCount`/`meta` are kept (duplicate turns with advancing numbers match at-least-once; meta is first-wins for the same session).
- **State locking:** all read-modify-write of `lmnr_state.json` happens under proper-lockfile (`withStateLock`) — concurrent hook invocations are real (subagents).

## Laminar/OTLP ingestion gotchas

- `LMNR_USER_ID` wins for attribution; otherwise `src/config.ts` reads `lmnr-cli login` credentials from `~/.config/lmnr/credentials.json` (or XDG/APPDATA equivalent), preferring `userEmail` then `userId`. Never read the Codex/OpenAI account.
- `LMNR_PARENT_SPAN_CONTEXT` may carry a serialized Laminar span context from a caller (`Laminar.serialize_span_context()` / SDK equivalent). When present and valid, Codex turn root spans use it as their remote parent, joining the caller's trace; when absent/invalid, standalone trace behavior is preserved.
- `lmnr.association.properties.*` (session_id, user_id, metadata.*) go on the ROOT span only — the app-server propagates them trace-wide. Metadata is reserved for trace-constant values (`source`, `os`, `codex_cli_version`, `cwd`, `git_branch`, turn labels). Per-tool/per-generation detail must NOT use that prefix (it would leak onto every span); use plain attrs like `codex.tool.name` or `gen_ai.*` instead. No tags are emitted, matching the Claude Code plugin and SDK convention.
- `lmnr.span.type` values: `DEFAULT`, `LLM`, `TOOL`. Inputs/outputs go in `lmnr.span.input` / `lmnr.span.output` as JSON strings.
- `gen_ai.output.messages` uses the OTel GenAI semconv `{role, parts}` shape (`thinking`/`text`/`tool_call` parts) — NOT the OpenAI chat shape. Reasoning must render distinctly, and the frontend's `OpenAIAssistantMessageSchema` silently strips unknown keys, so a bare `reasoning` field on a chat-shaped message would be invisible. Input messages stay chat-shaped (`{role, content}`); the frontend parses input/output attrs independently.
- Spans are backdated to rollout timestamps via explicit `startTime`/`endTime`.
- The OTel JS OTLP/JSON serializer emits integer attribute values as JSON **numbers** (`{"intValue":10}`), not decimal strings; app-server accepts both. Keep the wire-format envelope test pinned.
- Export is OTLP/HTTP **JSON** to `{base}/v1/traces` with `Authorization: Bearer <key>`, hard 5s timeout.

## Testing

- `npm test` (32 tests), `npm run typecheck`.
- CI runs `npm ci`, typecheck, tests, build, then `git diff --exit-code -- dist/` to catch committed bundle drift.
- `emitNewTurnsFromRollout` takes an injectable `exportFn` so tests exercise the full pipeline without a network; `CODEX_LMNR_STATE_DIR` redirects state for test/e2e isolation.
- For e2e against the local stack: craft a synthetic rollout under a fake `CODEX_HOME`, invoke `dist/hook.cjs` with a legacy-notify argv payload, then verify spans in ClickHouse (`spans`, and `traces_replacing` — ReplacingMergeTree, query with `FINAL`).
