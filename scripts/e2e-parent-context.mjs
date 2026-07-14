#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { ExportResultCode } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const configPath = path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'lmnr', 'codex-plugin.json');
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const apiKey = process.env.LMNR_PROJECT_API_KEY ?? cfg.projectApiKey;
const baseUrl = (process.env.LMNR_BASE_URL ?? cfg.baseUrl ?? 'https://api.lmnr.ai').replace(/\/+$/, '');
const projectId = process.env.LMNR_PROJECT_ID ?? process.argv[2];

if (!apiKey) throw new Error(`Missing projectApiKey in ${configPath}`);
if (!projectId) throw new Error('Usage: LMNR_PROJECT_ID=<project-id> node scripts/e2e-parent-context.mjs');

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

function tryRun(cmd, args) {
  try { run(cmd, args); } catch { /* ignore cleanup failures */ }
}

function otelTraceIdToUuid(id) {
  return id.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
}

function otelSpanIdToUuid(id) {
  return `00000000-0000-0000-${id.slice(0, 4)}-${id.slice(4)}`;
}

class CollectingSpanProcessor {
  spans = [];
  onStart() {}
  onEnd(span) { this.spans.push(span); }
  forceFlush() { return Promise.resolve(); }
  shutdown() { return Promise.resolve(); }
}

async function exportParentSpan(runId) {
  const processor = new CollectingSpanProcessor();
  const provider = new BasicTracerProvider({
    resource: new Resource({
      'service.name': 'codex-parent-context-e2e',
      'telemetry.sdk.language': 'nodejs',
      'telemetry.sdk.name': 'lmnr-codex-plugin-e2e',
    }),
    spanProcessors: [processor],
  });
  const tracer = provider.getTracer('lmnr.codex-parent-context-e2e');
  const span = tracer.startSpan(`E2E parent ${runId}`, {
    kind: SpanKind.INTERNAL,
    attributes: {
      'lmnr.span.type': 'EVALUATION',
      'lmnr.span.input': JSON.stringify({ runId }),
      'lmnr.span.output': JSON.stringify({ status: 'started' }),
      'lmnr.association.properties.metadata.source': 'codex-parent-context-e2e',
      'e2e.run_id': runId,
    },
  });
  span.setStatus({ code: SpanStatusCode.OK });
  const sc = span.spanContext();
  span.end();

  const exporter = new OTLPTraceExporter({
    url: `${baseUrl}/v1/traces`,
    headers: { Authorization: `Bearer ${apiKey}` },
    timeoutMillis: 5000,
  });
  const result = await new Promise((resolve) => exporter.export(processor.spans, resolve));
  await exporter.shutdown().catch(() => {});
  if (result.code !== ExportResultCode.SUCCESS) {
    throw new Error(`parent OTLP export failed: ${result.error ?? 'unknown error'}`);
  }

  return {
    traceIdHex: sc.traceId,
    traceIdUuid: otelTraceIdToUuid(sc.traceId),
    spanIdHex: sc.spanId,
    spanIdUuid: otelSpanIdToUuid(sc.spanId),
    serializedContext: JSON.stringify({
      traceId: otelTraceIdToUuid(sc.traceId),
      spanId: otelSpanIdToUuid(sc.spanId),
      isRemote: true,
    }),
  };
}

function installLocalPlugin() {
  tryRun('codex', ['plugin', 'remove', 'laminar@laminar', '--json']);
  tryRun('codex', ['plugin', 'remove', 'lmnr@lmnr', '--json']);
  tryRun('codex', ['plugin', 'marketplace', 'remove', 'laminar', '--json']);
  tryRun('codex', ['plugin', 'marketplace', 'remove', 'lmnr', '--json']);
  run('codex', ['plugin', 'marketplace', 'add', repoRoot, '--json']);
  run('codex', ['plugin', 'add', 'lmnr@lmnr', '--json']);
}

function querySpans(traceIdUuid) {
  const sql = `SELECT name, span_type, toString(span_id) AS span_id, toString(parent_span_id) AS parent_span_id, toString(trace_id) AS trace_id FROM spans WHERE trace_id = '${traceIdUuid}' ORDER BY start_time ASC`;
  return JSON.parse(run('npx', ['-y', 'lmnr-cli@latest', 'sql', '--project-id', projectId, '--json', 'query', sql]));
}

async function waitForSpans(traceIdUuid, runId) {
  const deadline = Date.now() + 90000;
  let last = [];
  while (Date.now() < deadline) {
    last = querySpans(traceIdUuid);
    const parent = last.find((s) => s.name === `E2E parent ${runId}`);
    const codexRoot = last.find((s) => s.name.startsWith('Codex - Turn'));
    const llm = last.find((s) => s.name === 'LLM Call 1');
    if (parent && codexRoot && llm) return last;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`Timed out waiting for parent/Codex/LLM spans. Last rows: ${JSON.stringify(last, null, 2)}`);
}

const runId = `parent-context-${Date.now()}`;
console.log(`runId=${runId}`);
console.log('Building and installing local plugin snapshot...');
run('npm', ['run', 'build'], { cwd: repoRoot });
installLocalPlugin();

console.log('Exporting parent EVALUATION span...');
const parent = await exportParentSpan(runId);
console.log(`traceId=${parent.traceIdUuid}`);
console.log(`parentSpanId=${parent.spanIdUuid}`);

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmnr-codex-parent-e2e-'));
console.log('Running codex with LMNR_PARENT_SPAN_CONTEXT...');
const child = spawnSync('codex', ['exec', '--dangerously-bypass-hook-trust', '--skip-git-repo-check', `Reply with exactly: ${runId}`], {
  cwd: repoRoot,
  encoding: 'utf8',
  env: {
    ...process.env,
    LMNR_PARENT_SPAN_CONTEXT: parent.serializedContext,
    CODEX_LMNR_STATE_DIR: stateDir,
    CODEX_LMNR_DEBUG: '1',
  },
});
process.stdout.write(child.stdout ?? '');
process.stderr.write(child.stderr ?? '');
if (child.status !== 0) throw new Error(`codex exec failed with status ${child.status}`);

const hookLog = path.join(stateDir, 'lmnr_hook.log');
const logText = fs.existsSync(hookLog) ? fs.readFileSync(hookLog, 'utf8') : '';
if (!logText.includes('OTLP export:')) {
  throw new Error(`Codex hook did not report successful export. Log:\n${logText}`);
}

console.log('Polling Laminar via lmnr-cli SQL...');
const spans = await waitForSpans(parent.traceIdUuid, runId);
const parentRow = spans.find((s) => s.name === `E2E parent ${runId}`);
const codexRoot = spans.find((s) => s.name.startsWith('Codex - Turn'));
const llm = spans.find((s) => s.name === 'LLM Call 1');

assert.equal(parentRow.span_type, 'EVALUATION');
assert.equal(parentRow.parent_span_id, '00000000-0000-0000-0000-000000000000');
assert.equal(codexRoot.parent_span_id, parentRow.span_id);
assert.equal(llm.parent_span_id, codexRoot.span_id);
assert.ok(spans.every((s) => s.trace_id === parent.traceIdUuid));

console.log(JSON.stringify({ ok: true, traceId: parent.traceIdUuid, parent: parentRow, codexRoot, llm, spanCount: spans.length }, null, 2));
