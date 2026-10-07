import { createHash } from 'node:crypto';

export const SOURCE_BUNDLE_PROTOCOL = 'anet-memory/source-bundle/1';

const BUNDLE_KEYS = new Set([
  'protocol',
  'repository',
  'commit_sha',
  'profile',
  'created_at',
  'node_engine',
  'entrypoints',
  'files',
]);

const FILE_KEYS = new Set([
  'path',
  'size_bytes',
  'sha256',
  'git_blob_sha1',
  'content_base64',
]);

const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const SHA1_RE = /^[a-f0-9]{40}$/;

export class SourceBundleError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SourceBundleError';
    this.code = code;
    this.details = details;
  }
}

export function createSourceBundle({
  repository,
  commitSha,
  profile,
  createdAt = new Date().toISOString(),
  nodeEngine = '>=20',
  entrypoints = [],
  files = [],
} = {}) {
  const descriptors = files.map((file) => {
    validateSourcePath(file.path);
    const bytes = toBuffer(file.bytes);
    return {
      path: file.path,
      size_bytes: bytes.length,
      sha256: sha256Hex(bytes),
      git_blob_sha1: gitBlobSha1(bytes),
      content_base64: bytes.toString('base64'),
    };
  });

  const bundle = {
    protocol: SOURCE_BUNDLE_PROTOCOL,
    repository,
    commit_sha: commitSha,
    profile,
    created_at: createdAt,
    node_engine: nodeEngine,
    entrypoints: [...entrypoints],
    files: descriptors,
  };

  validateSourceBundle(bundle);
  bundle.entrypoints = [...new Set(bundle.entrypoints)].sort();
  bundle.files.sort((a, b) => a.path.localeCompare(b.path));
  return bundle;
}

export function validateSourceBundle(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new SourceBundleError('INVALID_BUNDLE', 'source bundle must be an object');
  }

  assertExactKeys(bundle, BUNDLE_KEYS, 'bundle');

  if (bundle.protocol !== SOURCE_BUNDLE_PROTOCOL) {
    throw new SourceBundleError(
      'UNSUPPORTED_PROTOCOL',
      'expected ' + SOURCE_BUNDLE_PROTOCOL,
    );
  }
  if (typeof bundle.repository !== 'string' || !REPOSITORY_RE.test(bundle.repository)) {
    throw new SourceBundleError(
      'INVALID_REPOSITORY',
      'repository must be owner/name',
    );
  }
  if (typeof bundle.commit_sha !== 'string' || !COMMIT_RE.test(bundle.commit_sha)) {
    throw new SourceBundleError(
      'INVALID_COMMIT',
      'commit_sha must be 40 lowercase hexadecimal characters',
    );
  }
  if (typeof bundle.profile !== 'string' || !PROFILE_RE.test(bundle.profile)) {
    throw new SourceBundleError('INVALID_PROFILE', 'invalid source bundle profile');
  }
  assertString(bundle.created_at, 'created_at');
  assertString(bundle.node_engine, 'node_engine');

  if (!Array.isArray(bundle.entrypoints) ||
      bundle.entrypoints.some((value) => typeof value !== 'string')) {
    throw new SourceBundleError(
      'INVALID_ENTRYPOINTS',
      'entrypoints must be an array of repository-relative paths',
    );
  }

  if (!Array.isArray(bundle.files) || bundle.files.length === 0) {
    throw new SourceBundleError('INVALID_FILES', 'files must contain at least one source file');
  }

  const seenPaths = new Set();
  const filePaths = new Set();

  for (const descriptor of bundle.files) {
    validateFileDescriptor(descriptor);

    if (seenPaths.has(descriptor.path)) {
      throw new SourceBundleError(
        'DUPLICATE_PATH',
        'bundle contains duplicate source path',
        { path: descriptor.path },
      );
    }
    seenPaths.add(descriptor.path);
    filePaths.add(descriptor.path);
  }

  const seenEntrypoints = new Set();
  for (const entrypoint of bundle.entrypoints) {
    validateSourcePath(entrypoint);
    if (seenEntrypoints.has(entrypoint)) {
      throw new SourceBundleError(
        'DUPLICATE_ENTRYPOINT',
        'bundle contains duplicate entrypoint',
        { path: entrypoint },
      );
    }
    seenEntrypoints.add(entrypoint);

    if (!filePaths.has(entrypoint)) {
      throw new SourceBundleError(
        'ENTRYPOINT_NOT_BUNDLED',
        'entrypoint is not present in bundle files',
        { path: entrypoint },
      );
    }
  }

  return bundle;
}

