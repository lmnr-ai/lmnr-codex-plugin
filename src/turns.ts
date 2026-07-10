import type { CodexEvent, ToolCall } from "./codex-events.js";
import type { Json } from "./types.js";

export type { ToolCall } from "./codex-events.js";

// ----------------- Turn model -----------------
/**
 * One model request: the contiguous run of model-output items (reasoning,
 * assistant message, tool calls) produced between tool executions.
 */
export interface Step {
  reasoningText: string;
  assistantText: string;
  toolCalls: ToolCall[];
  usage: Record<string, number> | null;
  timestamp: Json; // timestamp of the first model event
  lastModelTimestamp: Json; // timestamp of the last model event
}

export interface Turn {
  userText: string;
  userTimestamp: Json;
  model: string | null;
  steps: Step[];
  lastAssistantText: string;
  endTimestamp: Json; // task_complete timestamp, else last event timestamp
  completed: boolean; // saw task_complete or turn_aborted
  aborted: boolean;
  events: CodexEvent[];
}

// ----------------- Assembly -----------------
class TurnAssemblyState {
  currentTurn: Turn | null = null;
  currentStep: Step | null = null;
  stepClosed = false;
  model: string | null;

  constructor(initialModel: string | null) {
    this.model = initialModel;
  }
}

function newTurn(userText: string, timestamp: Json, event: CodexEvent): Turn {
  return {
    userText,
    userTimestamp: timestamp,
    model: null,
    steps: [],
    lastAssistantText: "",
    endTimestamp: null,
    completed: false,
    aborted: false,
    events: [event],
  };
}

/** Get the current step, opening a new one when none is open or the last one closed. */
function openStep(state: TurnAssemblyState, timestamp: Json): Step | null {
  if (state.currentTurn === null) {
    return null;
  }
  if (state.currentStep === null || state.stepClosed) {
    state.currentStep = {
      reasoningText: "",
      assistantText: "",
      toolCalls: [],
      usage: null,
      timestamp,
      lastModelTimestamp: timestamp,
    };
    state.stepClosed = false;
    state.currentTurn.steps.push(state.currentStep);
  }
  state.currentStep.lastModelTimestamp = timestamp;
  return state.currentStep;
}

function closeTurn(state: TurnAssemblyState, turns: Turn[]): void {
  const turn = state.currentTurn;
  if (turn === null) {
    return;
  }
  turn.model = state.model;
  if (!turn.lastAssistantText) {
    const lastStepWithText = [...turn.steps].reverse().find((s) => s.assistantText);
    turn.lastAssistantText = lastStepWithText ? lastStepWithText.assistantText : "";
  }
  if (turn.endTimestamp === null) {
    const lastEvent = turn.events[turn.events.length - 1];
    turn.endTimestamp = lastEvent ? lastEvent.timestamp : turn.userTimestamp;
  }
  turns.push(turn);
  state.currentTurn = null;
  state.currentStep = null;
  state.stepClosed = false;
}

function attachToolOutput(turn: Turn, callId: string, output: Json, timestamp: Json): void {
  // Search newest-first: outputs follow their calls, usually in the last step.
  for (let s = turn.steps.length - 1; s >= 0; s--) {
    const step = turn.steps[s]!;
    for (let t = step.toolCalls.length - 1; t >= 0; t--) {
      const call = step.toolCalls[t]!;
      if (call.callId === callId && call.output === undefined) {
        call.output = output;
        call.outputTimestamp = timestamp;
        return;
      }
    }
  }
}

function appendToCurrentTurn(state: TurnAssemblyState, event: CodexEvent): Turn | null {
  if (state.currentTurn === null) {
    return null;
  }
  state.currentTurn.events.push(event);
  return state.currentTurn;
}

function handleEvent(event: CodexEvent, state: TurnAssemblyState, turns: Turn[]): void {
  switch (event.kind) {
    case "session_meta":
      // Session metadata is handled by the orchestrator.
      return;
    case "turn_context":
      state.model = event.model;
      if (state.currentTurn !== null) {
        state.currentTurn.model = event.model;
      }
      return;
    case "user_message":
      closeTurn(state, turns);
      state.currentTurn = newTurn(event.text, event.timestamp, event);
      return;
    case "assistant_message": {
      const step = openStep(state, event.timestamp);
      if (step !== null) {
        step.assistantText = step.assistantText ? `${step.assistantText}\n${event.text}` : event.text;
        appendToCurrentTurn(state, event);
      }
      return;
    }
    case "reasoning": {
      const step = openStep(state, event.timestamp);
      if (step !== null) {
        if (event.text) {
          step.reasoningText = step.reasoningText ? `${step.reasoningText}\n${event.text}` : event.text;
        }
        appendToCurrentTurn(state, event);
      }
      return;
    }
    case "tool_call": {
      const step = openStep(state, event.timestamp);
      if (step !== null) {
        step.toolCalls.push({ ...event.call });
        appendToCurrentTurn(state, event);
      }
      return;
    }
    case "tool_output": {
      const turn = appendToCurrentTurn(state, event);
      if (turn !== null) {
        attachToolOutput(turn, event.callId, event.output, event.timestamp);
        state.stepClosed = true;
      }
      return;
    }
    case "token_usage": {
      const turn = appendToCurrentTurn(state, event);
      if (turn !== null && turn.steps.length > 0) {
        turn.steps[turn.steps.length - 1]!.usage = event.usage;
      }
      return;
    }
    case "turn_complete": {
      const turn = appendToCurrentTurn(state, event);
      if (turn !== null) {
        turn.completed = true;
        turn.endTimestamp = event.timestamp;
        if (event.lastAssistantText && !turn.lastAssistantText) {
          turn.lastAssistantText = event.lastAssistantText;
        }
      }
      return;
    }
    case "turn_aborted": {
      const turn = appendToCurrentTurn(state, event);
      if (turn !== null) {
        turn.completed = true;
        turn.aborted = true;
        turn.endTimestamp = event.timestamp;
      }
      return;
    }
  }
}

export interface BuildTurnsResult {
  turns: Turn[];
  lastModel: string | null;
}

/**
 * Groups decoded Codex events into turns: a real user message opens a turn;
 * response events form steps; turn_complete / turn_aborted closes timing.
 * `initialModel` carries the model across incremental batches (the
 * turn_context event may have landed in an earlier batch).
 */
export function buildTurns(events: CodexEvent[], initialModel: string | null = null): BuildTurnsResult {
  const turns: Turn[] = [];
  const state = new TurnAssemblyState(initialModel);

  for (const event of events) {
    handleEvent(event, state, turns);
  }

  closeTurn(state, turns);
  return { turns, lastModel: state.model };
}
