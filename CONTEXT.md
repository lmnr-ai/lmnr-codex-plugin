# Laminar Codex Plugin

This context describes the conversation-observability language used by the hook that reads Codex rollout files and exports traces to Laminar.

## Language

**Codex rollout row**:
A raw JSON object written by Codex to a session rollout JSONL file. It reflects Codex's storage format, not the plugin's conversation model.
_Avoid_: transcript message, Laminar event

**Codex event**:
A normalized plugin-domain event decoded from one Codex rollout row, such as a user message, tool call, token usage update, or turn completion. It is independent of Laminar span conventions.
_Avoid_: raw row, response item, Laminar payload

**Turn**:
A user-prompt-centered slice of a Codex session containing model steps, tool calls, outputs, usage, and a completion or abort marker.
_Avoid_: request, trace

**Model step**:
One model-generation interval within a turn, ending before tool execution or turn completion. A turn can contain multiple model steps when tools are called.
_Avoid_: LLM span, response item

**Laminar trace**:
The exported observability representation of one completed turn in Laminar, composed of a root span plus model and tool spans.
_Avoid_: Codex event, rollout row
