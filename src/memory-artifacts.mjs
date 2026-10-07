import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { buildMemoryViews } from './memory-views.mjs';

export const MEMORY_ARTIFACT_PROTOCOL = 'anet-memory/artifact/1';
export const MEMORY_ARTIFACT_CATALOG_PROTOCOL = 'anet-memory/artifact-catalog-v1';
export const MEMORY_GRAPH_PROTOCOL = 'anet-memory/graph-v1';

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SAFE_RELATION_RE = /^[A-Za-z][A-Za-z0-9._:-]{0,99}$/;
const ALLOWED_ARTIFACT_KEYS = new Set([
  'protocol',
  'artifact_id',
  'kind',
  'project',
  'subject',
  'summary',
  'status',
  'context',
  'relations',
  'provenance',
]);
const ALLOWED_RELATION_KEYS = new Set(['type', 'target']);

export class MemoryArtifactError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MemoryArtifactError';
    this.code = code;
    this.details = details;
  }
}

export function createMemoryArtifact({
  artifactId,
  kind,
  project,
  subject,
  summary,
  status = null,
  context = null,
  relations = [],
  provenance = [],
} = {}) {
  return validateMemoryArtifact({
    protocol: MEMORY_ARTIFACT_PROTOCOL,
    artifact_id: artifactId,
    kind,
    project,
    subject,
    summary,
    status,
    context,
    relations,
    provenance,
  });
}

export function validateMemoryArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw new MemoryArtifactError('INVALID_ARTIFACT', 'memory artifact must be an object');
  }

  assertExactKeys(artifact, ALLOWED_ARTIFACT_KEYS, 'artifact');
  if (artifact.protocol !== MEMORY_ARTIFACT_PROTOCOL) {
    throw new MemoryArtifactError('UNSUPPORTED_PROTOCOL', 'expected ' + MEMORY_ARTIFACT_PROTOCOL);
  }

  assertSafeId(artifact.artifact_id, 'artifact_id');
  assertString(artifact.kind, 'kind');
  assertString(artifact.project, 'project');
  assertString(artifact.subject, 'subject');
  assertString(artifact.summary, 'summary');
  assertNullableString(artifact.status, 'status');
  assertNullableString(artifact.context, 'context');

  if (!Array.isArray(artifact.provenance) ||
      artifact.provenance.some((value) => typeof value !== 'string' || value.length === 0)) {
    throw new MemoryArtifactError(
      'INVALID_PROVENANCE',
      'provenance must be an array of non-empty strings',
    );
  }

  if (!Array.isArray(artifact.relations)) {
    throw new MemoryArtifactError('INVALID_RELATIONS', 'relations must be an array');
  }

  const seenRelations = new Set();
  for (const relation of artifact.relations) {
    if (!relation || typeof relation !== 'object' || Array.isArray(relation)) {
      throw new MemoryArtifactError('INVALID_RELATION', 'relation must be an object');
    }
    assertExactKeys(relation, ALLOWED_RELATION_KEYS, 'relation');
    if (typeof relation.type !== 'string' || !SAFE_RELATION_RE.test(relation.type)) {
      throw new MemoryArtifactError(
        'INVALID_RELATION_TYPE',
        'relation type must match ' + SAFE_RELATION_RE,
      );
    }
    assertSafeId(relation.target, 'relation.target');

    const key = relation.type + '\0' + relation.target;
    if (seenRelations.has(key)) {
      throw new MemoryArtifactError('DUPLICATE_RELATION', 'duplicate relation edge', {
        type: relation.type,
        target: relation.target,
      });
    }
    seenRelations.add(key);
  }

  return artifact;
}

export function serializeMemoryArtifact(artifact) {
  validateMemoryArtifact(artifact);
  return JSON.stringify(artifact, null, 2) + '\n';
}

export function parseMemoryArtifact(text) {
  let artifact;
  try {
    artifact = JSON.parse(text);
  } catch (error) {
    throw new MemoryArtifactError('INVALID_JSON', 'memory artifact is not valid JSON', {
      cause: error.message,
    });
  }
  return validateMemoryArtifact(artifact);
}

