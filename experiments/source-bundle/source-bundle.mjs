#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  createSourceBundle,
  renderSelfExtractingSourceBundle,
  sha256Hex,
  validateSourcePath,
} from '../../src/source-bundle.mjs';

async function main(argv) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);

  if (command !== 'build') {
    throw new Error(usage());
  }

  const root = path.resolve(required(args, 'root'));
  const output = path.resolve(required(args, 'out'));
  const repository = required(args, 'repository');
  const commitSha = required(args, 'commit');
  const profile = required(args, 'profile');
  const createdAt = args['created-at'] ?? new Date().toISOString();
  const nodeEngine = args['node-engine'] ?? '>=20';
  const entrypoints = many(args, 'entrypoint');
  const sourcePaths = many(args, 'file');

  if (entrypoints.length === 0) {
    throw new Error('build requires at least one --entrypoint');
  }
  if (sourcePaths.length === 0) {
    throw new Error('build requires at least one --file');
  }

  const files = [];
  for (const sourcePath of sourcePaths) {
    validateSourcePath(sourcePath);
    const absolute = path.resolve(root, ...sourcePath.split('/'));
    if (absolute !== root && !absolute.startsWith(root + path.sep)) {
      throw new Error('source path escapes root: ' + sourcePath);
    }
    files.push({
      path: sourcePath,
      bytes: await readFile(absolute),
    });
  }

  const bundle = createSourceBundle({
    repository,
    commitSha,
    profile,
    createdAt,
    nodeEngine,
    entrypoints,
    files,
  });

  const script = renderSelfExtractingSourceBundle(bundle);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, script, { flag: 'wx', mode: 0o755 });

  const bytes = Buffer.from(script, 'utf8');
  process.stdout.write(JSON.stringify({
    protocol: 'anet-memory/source-bundle-build/1',
    repository: bundle.repository,
    commit_sha: bundle.commit_sha,
    profile: bundle.profile,
    created_at: bundle.created_at,
    node_engine: bundle.node_engine,
    output,
    entrypoints: bundle.entrypoints,
    file_count: bundle.files.length,
    total_source_bytes: bundle.files.reduce((sum, file) => sum + file.size_bytes, 0),
    bundle_size_bytes: bytes.length,
    bundle_sha256: sha256Hex(bytes),
    files: bundle.files.map((file) => ({
      path: file.path,
      size_bytes: file.size_bytes,
      sha256: file.sha256,
      git_blob_sha1: file.git_blob_sha1,
    })),
  }, null, 2) + '\n');
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

function usage() {
  return [
    'usage:',
    '  node experiments/source-bundle/source-bundle.mjs build',
    '    --root CHECKOUT --out BUNDLE.mjs',
    '    --repository owner/name --commit SHA --profile NAME',
    '    --entrypoint PATH [--entrypoint PATH...]',
    '    --file PATH [--file PATH...]',
    '    [--created-at ISO] [--node-engine RANGE]',
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

export { main as runSourceBundleCli };