export function validateSourcePath(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SourceBundleError('INVALID_PATH', 'source path must be a non-empty string');
  }
  if (value.includes('\\') || value.includes('\0') || value.startsWith('/')) {
    throw new SourceBundleError(
      'INVALID_PATH',
      'source path must be a normalized POSIX relative path',
      { path: value },
    );
  }

  const parts = value.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new SourceBundleError(
      'INVALID_PATH',
      'source path must not contain empty, dot or parent segments',
      { path: value },
    );
  }

  return value;
}

export function renderSelfExtractingSourceBundle(bundle) {
  validateSourceBundle(bundle);
  const embedded = JSON.stringify(bundle);

  return `#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SOURCE_BUNDLE_PROTOCOL = 'anet-memory/source-bundle/1';
const BUNDLE = ${embedded};

class BundleRuntimeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BundleRuntimeError';
    this.code = code;
    this.details = details;
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function gitBlobSha1(bytes) {
  const header = Buffer.from('blob ' + bytes.length + '\\0', 'utf8');
  return createHash('sha1').update(header).update(bytes).digest('hex');
}

function validatePath(value) {
  if (typeof value !== 'string' || value.length === 0 ||
      value.includes('\\\\') || value.includes('\\0') || value.startsWith('/')) {
    throw new BundleRuntimeError('INVALID_PATH', 'invalid repository-relative path', { path: value });
  }
  const parts = value.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new BundleRuntimeError('INVALID_PATH', 'invalid repository-relative path', { path: value });
  }
}

function decodeBase64Canonical(value, sourcePath) {
  if (typeof value !== 'string') {
    throw new BundleRuntimeError('INVALID_BASE64', 'content_base64 must be a string', { path: sourcePath });
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) {
    throw new BundleRuntimeError('INVALID_BASE64', 'content_base64 is not canonical base64', { path: sourcePath });
  }
  return bytes;
}

function verifyBundle(expected = {}) {
  if (BUNDLE.protocol !== SOURCE_BUNDLE_PROTOCOL) {
    throw new BundleRuntimeError('UNSUPPORTED_PROTOCOL', 'unexpected bundle protocol');
  }

  if (expected.repository && BUNDLE.repository !== expected.repository) {
    throw new BundleRuntimeError('REPOSITORY_MISMATCH', 'bundle repository does not match expectation', {
      expected: expected.repository,
      actual: BUNDLE.repository,
    });
  }
  if (expected.commit && BUNDLE.commit_sha !== expected.commit) {
    throw new BundleRuntimeError('COMMIT_MISMATCH', 'bundle commit does not match expectation', {
      expected: expected.commit,
      actual: BUNDLE.commit_sha,
    });
  }
  if (expected.profile && BUNDLE.profile !== expected.profile) {
    throw new BundleRuntimeError('PROFILE_MISMATCH', 'bundle profile does not match expectation', {
      expected: expected.profile,
      actual: BUNDLE.profile,
    });
  }

  const seen = new Set();
  const decoded = new Map();

  for (const file of BUNDLE.files) {
    validatePath(file.path);
    if (seen.has(file.path)) {
      throw new BundleRuntimeError('DUPLICATE_PATH', 'duplicate bundled source path', { path: file.path });
    }
    seen.add(file.path);

    const bytes = decodeBase64Canonical(file.content_base64, file.path);
    if (bytes.length !== file.size_bytes) {
      throw new BundleRuntimeError('SIZE_MISMATCH', 'bundled source size mismatch', {
        path: file.path,
        expected: file.size_bytes,
        actual: bytes.length,
      });
    }
    const actualSha256 = sha256(bytes);
    if (actualSha256 !== file.sha256) {
      throw new BundleRuntimeError('SHA256_MISMATCH', 'bundled source SHA-256 mismatch', {
        path: file.path,
        expected: file.sha256,
        actual: actualSha256,
      });
    }
    const actualBlob = gitBlobSha1(bytes);
    if (actualBlob !== file.git_blob_sha1) {
      throw new BundleRuntimeError('GIT_BLOB_MISMATCH', 'bundled Git blob identity mismatch', {
        path: file.path,
        expected: file.git_blob_sha1,
        actual: actualBlob,
      });
    }
    decoded.set(file.path, bytes);
  }

  for (const entrypoint of BUNDLE.entrypoints) {
    validatePath(entrypoint);
    if (!decoded.has(entrypoint)) {
      throw new BundleRuntimeError('ENTRYPOINT_NOT_BUNDLED', 'entrypoint is missing from bundle', {
        path: entrypoint,
      });
    }
  }

  return decoded;
}

async function ensureOutputAbsent(outputRoot) {
  try {
    await lstat(outputRoot);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new BundleRuntimeError(
    'OUTPUT_EXISTS',
    'output path must not already exist',
    { path: outputRoot },
  );
}

async function unpackBundle(outputRoot, expected) {
  const decoded = verifyBundle(expected);
  const absoluteOutput = path.resolve(outputRoot);
  await ensureOutputAbsent(absoluteOutput);

  const parent = path.dirname(absoluteOutput);
  await mkdir(parent, { recursive: true });
  const staging = absoluteOutput + '.tmp-' + process.pid + '-' + Date.now();
  await mkdir(staging);

  try {
    for (const file of BUNDLE.files) {
      const destination = path.join(staging, ...file.path.split('/'));
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, decoded.get(file.path), { flag: 'wx' });
    }

    for (const file of BUNDLE.files) {
      const materialized = await readFile(path.join(staging, ...file.path.split('/')));
      if (sha256(materialized) !== file.sha256) {
        throw new BundleRuntimeError(
          'POST_WRITE_HASH_MISMATCH',
          'materialized source failed post-write verification',
          { path: file.path },
        );
      }
    }

    await rename(staging, absoluteOutput);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }

  return absoluteOutput;
}

function parseArgs(tokens) {
  const output = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) throw new BundleRuntimeError('INVALID_ARGS', 'unexpected argument: ' + token);
    const key = token.slice(2);
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new BundleRuntimeError('INVALID_ARGS', 'missing value for --' + key);
    }
    if (output[key] !== undefined) {
      throw new BundleRuntimeError('INVALID_ARGS', '--' + key + ' may be supplied only once');
    }
    output[key] = value;
    index += 1;
  }
  return output;
}

async function selfSha256() {
  return sha256(await readFile(process.argv[1]));
}

async function main(argv) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  const expected = {
    repository: args.repository ?? null,
    commit: args.commit ?? null,
    profile: args.profile ?? null,
  };

  if (command === 'verify') {
    const decoded = verifyBundle(expected);
    process.stdout.write(JSON.stringify({
      protocol: BUNDLE.protocol,
      repository: BUNDLE.repository,
      commit_sha: BUNDLE.commit_sha,
      profile: BUNDLE.profile,
      created_at: BUNDLE.created_at,
      node_engine: BUNDLE.node_engine,
      entrypoints: BUNDLE.entrypoints,
      file_count: BUNDLE.files.length,
      total_source_bytes: [...decoded.values()].reduce((sum, bytes) => sum + bytes.length, 0),
      self_sha256: await selfSha256(),
    }, null, 2) + '\\n');
    return;
  }

  if (command === 'unpack') {
    if (!args.out) {
      throw new BundleRuntimeError('INVALID_ARGS', 'unpack requires --out');
    }
    const outputRoot = await unpackBundle(args.out, expected);
    process.stdout.write(JSON.stringify({
      protocol: BUNDLE.protocol,
      repository: BUNDLE.repository,
      commit_sha: BUNDLE.commit_sha,
      profile: BUNDLE.profile,
      output_root: outputRoot,
      entrypoints: BUNDLE.entrypoints,
      file_count: BUNDLE.files.length,
      self_sha256: await selfSha256(),
    }, null, 2) + '\\n');
    return;
  }

  throw new BundleRuntimeError('INVALID_COMMAND', 'expected verify or unpack');
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(JSON.stringify({
      error: error?.code ?? 'SOURCE_BUNDLE_ERROR',
      message: error?.message ?? String(error),
      details: error?.details ?? {},
    }) + '\\n');
    process.exitCode = 1;
  }
}
`;
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(toBuffer(bytes)).digest('hex');
}