export async function appendMemoryArtifact(root, artifact) {
  validateMemoryArtifact(artifact);
  const artifactRoot = path.join(path.resolve(root), 'artifacts');
  await mkdir(artifactRoot, { recursive: true });

  const destination = path.join(artifactRoot, artifact.artifact_id + '.json');
  const serialized = serializeMemoryArtifact(artifact);

  let existingText = null;
  try {
    existingText = await readFile(destination, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  if (existingText !== null) {
    const existing = parseMemoryArtifact(existingText);
    if (stableJson(existing) === stableJson(artifact)) {
      return {
        status: 'duplicate',
        path: destination,
        artifact_id: artifact.artifact_id,
      };
    }
    throw new MemoryArtifactError(
      'ARTIFACT_ID_CONFLICT',
      'artifact_id already exists with different immutable content',
      { artifact_id: artifact.artifact_id, path: destination },
    );
  }

  await atomicWrite(destination, serialized);
  return {
    status: 'appended',
    path: destination,
    artifact_id: artifact.artifact_id,
  };
}

export async function rebuildArtifactCatalog(root, { now = () => new Date().toISOString() } = {}) {
  const absoluteRoot = path.resolve(root);
  const artifactRoot = path.join(absoluteRoot, 'artifacts');
  const files = await listJsonFiles(artifactRoot);
  const sourceSha256 = await hashFiles(files, artifactRoot);

  const artifacts = {};
  const sources = {};
  const invalid = [];
  const duplicates = [];
  const conflicts = [];

  for (const file of files) {
    const relative = path.relative(absoluteRoot, file).split(path.sep).join('/');
    try {
      const artifact = parseMemoryArtifact(await readFile(file, 'utf8'));
      const prior = artifacts[artifact.artifact_id];

      if (!prior) {
        artifacts[artifact.artifact_id] = artifact;
        sources[artifact.artifact_id] = relative;
        continue;
      }

      if (stableJson(prior) === stableJson(artifact)) {
        duplicates.push({
          artifact_id: artifact.artifact_id,
          first_path: sources[artifact.artifact_id],
          duplicate_path: relative,
        });
        continue;
      }

      conflicts.push({
        artifact_id: artifact.artifact_id,
        first_path: sources[artifact.artifact_id],
        conflicting_path: relative,
      });
      delete artifacts[artifact.artifact_id];
      delete sources[artifact.artifact_id];
    } catch (error) {
      invalid.push({
        path: relative,
        code: error?.code ?? 'READ_OR_PARSE_ERROR',
        message: error?.message ?? String(error),
      });
    }
  }

  return {
    protocol: MEMORY_ARTIFACT_CATALOG_PROTOCOL,
    generated_at: now(),
    source: {
      files: files.length,
      source_sha256: sourceSha256,
      invalid_artifacts: invalid.length,
      duplicate_artifacts: duplicates.length,
      conflicting_artifacts: conflicts.length,
      invalid,
      duplicates,
      conflicts,
    },
    artifacts: sortObject(artifacts),
  };
}

export function buildMemoryGraph(
  memoryState,
  artifactCatalog,
  { generatedAt = new Date().toISOString() } = {},
) {
  if (!memoryState || memoryState.protocol !== 'anet-memory/state-v1') {
    throw new MemoryArtifactError(
      'INVALID_MEMORY_STATE',
      'memoryState must be an anet-memory/state-v1 value',
    );
  }
  if (!artifactCatalog || artifactCatalog.protocol !== MEMORY_ARTIFACT_CATALOG_PROTOCOL) {
    throw new MemoryArtifactError(
      'INVALID_ARTIFACT_CATALOG',
      'artifactCatalog must be an ' + MEMORY_ARTIFACT_CATALOG_PROTOCOL + ' value',
    );
  }

  const view = buildMemoryViews(memoryState, { generatedAt });
  const classifications = {
    accepted: view.current.accepted.map((item) => item.artifact_id),
    candidates: view.current.candidates.map((item) => item.artifact_id),
    rejected: view.historical.rejected.map((item) => item.artifact_id),
    superseded: view.historical.superseded.map((item) => item.artifact_id),
    attention: view.attention.map((item) => item.artifact_id),
  };

  const allIds = new Set([
    ...Object.keys(memoryState.artifacts),
    ...Object.keys(artifactCatalog.artifacts),
  ]);

  const nodes = {};
  const missingSemanticRecords = [];
  const semanticWithoutLifecycle = [];
  const danglingRelations = [];

  for (const artifactId of [...allIds].sort()) {
    const semantic = artifactCatalog.artifacts[artifactId] ?? null;
    const lifecycle = memoryState.artifacts[artifactId] ?? null;

    if (!semantic) missingSemanticRecords.push(artifactId);
    if (!lifecycle) semanticWithoutLifecycle.push(artifactId);

    const relations = semantic?.relations ?? [];
    for (const relation of relations) {
      if (!artifactCatalog.artifacts[relation.target]) {
        danglingRelations.push({
          source: artifactId,
          type: relation.type,
          target: relation.target,
        });
      }
    }

    nodes[artifactId] = {
      artifact_id: artifactId,
      kind: semantic?.kind ?? null,
      project: semantic?.project ?? null,
      subject: semantic?.subject ?? null,
      summary: semantic?.summary ?? null,
      status: semantic?.status ?? null,
      context: semantic?.context ?? null,
      relations,
      semantic_provenance: semantic?.provenance ?? [],
      lifecycle,
    };
  }

  return {
    protocol: MEMORY_GRAPH_PROTOCOL,
    generated_at: generatedAt,
    source: {
      memory_event_source_sha256: memoryState.journal.source_sha256,
      semantic_artifact_source_sha256: artifactCatalog.source.source_sha256,
      invalid_memory_events: memoryState.journal.invalid_events,
      invalid_semantic_artifacts: artifactCatalog.source.invalid_artifacts,
      conflicting_semantic_artifacts: artifactCatalog.source.conflicting_artifacts,
    },
    classifications,
    nodes,
    missing_semantic_records: missingSemanticRecords,
    semantic_without_lifecycle: semanticWithoutLifecycle,
    dangling_relations: danglingRelations.sort(compareRelation),
  };
}

function compareRelation(a, b) {
  return a.source.localeCompare(b.source) ||
    a.type.localeCompare(b.type) ||
    a.target.localeCompare(b.target);
}

async function listJsonFiles(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(root, entry.name))
    .sort();
}

async function hashFiles(files, artifactRoot) {
  const hash = createHash('sha256');
  for (const file of files) {
    const relative = path.relative(artifactRoot, file).split(path.sep).join('/');
    hash.update(relative, 'utf8');
    hash.update(Buffer.from([0]));
    hash.update(await readFile(file));
    hash.update(Buffer.from([0]));
  }
  return hash.digest('hex');
}

async function atomicWrite(destination, content) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = destination + '.tmp-' + process.pid + '-' + Date.now();
  await writeFile(temporary, content);
  await rename(temporary, destination);
}

function assertExactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new MemoryArtifactError(
        'UNEXPECTED_FIELD',
        label + ' contains unsupported field: ' + key,
        { field: key },
      );
    }
  }
  for (const key of allowed) {
    if (!(key in value)) {
      throw new MemoryArtifactError(
        'MISSING_FIELD',
        label + ' is missing required field: ' + key,
        { field: key },
      );
    }
  }
}

function assertSafeId(value, field) {
  if (typeof value !== 'string' || !SAFE_ID_RE.test(value)) {
    throw new MemoryArtifactError('INVALID_ID', field + ' must match ' + SAFE_ID_RE);
  }
}

function assertString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new MemoryArtifactError('INVALID_FIELD', field + ' must be a non-empty string');
  }
}

function assertNullableString(value, field) {
  if (value !== null && (typeof value !== 'string' || value.length === 0)) {
    throw new MemoryArtifactError('INVALID_FIELD', field + ' must be null or a non-empty string');
  }
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

function sortObject(value) {
  const output = {};
  for (const key of Object.keys(value).sort()) output[key] = value[key];
  return output;
}
