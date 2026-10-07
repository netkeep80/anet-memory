#!/usr/bin/env node
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { openSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  SandboxBusError,
  createEnvelope,
  decodePayload,
  messageFilename,
  parseEnvelope,
  serializeEnvelope,
} from '../../src/sandbox-bus.mjs';

export const EXPERIMENT_PROTOCOL = 'dual-thread-endurance/1';
export const LOCAL_STATE_PROTOCOL = 'dual-thread-endurance/state-v1';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const DEFAULT_ROOT = '/mnt/data/anet-memory-endurance';
const DEFAULT_PORT = 19170;
const DEFAULT_WATCH_MS = 5000;

export function newExperimentState({ runId, node, peer, startedAt = new Date().toISOString() }) {
  assertId(runId, 'run-id');
  assertId(node, 'node');
  assertId(peer, 'peer');
  if (node === peer) throw new Error('node and peer must differ');
  return {
    protocol: LOCAL_STATE_PROTOCOL,
    experiment: EXPERIMENT_PROTOCOL,
    run_id: runId,
    node,
    peer,
    started_at: startedAt,
    next_outgoing_sequence: 1,
    previous_outgoing_message_id: null,
    last_outgoing_sequence: 0,
    last_outgoing_message_id: null,
    last_peer_sequence: 0,
    last_peer_message_id: null,
    seen_peer_message_ids: [],
    sent_count: 0,
    received_count: 0,
    cycle_count: 0,
  };
}

export function acceptPeerEnvelope(state, envelope) {
  validateExperimentState(state);
  const validated = parseEnvelope(serializeEnvelope(envelope));

  if (validated.source !== state.peer || validated.target !== state.node) {
    throw new SandboxBusError('WRONG_EXPERIMENT_CHANNEL', 'incoming envelope source/target does not match this node');
  }

  let payload;
  try {
    payload = JSON.parse(decodePayload(validated).toString('utf8'));
  } catch (error) {
    throw new SandboxBusError('INVALID_EXPERIMENT_PAYLOAD', 'incoming payload is not valid UTF-8 JSON', { cause: error.message });
  }

  if (payload.experiment !== EXPERIMENT_PROTOCOL || payload.run_id !== state.run_id || payload.sender !== state.peer) {
    throw new SandboxBusError('WRONG_EXPERIMENT_PAYLOAD', 'incoming payload belongs to a different experiment/run/node');
  }
  if (payload.round !== validated.sequence) {
    throw new SandboxBusError('ROUND_SEQUENCE_MISMATCH', 'payload.round must equal envelope.sequence');
  }

  if (state.seen_peer_message_ids.includes(validated.message_id)) {
    return { status: 'duplicate', state: structuredClone(state), envelope: validated, payload };
  }

  const expected = state.last_peer_sequence + 1;
  if (validated.sequence !== expected) {
    throw new SandboxBusError('PEER_SEQUENCE_GAP', `expected peer sequence ${expected}, got ${validated.sequence}`);
  }
  if (expected === 1 && validated.previous_message_id !== null) {
    throw new SandboxBusError('PEER_PREDECESSOR_MISMATCH', 'peer sequence 1 must have previous_message_id=null');
  }
  if (expected > 1 && validated.previous_message_id !== state.last_peer_message_id) {
    throw new SandboxBusError('PEER_PREDECESSOR_MISMATCH', 'incoming previous_message_id does not match last accepted peer message');
  }

  const next = structuredClone(state);
  next.last_peer_sequence = validated.sequence;
  next.last_peer_message_id = validated.message_id;
  next.seen_peer_message_ids.push(validated.message_id);
  next.received_count += 1;
  next.cycle_count += 1;
  return { status: 'accepted', state: next, envelope: validated, payload };
}

