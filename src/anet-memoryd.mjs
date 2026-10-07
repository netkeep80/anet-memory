#!/usr/bin/env node
import { createServer } from 'node:http';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  SandboxBusError,
  channelRelativePath,
  inspectChannel,
  parseEnvelope,
  serializeEnvelope,
  validateEnvelope,
} from './sandbox-bus.mjs';
import { appendMemoryEvent, rebuildMemoryState } from './memory-events.mjs';
import { buildMemoryViews } from './memory-views.mjs';

const STATE_PROTOCOL = 'anet-memoryd/state-v1';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 19170;
const DEFAULT_SCAN_INTERVAL_MS = 1000;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export async function ensureMemoryLayout(root) {
  const absoluteRoot = path.resolve(root);
  await Promise.all([
    mkdir(path.join(absoluteRoot, 'inbox'), { recursive: true }),
    mkdir(path.join(absoluteRoot, 'views'), { recursive: true }),
    mkdir(path.join(absoluteRoot, 'memory'), { recursive: true }),
  ]);
  return absoluteRoot;
}

export async function ingestEnvelope(root, envelope) {
  const absoluteRoot = await ensureMemoryLayout(root);
  validateEnvelope(envelope);

  const relative = channelRelativePath(envelope);
  const destination = path.join(absoluteRoot, 'inbox', relative);
  await mkdir(path.dirname(destination), { recursive: true });

  const serialized = serializeEnvelope(envelope);
  let existingText = null;
  try {
    existingText = await readFile(destination, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  if (existingText !== null) {
    let existing;
    try {
      existing = parseEnvelope(existingText);
    } catch (error) {
      throw new SandboxBusError('MESSAGE_PATH_CONFLICT', 'existing inbox object is invalid', {
        path: destination,
        cause: error.code ?? error.message,
      });
    }

    if (stableJson(existing) === stableJson(envelope)) {
      return {
        status: 'duplicate',
        path: destination,
        message_id: envelope.message_id,
      };
    }

    throw new SandboxBusError('MESSAGE_PATH_CONFLICT', 'message path already contains different immutable content', {
      path: destination,
      message_id: envelope.message_id,
    });
  }

  await atomicWrite(destination, serialized);
  return {
    status: 'ingested',
    path: destination,
    message_id: envelope.message_id,
  };
}

export async function rebuildState(root, { now = () => new Date().toISOString() } = {}) {
  const absoluteRoot = await ensureMemoryLayout(root);
  const inboxRoot = path.join(absoluteRoot, 'inbox');
  const files = await listJsonFiles(inboxRoot);

  const invalid = [];
  const groups = new Map();
  let validMessages = 0;

  for (const file of files) {
    try {
      const envelope = parseEnvelope(await readFile(file, 'utf8'));
      validMessages += 1;
      const key = channelKey(envelope.source, envelope.target);
      const group = groups.get(key) ?? {
        source: envelope.source,
        target: envelope.target,
        messages: [],
      };
      group.messages.push(envelope);
      groups.set(key, group);
    } catch (error) {
      invalid.push({
        path: path.relative(absoluteRoot, file).split(path.sep).join('/'),
        code: error?.code ?? 'READ_OR_PARSE_ERROR',
        message: error?.message ?? String(error),
      });
    }
  }

  const channels = {};
  for (const [key, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const inspection = inspectChannel(group.messages, {
      source: group.source,
      target: group.target,
    });
    channels[key] = summarizeInspection(group, inspection);
  }

  const state = {
    protocol: STATE_PROTOCOL,
    generated_at: now(),
    root: absoluteRoot,
    journal: {
      files: files.length,
      valid_messages: validMessages,
      invalid_messages: invalid.length,
      invalid,
    },
    channels,
  };

  await atomicWrite(
    path.join(absoluteRoot, 'views', 'state.json'),
    `${JSON.stringify(state, null, 2)}\n`,
  );

  return state;
}

export async function startMemoryDaemon({
  root = process.env.ANET_MEMORYD_ROOT ?? '.anet-memoryd',
  host = process.env.ANET_MEMORYD_HOST ?? DEFAULT_HOST,
  port = Number(process.env.ANET_MEMORYD_PORT ?? DEFAULT_PORT),
  scanIntervalMs = Number(process.env.ANET_MEMORYD_SCAN_MS ?? DEFAULT_SCAN_INTERVAL_MS),
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
} = {}) {
  const absoluteRoot = await ensureMemoryLayout(root);
  const startedAt = new Date().toISOString();

  const runtime = {
    started_at: startedAt,
    scan_count: 0,
    last_scan_at: null,
    last_scan_error: null,
    state: null,
    memory_state: null,
    memory_view: null,
  };

  let activeScan = null;
  const scanOnce = async () => {
    if (activeScan) return activeScan;
    activeScan = (async () => {
      try {
        const state = await rebuildState(absoluteRoot);
        const memoryRoot = path.join(absoluteRoot, 'memory');
        const memoryState = await rebuildMemoryState(memoryRoot);
        const memoryView = buildMemoryViews(memoryState);
        await atomicWrite(
          path.join(memoryRoot, 'views', 'memory-current.json'),
          `${JSON.stringify(memoryView, null, 2)}\n`,
        );

        runtime.scan_count += 1;
        runtime.last_scan_at = state.generated_at;
        runtime.last_scan_error = null;
        runtime.state = state;
        runtime.memory_state = memoryState;
        runtime.memory_view = memoryView;
        return {
          transport: state,
          memory_state: memoryState,
          memory_view: memoryView,
        };
      } catch (error) {
        runtime.last_scan_error = {
          code: error?.code ?? 'SCAN_ERROR',
          message: error?.message ?? String(error),
        };
        throw error;
      } finally {
        activeScan = null;
      }
    })();
    return activeScan;
  };

  await scanOnce();

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');

      if (request.method === 'GET' && url.pathname === '/health') {
        return sendJson(response, 200, {
          status: 'ok',
          protocol: STATE_PROTOCOL,
          root: absoluteRoot,
          started_at: runtime.started_at,
          uptime_ms: Date.now() - Date.parse(runtime.started_at),
          scan_count: runtime.scan_count,
          last_scan_at: runtime.last_scan_at,
          last_scan_error: runtime.last_scan_error,
          memory_journal_source_sha256: runtime.memory_state?.journal?.source_sha256 ?? null,
        });
      }

      if (request.method === 'GET' && url.pathname === '/state') {
        if (!runtime.state) await scanOnce();
        return sendJson(response, 200, runtime.state);
      }

      if (request.method === 'GET' && url.pathname === '/memory/state') {
        if (!runtime.memory_state) await scanOnce();
        return sendJson(response, 200, runtime.memory_state);
      }

      if (request.method === 'GET' && url.pathname === '/memory/current') {
        if (!runtime.memory_view) await scanOnce();
        return sendJson(response, 200, runtime.memory_view);
      }

      if (request.method === 'POST' && url.pathname === '/scan') {
        return sendJson(response, 200, await scanOnce());
      }

      if (request.method === 'POST' && url.pathname === '/ingest') {
        const envelope = await readJsonBody(request, maxBodyBytes);
        const result = await ingestEnvelope(absoluteRoot, envelope);
        await scanOnce();
        return sendJson(response, result.status === 'ingested' ? 201 : 200, {
          ...result,
          state: runtime.state,
        });
      }

      if (request.method === 'POST' && url.pathname === '/memory/event') {
        const event = await readJsonBody(request, maxBodyBytes);
        const result = await appendMemoryEvent(path.join(absoluteRoot, 'memory'), event);
        await scanOnce();
        return sendJson(response, result.status === 'appended' ? 201 : 200, {
          ...result,
          memory_state: runtime.memory_state,
          current_view: runtime.memory_view,
        });
      }

      return sendJson(response, 404, { error: 'NOT_FOUND' });
    } catch (error) {
      const conflict = error instanceof SandboxBusError &&
        ['MESSAGE_PATH_CONFLICT', 'MESSAGE_ID_CONFLICT', 'CHANNEL_FORK'].includes(error.code);
      return sendJson(response, conflict ? 409 : 400, {
        error: error?.code ?? 'REQUEST_ERROR',
        message: error?.message ?? String(error),
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const timer = setInterval(() => {
    scanOnce().catch(() => {});
  }, scanIntervalMs);
  timer.unref();

  const address = server.address();
  return {
    root: absoluteRoot,
    host,
    port: typeof address === 'object' && address ? address.port : port,
    scanOnce,
    getState: () => runtime.state,
    getMemoryState: () => runtime.memory_state,
    getMemoryView: () => runtime.memory_view,
    getRuntime: () => ({ ...runtime }),
    close: async () => {
      clearInterval(timer);
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

function summarizeInspection(group, inspection) {
  return {
    source: group.source,
    target: group.target,
    state: inspection.state,
    reason: inspection.reason ?? null,
    visible_messages: group.messages.length,
    accepted_count: inspection.accepted?.length ?? 0,
    accepted_message_ids: inspection.accepted?.map((message) => message.message_id) ?? [],
    duplicate_count: inspection.duplicate_count ?? 0,
    last_accepted_message_id: inspection.last_accepted?.message_id ?? null,
    next_sequence: inspection.next_sequence ?? null,
    previous_message_id: inspection.previous_message_id ?? null,
    expected_sequence: inspection.expected_sequence ?? null,
    visible_sequence: inspection.visible_sequence ?? null,
  };
}

async function listJsonFiles(root) {
  const output = [];

  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }

    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        output.push(absolute);
      }
    }
  }

  await walk(root);
  output.sort();
  return output;
}

async function atomicWrite(destination, content) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, content);
  await rename(temporary, destination);
}

async function readJsonBody(request, maxBytes) {
  const chunks = [];
  let total = 0;

  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new SandboxBusError('BODY_TOO_LARGE', `request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    throw new SandboxBusError('INVALID_JSON', 'request body is not valid JSON', {
      cause: error.message,
    });
  }
}

function sendJson(response, statusCode, value) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function channelKey(source, target) {
  return `${source}->${target}`;
}

function stableJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;

  const output = {};
  for (const key of Object.keys(value).sort()) {
    output[key] = sortJson(value[key]);
  }
  return output;
}

function parseCliArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error('usage: anet-memoryd [--root path] [--host 127.0.0.1] [--port 19170] [--scan-ms 1000]');
    }
    index += 1;
    if (key === '--root') options.root = value;
    else if (key === '--host') options.host = value;
    else if (key === '--port') options.port = Number(value);
    else if (key === '--scan-ms') options.scanIntervalMs = Number(value);
    else throw new Error(`unknown option: ${key}`);
  }
  return options;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
  const options = parseCliArgs(process.argv.slice(2));
  const daemon = await startMemoryDaemon(options);
  console.log(JSON.stringify({
    status: 'started',
    host: daemon.host,
    port: daemon.port,
    root: daemon.root,
  }));

  const shutdown = async () => {
    await daemon.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
