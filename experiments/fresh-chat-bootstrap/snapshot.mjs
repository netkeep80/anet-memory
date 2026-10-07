#!/usr/bin/env node
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  MEMORY_LIBRARY_ROOT,
  createMemoryLibraryManifest,
  describeMemoryLibraryObject,
  importMemoryLibrarySnapshot,
  parseMemoryLibraryManifest,
  serializeMemoryLibraryManifest,
} from '../../src/memory-library.mjs';
import {
  buildMemoryGraph,
  parseMemoryArtifact,
  rebuildArtifactCatalog,
} from '../../src/memory-artifacts.mjs';
import { parseMemoryEvent, rebuildMemoryState } from '../../src/memory-events.mjs';
import { bootstrapMemoryGraph } from '../../src/memory-bootstrap.mjs';
import { projectMemoryGraph } from '../../src/memory-projection.mjs';

const RUN_PROTOCOL = 'anet-memory/fresh-chat-bootstrap-run/1';

async function main(argv) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);

  if (command === 'export') return exportSnapshot(args);
  if (command === 'import') return importSnapshot(args);
  if (command === 'bootstrap') return bootstrapSnapshot(args);
  if (command === 'project') return projectSnapshot(args);

  throw new Error(usage());
}

async function exportSnapshot(args) {
  const memoryRoot = required(args, 'memory-root');
  const outputRoot = required(args, 'out');
  const manifestId = required(args, 'manifest-id');
  const project = required(args, 'project');
  const rootArtifactIds = many(args, 'root-artifact');
  if (rootArtifactIds.length === 0) {
    throw new Error('export requires at least one --root-artifact');
  }

  const descriptors = [];
  const localObjects = [];

  const artifactFiles = await listJsonFiles(path.join(memoryRoot, 'artifacts'));
  const eventFiles = await listJsonFiles(path.join(memoryRoot, 'events'));
  if (artifactFiles.length === 0) throw new Error('memory root contains no semantic artifacts');
  if (eventFiles.length === 0) throw new Error('memory root contains no lifecycle events');

  for (const file of artifactFiles) {
    const bytes = await readFile(file);
    const artifact = parseMemoryArtifact(bytes.toString('utf8'));
    if (artifact.project !== project) {
      throw new Error(
        'artifact project mismatch for ' + artifact.artifact_id +
        ': expected ' + project + ', got ' + artifact.project,
      );
    }
    const descriptor = describeMemoryLibraryObject('artifact', bytes);
    descriptors.push(descriptor);
    localObjects.push({ descriptor, bytes });
  }

  for (const file of eventFiles) {
    const bytes = await readFile(file);
    parseMemoryEvent(bytes.toString('utf8'));
    const descriptor = describeMemoryLibraryObject('event', bytes);
    descriptors.push(descriptor);
    localObjects.push({ descriptor, bytes });
  }

  const manifest = createMemoryLibraryManifest({
    manifestId,
    project,
    createdAt: args['created-at'] ?? new Date().toISOString(),
    rootArtifactIds,
    objects: descriptors,
    provenance: many(args, 'provenance'),
  });

  const uploadPlan = [];
  for (const { descriptor, bytes } of localObjects.sort((a, b) =>
    a.descriptor.path.localeCompare(b.descriptor.path)
  )) {
    const destination = localBundlePath(outputRoot, descriptor.path);
    await writeNewFile(destination, bytes);
    uploadPlan.push({
      kind: descriptor.kind,
      logical_id: descriptor.logical_id,
      local_path: destination,
      library_path: descriptor.path,
      sha256: descriptor.sha256,
    });
  }

  // Manifest is written and published LAST: its visibility means the snapshot is expected to be complete.
  const manifestPath = localBundlePath(
    outputRoot,
    MEMORY_LIBRARY_ROOT + '/manifests/' + manifest.manifest_id + '.json',
  );
  await writeNewFile(manifestPath, serializeMemoryLibraryManifest(manifest));

  const result = {
    protocol: RUN_PROTOCOL,
    command: 'export',
    manifest_id: manifest.manifest_id,
    project: manifest.project,
    root_artifact_ids: manifest.root_artifact_ids,
    output_root: path.resolve(outputRoot),
    objects: uploadPlan,
    publish_last: {
      kind: 'manifest',
      local_path: manifestPath,
      library_path: MEMORY_LIBRARY_ROOT + '/manifests/' + manifest.manifest_id + '.json',
    },
  };
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

async function importSnapshot(args) {
  const memoryRoot = required(args, 'memory-root');
  const bundleRoot = required(args, 'bundle-root');
  const manifestPath = required(args, 'manifest');

  const manifest = parseMemoryLibraryManifest(await readFile(manifestPath, 'utf8'));
  const objects = new Map();

  for (const descriptor of manifest.objects) {
    const file = localBundlePath(bundleRoot, descriptor.path);
    objects.set(descriptor.path, await readFile(file));
  }

  const imported = await importMemoryLibrarySnapshot(memoryRoot, manifest, objects);
  process.stdout.write(JSON.stringify({
    protocol: RUN_PROTOCOL,
    command: 'import',
    manifest_id: imported.manifest_id,
    project: imported.project,
    root_artifact_ids: imported.root_artifact_ids,
    imported: imported.imported,
    source: imported.memory_graph.source,
    missing_semantic_records: imported.memory_graph.missing_semantic_records,
    dangling_relations: imported.memory_graph.dangling_relations,
  }, null, 2) + '\n');
}

async function bootstrapSnapshot(args) {
  const memoryRoot = required(args, 'memory-root');
  const project = required(args, 'project');
  const task = required(args, 'task');
  const seedIds = many(args, 'root-artifact');
  const maxNodes = integerArg(args, 'max-nodes', 12);
  const maxBytes = integerArg(args, 'max-bytes', 12000);
  const maxDepth = integerArg(args, 'max-depth', 3);

  const memoryState = await rebuildMemoryState(memoryRoot);
  const artifactCatalog = await rebuildArtifactCatalog(memoryRoot);
  const graph = buildMemoryGraph(memoryState, artifactCatalog);
  const bootstrap = bootstrapMemoryGraph(
    graph,
    {
      project,
      task,
      seed_ids: seedIds,
    },
    {
      max_nodes: maxNodes,
      max_bytes: maxBytes,
    },
    {
      max_depth: maxDepth,
    },
  );

  process.stdout.write(JSON.stringify({
    protocol: RUN_PROTOCOL,
    command: 'bootstrap',
    bootstrap,
  }, null, 2) + '\n');
}

async function projectSnapshot(args) {
  const memoryRoot = required(args, 'memory-root');
  const project = required(args, 'project');
  const seedIds = many(args, 'seed-artifact');
  const terms = many(args, 'term');
  if (seedIds.length === 0 && terms.length === 0) {
    throw new Error('project requires at least one --seed-artifact or --term');
  }

  const maxNodes = integerArg(args, 'max-nodes', 12);
  const maxBytes = integerArg(args, 'max-bytes', 12000);
  const maxDepth = integerArg(args, 'max-depth', 3);
  const includeHistorical = booleanArg(args, 'include-historical', false);
  const includeProposed = booleanArg(args, 'include-proposed', false);
  const followSupersession = booleanArg(args, 'follow-supersession', true);
  const relationTypes = many(args, 'relation-type');

  const memoryState = await rebuildMemoryState(memoryRoot);
  const artifactCatalog = await rebuildArtifactCatalog(memoryRoot);
  const graph = buildMemoryGraph(memoryState, artifactCatalog);
  const projection = projectMemoryGraph(
    graph,
    {
      project,
      seed_ids: seedIds,
      terms,
    },
    {
      max_nodes: maxNodes,
      max_bytes: maxBytes,
    },
    {
      max_depth: maxDepth,
      include_historical: includeHistorical,
      include_proposed: includeProposed,
      follow_supersession: followSupersession,
      ...(relationTypes.length > 0 ? { relation_types: relationTypes } : {}),
    },
  );

  process.stdout.write(JSON.stringify({
    protocol: RUN_PROTOCOL,
    command: 'project',
    projection,
  }, null, 2) + '\n');
}

async function listJsonFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

function localBundlePath(root, libraryPath) {
  const prefix = MEMORY_LIBRARY_ROOT + '/';
  if (!libraryPath.startsWith(prefix)) {
    throw new Error('Library path is outside ' + MEMORY_LIBRARY_ROOT + ': ' + libraryPath);
  }
  const relative = libraryPath.slice(prefix.length);
  return path.join(path.resolve(root), ...relative.split('/'));
}

async function writeNewFile(destination, bytes) {
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { flag: 'wx' });
}