export function createNextOutgoing(state, health, { now = new Date().toISOString(), messageId = `${state.node}-${randomUUID()}` } = {}) {
  validateExperimentState(state);
  const sequence = state.next_outgoing_sequence;
  const kind = sequence === 1 ? 'hello' : 'heartbeat';
  const payload = {
    experiment: EXPERIMENT_PROTOCOL,
    run_id: state.run_id,
    kind,
    sender: state.node,
    round: sequence,
    sent_at: now,
    reply_to: state.last_peer_message_id,
    observed_peer_sequence: state.last_peer_sequence,
    daemon: {
      started_at: health?.started_at ?? null,
      uptime_ms: health?.uptime_ms ?? null,
      scan_count: health?.scan_count ?? null,
    },
  };
  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const envelope = createEnvelope({
    type: 'message',
    messageId,
    source: state.node,
    target: state.peer,
    sequence,
    previousMessageId: state.previous_outgoing_message_id,
    createdAt: now,
    contentType: 'application/vnd.anet-memory.endurance+json',
    payloadBytes,
  });

  const next = structuredClone(state);
  next.next_outgoing_sequence += 1;
  next.previous_outgoing_message_id = envelope.message_id;
  next.last_outgoing_sequence = envelope.sequence;
  next.last_outgoing_message_id = envelope.message_id;
  next.sent_count += 1;
  return { state: next, envelope, payload };
}

export async function prepareNode(options) {
  const cfg = normalizeOptions(options);
  const dirs = await ensureLayout(cfg);
  let state = await loadState(dirs.stateFile);
  if (!state) {
    state = newExperimentState({ runId: cfg.runId, node: cfg.node, peer: cfg.peer });
    await atomicJson(dirs.stateFile, state);
  } else {
    assertStateMatchesConfig(state, cfg);
  }

  const daemon = await ensureDaemon(cfg, dirs);
  await ensureWatcher(cfg, dirs);

  let outgoing = null;
  if (state.last_outgoing_sequence === 0) {
    const health = await fetchJson(`${cfg.daemonBase}/health`);
    const created = createNextOutgoing(state, health);
    state = created.state;
    outgoing = await persistOutgoing(cfg, dirs, created.envelope);
    await atomicJson(dirs.stateFile, state);
    await logEvent(dirs, { action: 'prepared_hello', sequence: created.envelope.sequence, message_id: created.envelope.message_id });
  }

  return {
    run_id: cfg.runId,
    node: cfg.node,
    peer: cfg.peer,
    daemon,
    watcher_pid: readPid(dirs.watcherPidFile),
    state,
    outgoing,
  };
}

export async function receivePeerFile(options, incomingPath) {
  const cfg = normalizeOptions(options);
  const dirs = await ensureLayout(cfg);
  let state = await requireState(dirs.stateFile);
  assertStateMatchesConfig(state, cfg);

  const envelope = parseEnvelope(await readFile(incomingPath, 'utf8'));
  const accepted = acceptPeerEnvelope(state, envelope);
  if (accepted.status === 'duplicate') {
    await logEvent(dirs, { action: 'peer_duplicate', sequence: envelope.sequence, message_id: envelope.message_id });
    return { status: 'duplicate', state, outgoing: null };
  }

  const ingest = await postJson(`${cfg.daemonBase}/ingest`, envelope);
  if (![200, 201].includes(ingest.status)) {
    throw new Error(`daemon ingest failed: HTTP ${ingest.status} ${JSON.stringify(ingest.body)}`);
  }

  state = accepted.state;
  const health = await fetchJson(`${cfg.daemonBase}/health`);
  const created = createNextOutgoing(state, health);
  state = created.state;
  const outgoing = await persistOutgoing(cfg, dirs, created.envelope);
  await atomicJson(dirs.stateFile, state);
  await logEvent(dirs, {
    action: 'peer_accepted_and_replied',
    incoming_sequence: envelope.sequence,
    incoming_message_id: envelope.message_id,
    outgoing_sequence: created.envelope.sequence,
    outgoing_message_id: created.envelope.message_id,
  });
  return { status: 'accepted', state, ingest: ingest.body, outgoing };
}

export async function nodeStatus(options) {
  const cfg = normalizeOptions(options);
  const dirs = await ensureLayout(cfg);
  const state = await requireState(dirs.stateFile);
  const [health, transport] = await Promise.all([
    fetchJson(`${cfg.daemonBase}/health`),
    fetchJson(`${cfg.daemonBase}/state`),
  ]);
  return { state, health, transport, watcher_pid: readPid(dirs.watcherPidFile), daemon_pid: readPid(dirs.daemonPidFile) };
}

