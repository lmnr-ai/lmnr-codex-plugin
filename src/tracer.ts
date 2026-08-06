import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type AttributeValue,
  type Context,
  type Span,
} from "@opentelemetry/api";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { BasicTracerProvider, type ReadableSpan, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { EXPORT_TIMEOUT_S, type LaminarConfig } from "./config.js";
import { debug, info } from "./logger.js";
import type { Json } from "./types.js";
import { jsonDumps } from "./util.js";

// Laminar span-attribute keys.
export const SPAN_TYPE_ATTR = "lmnr.span.type";
export const SPAN_INPUT_ATTR = "lmnr.span.input";
export const SPAN_OUTPUT_ATTR = "lmnr.span.output";
export const ASSOC_PREFIX = "lmnr.association.properties";

/** Convert loosely-typed attributes to OTel attributes, dropping unsupported values. */
function toOtelAttributes(attrs: Record<string, Json>): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) {
      continue;
    }
    if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      // We only emit primitive arrays (e.g. string tags); drop null holes.
      const arr = value.filter((x) => x !== null && x !== undefined);
      out[key] = arr as AttributeValue;
      continue;
    }
    // Objects and other types are unsupported as attribute values — drop them.
  }
  return out;
}

/** Collects finished spans in memory so we can export them in one request. */
class CollectingSpanProcessor implements SpanProcessor {
  readonly spans: ReadableSpan[] = [];
  onStart(): void {}
  onEnd(span: ReadableSpan): void {
    this.spans.push(span);
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/** Owns the OTel provider + a collecting processor and mints spans. */
export class TraceEmitter {
  readonly config: LaminarConfig;
  /**
   * Session the spans being minted belong to. Set once per turn before any span
   * is created, so `startSpan` can stamp session/user association on EVERY span
   * rather than only the trace root — span-level queries and filters in Laminar
   * read these off the span, not off the trace.
   */
  sessionId: string | null = null;
  private readonly processor: CollectingSpanProcessor;
  private readonly tracer;

  constructor(config: LaminarConfig) {
    this.config = config;
    this.processor = new CollectingSpanProcessor();
    const provider = new BasicTracerProvider({
      resource: new Resource({
        "service.name": "codex",
        "telemetry.sdk.language": "nodejs",
        "telemetry.sdk.name": "lmnr-codex-plugin",
      }),
      spanProcessors: [this.processor],
    });
    this.tracer = provider.getTracer("lmnr.codex");
  }

  get spans(): ReadableSpan[] {
    return this.processor.spans;
  }

  startSpan(name: string, startTime: Date, attributes: Record<string, Json>, parent: SpanHandle | null): SpanHandle {
    const parentCtx = parent ? parent.context : ROOT_CONTEXT;
    const span = this.tracer.startSpan(
      name,
      { kind: SpanKind.INTERNAL, startTime, attributes: toOtelAttributes(attributes) },
      parentCtx
    );
    span.setStatus({ code: SpanStatusCode.OK });
    return new SpanHandle(span, startTime);
  }
}

/** A mutable span under construction; end() finalizes it into the emitter. */
export class SpanHandle {
  readonly context: Context;
  private readonly span: Span;
  private readonly startTime: Date;
  private ended = false;

  constructor(span: Span, startTime: Date) {
    this.span = span;
    this.startTime = startTime;
    this.context = trace.setSpan(ROOT_CONTEXT, span);
  }

  get traceId(): string {
    return this.span.spanContext().traceId;
  }

  get spanId(): string {
    return this.span.spanContext().spanId;
  }

  setAttributes(attributes: Record<string, Json>): void {
    this.span.setAttributes(toOtelAttributes(attributes));
  }

  end(endTime: Date | null): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    let end = endTime ?? this.startTime;
    if (end.getTime() < this.startTime.getTime()) {
      end = this.startTime;
    }
    this.span.end(end);
  }
}

export interface StartSpanArgs {
  name: string;
  parent: SpanHandle | null;
  startTime: Date | null;
  spanType?: string;
  inputValue?: Json;
  attributes?: Record<string, Json>;
}

/** Mint a span with the Laminar span-type + optional JSON input attribute. */
export function startSpan(emitter: TraceEmitter, args: StartSpanArgs): SpanHandle {
  const attrs: Record<string, Json> = { [SPAN_TYPE_ATTR]: args.spanType ?? "DEFAULT" };
  if (args.inputValue !== undefined && args.inputValue !== null) {
    attrs[SPAN_INPUT_ATTR] = jsonDumps(args.inputValue);
  }
  // Session and user ride EVERY span, not just the root. Both are constant for
  // the whole turn, so unlike per-span metadata they cannot pollute or race on
  // the trace-level association. Without them a span-level query — "LLM spans
  // for session X" — matches nothing.
  if (emitter.sessionId) {
    attrs[`${ASSOC_PREFIX}.session_id`] = emitter.sessionId;
  }
  if (emitter.config.userId) {
    attrs[`${ASSOC_PREFIX}.user_id`] = emitter.config.userId;
  }
  if (args.attributes) {
    Object.assign(attrs, args.attributes);
  }
  return emitter.startSpan(args.name, args.startTime ?? new Date(), attrs, args.parent);
}

/** Export the emitter's finished spans in one OTLP/HTTP/JSON request; true on 2xx. */
async function exportSpans(emitter: TraceEmitter): Promise<boolean> {
  const spans = emitter.spans;
  if (spans.length === 0) {
    return true;
  }
  const exporter = new OTLPTraceExporter({
    url: `${emitter.config.baseUrl}/v1/traces`,
    headers: { Authorization: `Bearer ${emitter.config.apiKey}` },
    timeoutMillis: Math.round(EXPORT_TIMEOUT_S * 1000),
  });
  try {
    const result = await new Promise<ExportResult>((resolve) => {
      exporter.export(spans, resolve);
    });
    if (result.code === ExportResultCode.SUCCESS) {
      debug(`OTLP export: ${spans.length} span(s)`);
      return true;
    }
    info(`OTLP export failed: ${result.error ?? "unknown error"}`);
    return false;
  } catch (e) {
    info(`OTLP export failed: ${e}`);
    return false;
  } finally {
    try {
      await exporter.shutdown();
    } catch {
      // Ignore shutdown errors.
    }
  }
}

/**
 * Export capped by a hard timeout so a hung connection can't stall Codex.
 * Returns false on timeout (state is kept, turns retried next run).
 */
export async function exportWithTimeout(emitter: TraceEmitter): Promise<boolean> {
  const timeoutMs = Math.round((EXPORT_TIMEOUT_S + 1) * 1000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([exportSpans(emitter), timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
