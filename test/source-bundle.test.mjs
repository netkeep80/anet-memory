import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  SourceBundleError,
  createSourceBundle,
  renderSelfExtractingSourceBundle,
  sha256Hex,
} from '../src/source-bundle.mjs';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const builder = path.resolve('experiments/source-bundle/source-bundle.mjs');

async function tempRoot(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

function runNode(script, args = [], { cwd = path.resolve('.') } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function fixtureFiles() {
  return [
    {
      path: 'lib/value.mjs',
      bytes: "export const value = 'SOURCE_BUNDLE_OK';\n",
    },
    {
      path: 'bin/main.mjs',
      bytes: "import { value } from '../lib/value.mjs';\nprocess.stdout.write(value + '\\n');\n",
    },
  ];
}

test('self-extracting source bundle verifies, unpacks exact bytes, and runs literal entrypoint', async (t) => {
  const root = await tempRoot('anet-source-bundle-');
  t.after(() => rm(root, { recursive: true, force: true }));

  const bundle = createSourceBundle({
    repository: 'netkeep80/anet-memory',
    commitSha: COMMIT,
    profile: 'fixture',
    createdAt: '2026-10-08T00:00:00.000Z',
    nodeEngine: '>=20',
    entrypoints: ['bin/main.mjs'],
    files: fixtureFiles(),
  });

  const first = renderSelfExtractingSourceBundle(bundle);
  const second = renderSelfExtractingSourceBundle(structuredClone(bundle));
  assert.equal(first, second);

  const bundlePath = path.join(root, 'source-bundle.mjs');
  await writeFile(bundlePath, first, 'utf8');
  const expectedOuterSha = sha256Hex(await readFile(bundlePath));

  const verified = await runNode(bundlePath, [
    'verify',
    '--repository', 'netkeep80/anet-memory',
    '--commit', COMMIT,
    '--profile', 'fixture',
  ]);
  assert.equal(verified.code, 0, verified.stderr);
  const verifyResult = JSON.parse(verified.stdout);
  assert.equal(verifyResult.protocol, 'anet-memory/source-bundle/1');
  assert.equal(verifyResult.commit_sha, COMMIT);
  assert.equal(verifyResult.file_count, 2);
  assert.equal(verifyResult.self_sha256, expectedOuterSha);
  assert.deepEqual(
    verifyResult.files.map((file) => file.path),
    ['bin/main.mjs', 'lib/value.mjs'],
  );
  assert.ok(verifyResult.files.every((file) => /^[a-f0-9]{40}$/.test(file.git_blob_sha1)));

  const unpacked = path.join(root, 'checkout');
  const unpack = await runNode(bundlePath, [
    'unpack',
    '--out', unpacked,
    '--repository', 'netkeep80/anet-memory',
    '--commit', COMMIT,
    '--profile', 'fixture',
  ]);
  assert.equal(unpack.code, 0, unpack.stderr);

  for (const file of fixtureFiles()) {
    const exact = await readFile(path.join(unpacked, ...file.path.split('/')));
    assert.deepEqual(exact, Buffer.from(file.bytes, 'utf8'));
  }

  const execution = await runNode(path.join(unpacked, 'bin', 'main.mjs'));
  assert.equal(execution.code, 0, execution.stderr);
  assert.equal(execution.stdout, 'SOURCE_BUNDLE_OK\n');
});

test('embedded-byte tamper fails closed before output checkout exists', async (t) => {
  const root = await tempRoot('anet-source-bundle-tamper-');
  t.after(() => rm(root, { recursive: true, force: true }));

  const bundle = createSourceBundle({
    repository: 'netkeep80/anet-memory',
    commitSha: COMMIT,
    profile: 'fixture',
    createdAt: '2026-10-08T00:00:00.000Z',
    entrypoints: ['bin/main.mjs'],
    files: fixtureFiles(),
  });

  const valid = renderSelfExtractingSourceBundle(bundle);
  const target = bundle.files[0].content_base64;
  const replacement = (target[0] === 'A' ? 'B' : 'A') + target.slice(1);
  const tampered = valid.replace(target, replacement);
  assert.notEqual(tampered, valid);

  const bundlePath = path.join(root, 'tampered.mjs');
  await writeFile(bundlePath, tampered, 'utf8');

  const output = path.join(root, 'must-not-exist');
  const result = await runNode(bundlePath, [
    'unpack',
    '--out', output,
    '--repository', 'netkeep80/anet-memory',
    '--commit', COMMIT,
    '--profile', 'fixture',
  ]);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /SHA256_MISMATCH|GIT_BLOB_MISMATCH/);
  await assert.rejects(() => access(output));
});

test('wrong commit and pre-existing output are rejected before source materialization', async (t) => {
  const root = await tempRoot('anet-source-bundle-guard-');
  t.after(() => rm(root, { recursive: true, force: true }));

  const bundle = createSourceBundle({
    repository: 'netkeep80/anet-memory',
    commitSha: COMMIT,
    profile: 'fixture',
    createdAt: '2026-10-08T00:00:00.000Z',
    entrypoints: ['bin/main.mjs'],
    files: fixtureFiles(),
  });
  const bundlePath = path.join(root, 'source-bundle.mjs');
  await writeFile(bundlePath, renderSelfExtractingSourceBundle(bundle), 'utf8');

  const wrongCommitOutput = path.join(root, 'wrong-commit');
  const wrongCommit = await runNode(bundlePath, [
    'unpack',
    '--out', wrongCommitOutput,
    '--repository', 'netkeep80/anet-memory',
    '--commit', 'ffffffffffffffffffffffffffffffffffffffff',
    '--profile', 'fixture',
  ]);
  assert.notEqual(wrongCommit.code, 0);
  assert.match(wrongCommit.stderr, /COMMIT_MISMATCH/);
  await assert.rejects(() => access(wrongCommitOutput));

  const existing = path.join(root, 'existing');
  await mkdir(existing);
  const existingResult = await runNode(bundlePath, [
    'unpack',
    '--out', existing,
    '--repository', 'netkeep80/anet-memory',
    '--commit', COMMIT,
    '--profile', 'fixture',
  ]);
  assert.notEqual(existingResult.code, 0);
  assert.match(existingResult.stderr, /OUTPUT_EXISTS/);
});

test('bundle creation rejects path traversal and entrypoints outside the bundle', () => {
  assert.throws(
    () => createSourceBundle({
      repository: 'netkeep80/anet-memory',
      commitSha: COMMIT,
      profile: 'fixture',
      entrypoints: ['../escape.mjs'],
      files: [{ path: '../escape.mjs', bytes: 'bad' }],
    }),
    (error) => error instanceof SourceBundleError && error.code === 'INVALID_PATH',
  );

  assert.throws(
    () => createSourceBundle({
      repository: 'netkeep80/anet-memory',
      commitSha: COMMIT,
      profile: 'fixture',
      entrypoints: ['bin/missing.mjs'],
      files: fixtureFiles(),
    }),
    (error) => error instanceof SourceBundleError && error.code === 'ENTRYPOINT_NOT_BUNDLED',
  );
});

test('repository build CLI creates one executable materializable source bundle', async (t) => {
  const root = await tempRoot('anet-source-bundle-cli-');
  t.after(() => rm(root, { recursive: true, force: true }));

  const checkout = path.join(root, 'checkout');
  await mkdir(path.join(checkout, 'bin'), { recursive: true });
  await mkdir(path.join(checkout, 'lib'), { recursive: true });

  for (const file of fixtureFiles()) {
    const destination = path.join(checkout, ...file.path.split('/'));
    await writeFile(destination, file.bytes, 'utf8');
  }

  const output = path.join(root, 'built-bundle.mjs');
  const built = await runNode(builder, [
    'build',
    '--root', checkout,
    '--out', output,
    '--repository', 'netkeep80/anet-memory',
    '--commit', COMMIT,
    '--profile', 'fixture',
    '--created-at', '2026-10-08T00:00:00.000Z',
    '--entrypoint', 'bin/main.mjs',
    '--file', 'bin/main.mjs',
    '--file', 'lib/value.mjs',
  ]);
  assert.equal(built.code, 0, built.stderr);

  const buildResult = JSON.parse(built.stdout);
  assert.equal(buildResult.file_count, 2);
  assert.equal(buildResult.bundle_sha256, sha256Hex(await readFile(output)));

  const verify = await runNode(output, [
    'verify',
    '--repository', 'netkeep80/anet-memory',
    '--commit', COMMIT,
    '--profile', 'fixture',
  ]);
  assert.equal(verify.code, 0, verify.stderr);
});
