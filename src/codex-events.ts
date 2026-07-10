import type { Json, Row } from "./types.js";

export interface SessionMetaInfo {
  threadId?: string;
  cwd?: string;
  branch?: string;
  cliVersion?: string;
  originator?: string;
  parentThreadId?: string;
}

export interface ToolCall {
  callId: string;
  name: string;
  input: Json;
  timestamp: Json;
  output?: Json;
  outputTimestamp?: Json;
}

export type CodexEvent =
  | { kind: "session_meta"; meta: SessionMetaInfo; timestamp: Json }
  | { kind: "turn_context"; model: string; timestamp: Json }
  | { kind: "user_message"; text: string; timestamp: Json }
  | { kind: "assistant_message"; text: string; timestamp: Json }
  | { kind: "reasoning"; text: string; timestamp: Json }
  | { kind: "tool_call"; call: ToolCall; timestamp: Json }
  | { kind: "tool_output"; callId: string; output: Json; timestamp: Json }
  | { kind: "token_usage"; usage: Record<string, number>; timestamp: Json }
  | { kind: "turn_complete"; lastAssistantText: string | null; timestamp: Json }
  | { kind: "turn_aborted"; timestamp: Json };

function getLineType(row: Row): string | null {
  const t = row.type;
  return typeof t === "string" ? t : null;
}

function getPayload(row: Row): Row {
  const p = row.payload;
  return typeof p === "object" && p !== null && !Array.isArray(p) ? p : {};
}

/** Join the text of a Codex message content array (input_text / output_text / text items). */
export function extractTextFromContent(content: Json): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === "object" && item !== null && typeof item.text === "string") {
        parts.push(item.text);
      } else if (typeof item === "string") {
        parts.push(item);
      }
    }
    return parts.filter((p) => p).join("\n");
  }
  return "";
}

// Codex injects context wrapped in pseudo-XML tags as role=user messages;
// these are not real prompts and must not start turns.
const INJECTED_USER_PREFIXES = ["<environment_context>", "<user_instructions>", "<ENVIRONMENT_CONTEXT>", "<USER_INSTRUCTIONS>"];

export function isInjectedUserText(text: string): boolean {
  const trimmed = text.trimStart();
  return INJECTED_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

// Codex usage object -> plugin usage key names. Codex's input_tokens already
// includes cached_input_tokens (OpenAI convention); span rendering computes
// total tokens from normalized input/output keys later.
const USAGE_KEY_MAP: Record<string, string> = {
  input_tokens: "input_tokens",
  cached_input_tokens: "cache_read_input_tokens",
  output_tokens: "output_tokens",
  reasoning_output_tokens: "reasoning_tokens",
};

export function mapUsage(usage: Json): Record<string, number> | null {
  if (typeof usage !== "object" || usage === null) {
    return null;
  }
  const details: Record<string, number> = {};
  for (const [src, dst] of Object.entries(USAGE_KEY_MAP)) {
    const v = usage[src];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      details[dst] = v;
    }
  }
  return Object.keys(details).length > 0 ? details : null;
}

/** function_call.arguments is a raw JSON string on the wire; parse with a string fallback. */
export function parseArguments(args: Json): Json {
  if (typeof args !== "string") {
    return args ?? {};
  }
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

function decodeSessionMeta(row: Row, payload: Row): CodexEvent {
  const git = payload.git;
  return {
    kind: "session_meta",
    timestamp: row.timestamp,
    meta: {
      threadId: typeof payload.id === "string" ? payload.id : undefined,
      cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
      branch: typeof git === "object" && git !== null && typeof git.branch === "string" ? git.branch : undefined,
      cliVersion: typeof payload.cli_version === "string" ? payload.cli_version : undefined,
      originator: typeof payload.originator === "string" ? payload.originator : undefined,
      parentThreadId: typeof payload.parent_thread_id === "string" ? payload.parent_thread_id : undefined,
    },
  };
}

function decodeResponseItem(row: Row, payload: Row): CodexEvent | null {
  const timestamp = row.timestamp;
  switch (payload.type) {
    case "message": {
      const text = extractTextFromContent(payload.content);
      if (payload.role === "user") {
        return isInjectedUserText(text) ? null : { kind: "user_message", text, timestamp };
      }
      if (payload.role === "assistant") {
        return { kind: "assistant_message", text, timestamp };
      }
      return null;
    }
    case "reasoning": {
      const text = extractTextFromContent(payload.content) || extractTextFromContent(payload.summary);
      return { kind: "reasoning", text, timestamp };
    }
    case "function_call":
      return {
        kind: "tool_call",
        timestamp,
        call: {
          callId: String(payload.call_id ?? payload.id ?? ""),
          name: String(payload.name ?? "unknown"),
          input: parseArguments(payload.arguments),
          timestamp,
        },
      };
    case "local_shell_call":
      return {
        kind: "tool_call",
        timestamp,
        call: {
          callId: String(payload.call_id ?? payload.id ?? ""),
          name: "shell",
          input: payload.action ?? {},
          timestamp,
        },
      };
    case "custom_tool_call":
      return {
        kind: "tool_call",
        timestamp,
        call: {
          callId: String(payload.call_id ?? payload.id ?? ""),
          name: String(payload.name ?? "unknown"),
          input: payload.input ?? {},
          timestamp,
        },
      };
    case "web_search_call":
      return {
        kind: "tool_call",
        timestamp,
        call: {
          callId: String(payload.id ?? ""),
          name: "web_search",
          input: payload.action ?? {},
          timestamp,
        },
      };
    case "function_call_output":
    case "custom_tool_call_output":
      return { kind: "tool_output", callId: String(payload.call_id ?? ""), output: payload.output ?? null, timestamp };
    default:
      return null;
  }
}

function decodeEventMsg(row: Row, payload: Row): CodexEvent | null {
  const timestamp = row.timestamp;
  switch (payload.type) {
    case "token_count": {
      const info = payload.info;
      const last = typeof info === "object" && info !== null ? info.last_token_usage : null;
      const usage = mapUsage(last);
      return usage === null ? null : { kind: "token_usage", usage, timestamp };
    }
    case "task_complete": {
      const lastMsg = payload.last_agent_message;
      return { kind: "turn_complete", lastAssistantText: typeof lastMsg === "string" && lastMsg ? lastMsg : null, timestamp };
    }
    case "turn_aborted":
      return { kind: "turn_aborted", timestamp };
    default:
      // user_message / agent_message / agent_reasoning duplicate response_item
      // content and are ignored; other events are irrelevant to tracing.
      return null;
  }
}

export function decodeCodexRow(row: Row): CodexEvent | null {
  if (typeof row !== "object" || row === null) {
    return null;
  }
  const lineType = getLineType(row);
  const payload = getPayload(row);
  switch (lineType) {
    case "session_meta":
      return decodeSessionMeta(row, payload);
    case "turn_context": {
      const model = payload.model;
      return typeof model === "string" && model ? { kind: "turn_context", model, timestamp: row.timestamp } : null;
    }
    case "response_item":
      return decodeResponseItem(row, payload);
    case "event_msg":
      return decodeEventMsg(row, payload);
    default:
      // compacted / world_state and unknown line types are skipped.
      return null;
  }
}

export function decodeCodexRows(rows: Row[]): CodexEvent[] {
  const events: CodexEvent[] = [];
  for (const row of rows) {
    const event = decodeCodexRow(row);
    if (event !== null) {
      events.push(event);
    }
  }
  return events;
}