function parseArgs(tokens) {
  const output = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) throw new Error('unexpected argument: ' + token);
    const key = token.slice(2);
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error('missing value for --' + key);
    }
    index += 1;
    if (output[key] === undefined) output[key] = value;
    else if (Array.isArray(output[key])) output[key].push(value);
    else output[key] = [output[key], value];
  }
  return output;
}

function required(args, key) {
  const value = args[key];
  if (Array.isArray(value)) throw new Error('--' + key + ' may be supplied only once');
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('missing required --' + key);
  }
  return value;
}

function many(args, key) {
  const value = args[key];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function integerArg(args, key, defaultValue) {
  const value = args[key];
  if (value === undefined) return defaultValue;
  if (Array.isArray(value)) throw new Error('--' + key + ' may be supplied only once');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('--' + key + ' must be a non-negative safe integer');
  }
  return parsed;
}

function booleanArg(args, key, defaultValue) {
  const value = args[key];
  if (value === undefined) return defaultValue;
  if (Array.isArray(value)) throw new Error('--' + key + ' may be supplied only once');
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('--' + key + ' must be true or false');
}

function usage() {
  return [
    'usage:',
    '  node experiments/fresh-chat-bootstrap/snapshot.mjs export',
    '    --memory-root PATH --out PATH --manifest-id ID --project PROJECT',
    '    --root-artifact ID [--root-artifact ID...] [--provenance REF...]',
    '',
    '  node experiments/fresh-chat-bootstrap/snapshot.mjs import',
    '    --memory-root PATH --bundle-root PATH --manifest PATH',
    '',
    '  node experiments/fresh-chat-bootstrap/snapshot.mjs bootstrap',
    '    --memory-root PATH --project PROJECT --task TEXT',
    '    [--root-artifact ID...] [--max-nodes N] [--max-bytes N] [--max-depth N]',
    '',
    '  node experiments/fresh-chat-bootstrap/snapshot.mjs project',
    '    --memory-root PATH --project PROJECT',
    '    [--seed-artifact ID...] [--term TEXT...]',
    '    [--relation-type TYPE...] [--include-historical true|false]',
    '    [--include-proposed true|false] [--follow-supersession true|false]',
    '    [--max-nodes N] [--max-bytes N] [--max-depth N]',
  ].join('\n');
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write((error?.stack ?? String(error)) + '\n');
    process.exitCode = 1;
  }
}

export { main as runFreshChatBootstrapHarness };