export function gitBlobSha1(bytes) {
  const exact = toBuffer(bytes);
  const header = Buffer.from('blob ' + exact.length + '\0', 'utf8');
  return createHash('sha1').update(header).update(exact).digest('hex');
}

function validateFileDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    throw new SourceBundleError('INVALID_FILE', 'file descriptor must be an object');
  }
  assertExactKeys(descriptor, FILE_KEYS, 'file');
  validateSourcePath(descriptor.path);

  if (!Number.isSafeInteger(descriptor.size_bytes) || descriptor.size_bytes < 0) {
    throw new SourceBundleError('INVALID_SIZE', 'size_bytes must be a non-negative safe integer');
  }
  if (typeof descriptor.sha256 !== 'string' || !SHA256_RE.test(descriptor.sha256)) {
    throw new SourceBundleError('INVALID_SHA256', 'sha256 must be lowercase hexadecimal');
  }
  if (typeof descriptor.git_blob_sha1 !== 'string' || !SHA1_RE.test(descriptor.git_blob_sha1)) {
    throw new SourceBundleError('INVALID_GIT_BLOB', 'git_blob_sha1 must be lowercase hexadecimal');
  }
  if (typeof descriptor.content_base64 !== 'string') {
    throw new SourceBundleError('INVALID_BASE64', 'content_base64 must be a string');
  }

  const bytes = Buffer.from(descriptor.content_base64, 'base64');
  if (bytes.toString('base64') !== descriptor.content_base64) {
    throw new SourceBundleError(
      'INVALID_BASE64',
      'content_base64 must use canonical base64 encoding',
      { path: descriptor.path },
    );
  }
  if (bytes.length !== descriptor.size_bytes) {
    throw new SourceBundleError(
      'SIZE_MISMATCH',
      'file size does not match embedded bytes',
      { path: descriptor.path },
    );
  }
  if (sha256Hex(bytes) !== descriptor.sha256) {
    throw new SourceBundleError(
      'SHA256_MISMATCH',
      'file SHA-256 does not match embedded bytes',
      { path: descriptor.path },
    );
  }
  if (gitBlobSha1(bytes) !== descriptor.git_blob_sha1) {
    throw new SourceBundleError(
      'GIT_BLOB_MISMATCH',
      'Git blob SHA-1 does not match embedded bytes',
      { path: descriptor.path },
    );
  }
}

function assertExactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new SourceBundleError(
        'UNEXPECTED_FIELD',
        label + ' contains unsupported field: ' + key,
        { field: key },
      );
    }
  }
  for (const key of allowed) {
    if (!(key in value)) {
      throw new SourceBundleError(
        'MISSING_FIELD',
        label + ' is missing required field: ' + key,
        { field: key },
      );
    }
  }
}

function assertString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SourceBundleError('INVALID_FIELD', field + ' must be a non-empty string');
  }
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  throw new SourceBundleError(
    'INVALID_BYTES',
    'source file bytes must be Buffer, Uint8Array or UTF-8 string',
  );
}