export async function writeCheckpoint(options) {
  const cfg = normalizeOptions(options);
  const dirs = await ensureLayout(cfg);
  const status = await nodeStatus(cfg);
  const checkpointId = `${cfg.node}-${randomUUID()}`;
  const checkpoint = {
    protocol: 'dual-thread-endurance/checkpoint-v1',
    experiment: EXPERIMENT_PROTOCOL,
    run_id: cfg.runId,
    checkpoint_id: checkpointId,
    node: cfg.node,
    peer: cfg.peer,
    created_at: new Date().toISOString(),
    state: status.state,
    daemon: status.health,
  };
  const filename = `${String(status.state.last_peer_sequence).padStart(12, '0')}--${checkpointId}.json`;
  const localPath = path.join(dirs.checkpoints, filename);
  await atomicJson(localPath, checkpoint);
  const destination = `/sandbox-bus/v1/experiments/dual-thread-endurance/${cfg.runId}/checkpoints/${cfg.node}/${filename}`;
  await logEvent(dirs, { action: 'checkpoint_created', local_path: localPath, library_destination: destination });
  return { local_path: localPath, library_destination: destination, checkpoint };
}

export async function watchNode(options) {
  const cfg = normalizeOptions(options);
  const dirs = await ensureLayout(cfg);
  await writeFile(dirs.watcherPidFile, `${process.pid}\n`, 'utf8');
  while (true) {
    const record = { utc: new Date().toISOString(), pid: process.pid };
    try {
      record.health = await fetchJson(`${cfg.daemonBase}/health`);
      const transport = await fetchJson(`${cfg.daemonBase}/state`);
      record.channel = transport.channels?.[`${cfg.node}->${cfg.peer}`] ?? null;
      record.peer_channel = transport.channels?.[`${cfg.peer}->${cfg.node}`] ?? null;
    } catch (error) {
      record.error = { message: error.message, code: error.code ?? null };
    }
    await appendJsonl(dirs.watchLog, record);
    await sleep(cfg.watchMs);
  }
}

async function persistOutgoing(cfg, dirs, envelope) {
  const filename = messageFilename(envelope);
  const localPath = path.join(dirs.outbox, filename);
  await writeFile(localPath, serializeEnvelope(envelope), 'utf8');
  return {
    local_path: localPath,
    filename,
    library_destination: `/sandbox-bus/v1/experiments/dual-thread-endurance/${cfg.runId}/messages/${cfg.node}/${cfg.peer}/${filename}`,
    message_id: envelope.message_id,
    sequence: envelope.sequence,
    payload_sha256: envelope.payload_sha256,
  };
}

async function ensureDaemon(cfg, dirs) {
  try {
    const health = await fetchJson(`${cfg.daemonBase}/health`, 1000);
    return { status: 'already-running', pid: readPid(dirs.daemonPidFile), health };
  } catch {}

  const daemonScript = path.join(REPO_ROOT, 'src', 'anet-memoryd.mjs');
  const outFd = openSync(dirs.daemonStdout, 'a');
  const errFd = openSync(dirs.daemonStderr, 'a');
  const child = spawn(process.execPath, [
    daemonScript,
    '--root', dirs.memorydRoot,
    '--host', '127.0.0.1',
    '--port', String(cfg.port),
    '--scan-ms', '1000',
  ], { detached: true, stdio: ['ignore', outFd, errFd] });
  child.unref();
  await writeFile(dirs.daemonPidFile, `${child.pid}\n`, 'utf8');

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const health = await fetchJson(`${cfg.daemonBase}/health`, 1000);
      return { status: 'started', pid: child.pid, health };
    } catch {
      await sleep(100);
    }
  }
  throw new Error('anet-memoryd did not become healthy within 10 seconds');
}

async function ensureWatcher(cfg, dirs) {
  const existingPid = readPid(dirs.watcherPidFile);
  if (existingPid && isAlive(existingPid)) return existingPid;
  const outFd = openSync(dirs.watcherStdout, 'a');
  const errFd = openSync(dirs.watcherStderr, 'a');
  const child = spawn(process.execPath, [
    fileURLToPath(import.meta.url),
    'watch',
    '--run', cfg.runId,
    '--node', cfg.node,
    '--peer', cfg.peer,
    '--root', cfg.root,
    '--port', String(cfg.port),
    '--watch-ms', String(cfg.watchMs),
  ], { detached: true, stdio: ['ignore', outFd, errFd] });
  child.unref();
  await writeFile(dirs.watcherPidFile, `${child.pid}\n`, 'utf8');
  return child.pid;
}

