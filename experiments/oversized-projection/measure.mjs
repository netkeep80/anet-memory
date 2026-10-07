#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  MEMORY_LIBRARY_ROOT,
  parseMemoryLibraryManifest,
  verifyMemoryLibraryObject,
} from '../../src/memory-library.mjs';

export const OVERSIZED_PROJECTION_META_PROTOCOL =
  'anet-memory/oversized-projection-benchmark-meta/1';

async function main(argv) {
  const args = parseArgs(argv);
  const bundleRoot = path.resolve(required(args, 'bundle-root'));
  const manifestPath = path.resolve(required(args, 'manifest'));
  const preparePath = path.resolve(required(args, 'prepare-result'));
  const outputPath = path.resolve(required(args, 'out'));
  const maxBytes = integerArg(args, 'projection-max-bytes', 8000, 1);
  const minRatio = integerArg(args, 'min-ratio', 10, 1);

  const manifest = parseMemoryLibraryManifest(await readFile(manifestPath, 'utf8'));
  const prepared = JSON.parse(await readFile(preparePath, 'utf8'));

  if (prepared.protocol !== 'anet-memory/oversized-projection-fixture/1') {
    throw new Error('unexpected prepare-result protocol');
  }
  if (prepared.run_id !== manifest.manifest_id) {
    throw new Error('prepare-result run_id does not match manifest_id');
  }
  if (prepared.project !== manifest.project) {
    throw new Error('prepare-result project does not match manifest project');
  }

  let corpusBytes = 0;
  let artifactCount = 0;
  let eventCount = 0;
  const objectSizes = [];

  for (const descriptor of manifest.objects) {
    const localPath = localBundlePath(bundleRoot, descriptor.path);
    const bytes = await readFile(localPath);
    verifyMemoryLibraryObject(descriptor, bytes);
    const info = await stat(localPath);
    corpusBytes += info.size;
    if (descriptor.kind === 'artifact') artifactCount += 1;
    if (descriptor.kind === 'event') eventCount += 1;
    objectSizes.push({
      kind: descriptor.kind,
      logical_id: descriptor.logical_id,
      path: descriptor.path,
      size_bytes: info.size,
      sha256: descriptor.sha256,
    });
  }

  if (corpusBytes < maxBytes * minRatio) {
    throw new Error(
      'corpus is too small: ' + corpusBytes +
      ' bytes < ' + (maxBytes * minRatio) +
      ' required bytes',
    );
  }

  const manifestBytes = await readFile(manifestPath);

  const result = {
    protocol: OVERSIZED_PROJECTION_META_PROTOCOL,
    run_id: manifest.manifest_id,
    project: manifest.project,
    root_artifact_ids: manifest.root_artifact_ids,
    object_count: manifest.objects.length,
    artifact_count: artifactCount,
    event_count: eventCount,
    corpus_bytes: corpusBytes,
    manifest_sha256: sha256(manifestBytes),
    answer_commitment_sha256: prepared.answer_commitment_sha256,
    answer_canonical_schema: prepared.answer_canonical_schema,
    query: {
      relation_types: ['depends_on', 'evidence'],
      shallow: {
        max_depth: 0,
        max_nodes: 8,
        max_bytes: maxBytes,
      },
      expanded: {
        max_depth: 2,
        max_nodes: 8,
        max_bytes: maxBytes,
      },
    },
    minimum_corpus_to_projection_ratio: minRatio,
    corpus_to_projection_budget_ratio: corpusBytes / maxBytes,
    objects: objectSizes,
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n', {
    flag: 'wx',
  });

  process.stdout.write(JSON.stringify({
    protocol: result.protocol,
    run_id: result.run_id,
    object_count: result.object_count,
    corpus_bytes: result.corpus_bytes,
    projection_max_bytes: maxBytes,
    minimum_ratio: minRatio,
    corpus_to_projection_budget_ratio: result.corpus_to_projection_budget_ratio,
    manifest_sha256: result.manifest_sha256,
    answer_commitment_sha256: result.answer_commitment_sha256,
    out: outputPath,
  }, null, 2) + '\n');
}

function localBundlePath(root, libraryPath) {
  const prefix = MEMORY_LIBRARY_ROOT + '/';
  if (!libraryPath.startsWith(prefix)) {
    throw new Error('Library path is outside ' + MEMORY_LIBRARY_ROOT + ': ' + libraryPath);
  }
  const relative = libraryPath.slice(prefix.length);
  return path.join(root, ...relative.split('/'));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function integerArg(args, key, defaultValue, minimum) {
  const value = args[key];
  if (value === undefined) return defaultValue;
  if (Array.isArray(value)) throw new Error('--' + key + ' may be supplied only once');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error('--' + key + ' must be an integer >= ' + minimum);
  }
  return parsed;
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
    if (output[key] !== undefined) {
      throw new Error('--' + key + ' may be supplied only once');
    }
    output[key] = value;
    index += 1;
  }
  return output;
}

function required(args, key) {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('missing required --' + key);
  }
  return value;
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

export { main as measureOversizedProjectionBenchmark };