function normalizeOptions(options) {
  const root = path.resolve(options.root ?? DEFAULT_ROOT);
  const port = Number(options.port ?? DEFAULT_PORT);
  const runId = options.runId ?? options.run;
  const node = options.node;
  const peer = options.peer;
  const watchMs = Number(options.watchMs ?? DEFAULT_WATCH_MS);
  assertId(runId, 'run-id');
  assertId(node, 'node');
  assertId(peer, 'peer');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port');
  if (!Number.isInteger(watchMs) || watchMs < 1000) throw new Error('watch-ms must be >= 1000');
  return { root, port, runId, node, peer, watchMs, daemonBase: `http://127.0.0.1:${port}` };
}

async function ensureLayout(cfg) {
  const base = path.join(cfg.root, cfg.runId, cfg.node);
  const dirs = {
    base,
    outbox: path.join(base, 'outbox'),
    incoming: path.join(base, 'incoming'),
    checkpoints: path.join(base, 'checkpoints'),
    memorydRoot: path.join(base, 'memoryd'),
    stateFile: path.join(base, 'experiment-state.json'),
    orchestratorLog: path.join(base, 'orchestrator.jsonl'),
    watchLog: path.join(base, 'daemon-watch.jsonl'),
    daemonPidFile: path.join(base, 'daemon.pid'),
    watcherPidFile: path.join(base, 'watcher.pid'),
    daemonStdout: path.join(base, 'daemon.stdout.log'),
    daemonStderr: path.join(base, 'daemon.stderr.log'),
    watcherStdout: path.join(base, 'watcher.stdout.log'),
    watcherStderr: path.join(base, 'watcher.stderr.log'),
  };
  await Promise.all([dirs.outbox, dirs.incoming, dirs.checkpoints, dirs.memorydRoot].map((dir) => mkdir(dir, { recursive: true })));
  return dirs;
}

async function loadState(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

async function requireState(file) {
  const state = await loadState(file);
  if (!state) throw new Error('experiment not prepared; run prepare first');
  return state;
}

function validateExperimentState(state) {
  if (!state || state.protocol !== LOCAL_STATE_PROTOCOL || state.experiment !== EXPERIMENT_PROTOCOL) {
    throw new Error('invalid local experiment state');
  }
}

function assertStateMatchesConfig(state, cfg) {
  validateExperimentState(state);
  if (state.run_id !== cfg.runId || state.node !== cfg.node || state.peer !== cfg.peer) {
    throw new Error('existing experiment state does not match requested run/node/peer');
  }
}

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temp, file);
}

async function appendJsonl(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(value)}\n`, 'utf8');
}

async function logEvent(dirs, value) {
  return appendJsonl(dirs.orchestratorLog, { utc: new Date().toISOString(), ...value });
}

async function fetchJson(url, timeoutMs = 2500) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return response.json();
}

async function postJson(url, value) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
    signal: AbortSignal.timeout(5000),
  });
  let body;
  try { body = await response.json(); } catch { body = null; }
  return { status: response.status, body };
}

function readPid(file) {
  try {
    const value = Number(readFileSync(file, 'utf8').trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch { return null; }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function assertId(value, field) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error(`${field} must be path-safe ASCII identifier`);
  }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function parseCli(argv) {
  const [command, ...rest] = argv;
  const options = {};
  let incoming = null;
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    if (key === '--file') { incoming = rest[++i]; continue; }
    if (!key?.startsWith('--')) throw new Error(`unexpected argument: ${key}`);
    const value = rest[++i];
    if (value === undefined) throw new Error(`missing value for ${key}`);
    options[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  return { command, options, incoming };
}

async function main() {
  const { command, options, incoming } = parseCli(process.argv.slice(2));
  let result;
  if (command === 'prepare') result = await prepareNode(options);
  else if (command === 'receive') {
    if (!incoming) throw new Error('receive requires --file <path>');
    result = await receivePeerFile(options, incoming);
  } else if (command === 'status') result = await nodeStatus(options);
  else if (command === 'checkpoint') result = await writeCheckpoint(options);
  else if (command === 'watch') return watchNode(options);
  else throw new Error('usage: node.mjs <prepare|receive|status|checkpoint|watch> --run ID --node ID --peer ID [--root PATH] [--port N] [--watch-ms N] [--file PATH]');
  console.log(JSON.stringify(result, null, 2));
}

if (pathToFileURL(path.resolve(process.argv[1] ?? '')).href === import.meta.url) {
  main().catch((error) => {
    console.error(JSON.stringify({ error: error.code ?? 'ERROR', message: error.message, details: error.details ?? null }, null, 2));
    process.exitCode = 1;
  });
}
