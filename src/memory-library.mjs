import { createHash } from 'node:crypto';

import {
  appendMemoryArtifact,
  buildMemoryGraph,
  parseMemoryArtifact,
  rebuildArtifactCatalog,
} from './memory-artifacts.mjs';
import {
  appendMemoryEvent,
  parseMemoryEvent,
  rebuildMemoryState,
} from './memory-events.mjs';

export const MEMORY_LIBRARY_MANIFEST_PROTOCOL = 'anet-memory/library-manifest/1';
export const MEMORY_LIBRARY_ROOT = '/anet-memory/v1';

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const MANIFEST_KEYS = new Set([
  'protocol',
  'manifest_id',
  'project',
  'created_at',
  'root_artifact_ids',
  'objects',
  'provenance',
]);
const DESCRIPTOR_KEYS = new Set(['kind', 'logical_id', 'path', 'sha256']);

export class MemoryLibraryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MemoryLibraryError';
    this.code = code;
    this.details = details;
  }
}

export function memoryLibraryArtifactPath(artifactId) {
  assertSafeId(artifactId, 'artifact_id');
  return MEMORY_LIBRARY_ROOT + '/artifacts/' + artifactId + '.json';
}

export function memoryLibraryEventPath(eventId) {
  assertSafeId(eventId, 'event_id');
  return MEMORY_LIBRARY_ROOT + '/events/' + eventId + '.json';
}

export function memoryLibraryManifestPath(manifestId) {
  assertSafeId(manifestId, 'manifest_id');
  return MEMORY_LIBRARY_ROOT + '/manifests/' + manifestId + '.json';
}

export function describeMemoryLibraryObject(kind, bytes) {
  const exact = toBuffer(bytes);
  let logicalId;
  let path;

  if (kind === 'artifact') {
    const artifact = parseMemoryArtifact(exact.toString('utf8'));
    logicalId = artifact.artifact_id;
    path = memoryLibraryArtifactPath(logicalId);
  } else if (kind === 'event') {
    const event = parseMemoryEvent(exact.toString('utf8'));
    logicalId = event.event_id;
    path = memoryLibraryEventPath(logicalId);
  } else {
    throw new MemoryLibraryError(
      'INVALID_OBJECT_KIND',
      'kind must be artifact or event',
      { kind },
    );
  }

  return {
    kind,
    logical_id: logicalId,
    path,
    sha256: sha256(exact),
  };
}

export function createMemoryLibraryManifest({
  manifestId,
  project,
  createdAt = new Date().toISOString(),
  rootArtifactIds = [],
  objects = [],
  provenance = [],
} = {}) {
  const manifest = {
    protocol: MEMORY_LIBRARY_MANIFEST_PROTOCOL,
    manifest_id: manifestId,
    project,
    created_at: createdAt,
    root_artifact_ids: [...rootArtifactIds],
    objects: [...objects].map((object) => ({ ...object })),
    provenance: [...provenance],
  };
  validateMemoryLibraryManifest(manifest);
  manifest.objects.sort(compareDescriptor);
  manifest.root_artifact_ids = [...new Set(manifest.root_artifact_ids)].sort();
  manifest.provenance = [...new Set(manifest.provenance)].sort();
  return manifest;
}

export function validateMemoryLibraryManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new MemoryLibraryError('INVALID_MANIFEST', 'manifest must be an object');
  }
  assertExactKeys(manifest, MANIFEST_KEYS, 'manifest');

  if (manifest.protocol !== MEMORY_LIBRARY_MANIFEST_PROTOCOL) {
    throw new MemoryLibraryError(
      'UNSUPPORTED_PROTOCOL',
      'expected ' + MEMORY_LIBRARY_MANIFEST_PROTOCOL,
    );
  }

  assertSafeId(manifest.manifest_id, 'manifest_id');
  assertString(manifest.project, 'project');
  assertString(manifest.created_at, 'created_at');

  if (!Array.isArray(manifest.root_artifact_ids) ||
      manifest.root_artifact_ids.some((id) => typeof id !== 'string')) {
    throw new MemoryLibraryError(
      'INVALID_ROOTS',
      'root_artifact_ids must be an array of artifact IDs',
    );
  }
  for (const id of manifest.root_artifact_ids) assertSafeId(id, 'root_artifact_id');

  if (!Array.isArray(manifest.provenance) ||
      manifest.provenance.some((value) => typeof value !== 'string' || value.length === 0)) {
    throw new MemoryLibraryError(
      'INVALID_PROVENANCE',
      'provenance must be an array of non-empty strings',
    );
  }

  if (!Array.isArray(manifest.objects) || manifest.objects.length === 0) {
    throw new MemoryLibraryError(
      'INVALID_OBJECTS',
      'manifest.objects must contain at least one descriptor',
    );
  }

  const seenPaths = new Set();
  const artifactIds = new Set();

  for (const descriptor of manifest.objects) {
    validateDescriptor(descriptor);
    if (seenPaths.has(descriptor.path)) {
      throw new MemoryLibraryError(
        'DUPLICATE_OBJECT_PATH',
        'manifest contains duplicate object path',
        { path: descriptor.path },
      );
    }
    seenPaths.add(descriptor.path);
    if (descriptor.kind === 'artifact') artifactIds.add(descriptor.logical_id);
  }

  for (const rootId of manifest.root_artifact_ids) {
    if (!artifactIds.has(rootId)) {
      throw new MemoryLibraryError(
        'MISSING_ROOT_ARTIFACT',
        'root artifact is not described by manifest',
        { artifact_id: rootId },
      );
    }
  }

  return manifest;
}

export function serializeMemoryLibraryManifest(manifest) {
  validateMemoryLibraryManifest(manifest);
  return JSON.stringify(manifest, null, 2) + '\n';
}

export function parseMemoryLibraryManifest(text) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new MemoryLibraryError('INVALID_JSON', 'manifest is not valid JSON', {
      cause: error.message,
    });
  }
  return validateMemoryLibraryManifest(manifest);
}

export function verifyMemoryLibraryObject(descriptor, bytes) {
  validateDescriptor(descriptor);
  const exact = toBuffer(bytes);
  const actualSha = sha256(exact);
  if (actualSha !== descriptor.sha256) {
    throw new MemoryLibraryError(
      'OBJECT_HASH_MISMATCH',
      'Library object SHA-256 does not match manifest descriptor',
      {
        path: descriptor.path,
        expected_sha256: descriptor.sha256,
        actual_sha256: actualSha,
      },
    );
  }

  if (descriptor.kind === 'artifact') {
    const artifact = parseMemoryArtifact(exact.toString('utf8'));
    if (artifact.artifact_id !== descriptor.logical_id) {
      throw new MemoryLibraryError(
        'OBJECT_LOGICAL_ID_MISMATCH',
        'artifact_id does not match manifest descriptor',
        {
          path: descriptor.path,
          expected: descriptor.logical_id,
          actual: artifact.artifact_id,
        },
      );
    }
    return artifact;
  }

  const event = parseMemoryEvent(exact.toString('utf8'));
  if (event.event_id !== descriptor.logical_id) {
    throw new MemoryLibraryError(
      'OBJECT_LOGICAL_ID_MISMATCH',
      'event_id does not match manifest descriptor',
      {
        path: descriptor.path,
        expected: descriptor.logical_id,
        actual: event.event_id,
      },
    );
  }
  return event;
}

export async function importMemoryLibrarySnapshot(root, manifest, objectBytesByPath) {
  validateMemoryLibraryManifest(manifest);
  const source = normalizeObjectSource(objectBytesByPath);

  // Phase 1: validate the entire immutable snapshot before any local write.
  const verified = [];
  const artifactIds = new Set(
    manifest.objects
      .filter((descriptor) => descriptor.kind === 'artifact')
      .map((descriptor) => descriptor.logical_id),
  );

  for (const descriptor of [...manifest.objects].sort(compareDescriptor)) {
    if (!source.has(descriptor.path)) {
      throw new MemoryLibraryError(
        'MISSING_LIBRARY_OBJECT',
        'manifest-referenced object is missing',
        { path: descriptor.path },
      );
    }

    const value = verifyMemoryLibraryObject(descriptor, source.get(descriptor.path));
    if (descriptor.kind === 'artifact' && value.project !== manifest.project) {
      throw new MemoryLibraryError(
        'PROJECT_MISMATCH',
        'artifact project does not match manifest project',
        {
          path: descriptor.path,
          manifest_project: manifest.project,
          artifact_project: value.project,
        },
      );
    }
    if (descriptor.kind === 'event' && !artifactIds.has(value.artifact_id)) {
      throw new MemoryLibraryError(
        'EVENT_ARTIFACT_MISSING',
        'event references an artifact outside the manifest snapshot',
        {
          path: descriptor.path,
          artifact_id: value.artifact_id,
        },
      );
    }

    verified.push({ descriptor, value });
  }

  // Phase 2: append through the same immutable validators used by normal ingestion.
  const imported = [];
  for (const { descriptor, value } of verified) {
    const result = descriptor.kind === 'artifact'
      ? await appendMemoryArtifact(root, value)
      : await appendMemoryEvent(root, value);
    imported.push({
      kind: descriptor.kind,
      logical_id: descriptor.logical_id,
      status: result.status,
    });
  }

  const memoryState = await rebuildMemoryState(root);
  const artifactCatalog = await rebuildArtifactCatalog(root);
  const memoryGraph = buildMemoryGraph(memoryState, artifactCatalog);

  return {
    manifest_id: manifest.manifest_id,
    project: manifest.project,
    root_artifact_ids: [...manifest.root_artifact_ids],
    imported,
    memory_state: memoryState,
    artifact_catalog: artifactCatalog,
    memory_graph: memoryGraph,
  };
}

function validateDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    throw new MemoryLibraryError('INVALID_DESCRIPTOR', 'object descriptor must be an object');
  }
  assertExactKeys(descriptor, DESCRIPTOR_KEYS, 'descriptor');
  if (descriptor.kind !== 'artifact' && descriptor.kind !== 'event') {
    throw new MemoryLibraryError('INVALID_OBJECT_KIND', 'descriptor kind must be artifact or event');
  }
  assertSafeId(descriptor.logical_id, 'logical_id');

  const expectedPath = descriptor.kind === 'artifact'
    ? memoryLibraryArtifactPath(descriptor.logical_id)
    : memoryLibraryEventPath(descriptor.logical_id);

  if (descriptor.path !== expectedPath) {
    throw new MemoryLibraryError(
      'OBJECT_PATH_MISMATCH',
      'descriptor path is not derived from kind/logical_id',
      {
        expected_path: expectedPath,
        actual_path: descriptor.path,
      },
    );
  }
  if (typeof descriptor.sha256 !== 'string' || !SHA256_RE.test(descriptor.sha256)) {
    throw new MemoryLibraryError('INVALID_SHA256', 'descriptor sha256 must be lowercase hex');
  }
  return descriptor;
}

function normalizeObjectSource(value) {
  if (value instanceof Map) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MemoryLibraryError(
      'INVALID_OBJECT_SOURCE',
      'objectBytesByPath must be a Map or object keyed by Library path',
    );
  }
  return new Map(Object.entries(value));
}

function compareDescriptor(a, b) {
  return a.path.localeCompare(b.path);
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  throw new MemoryLibraryError(
    'INVALID_OBJECT_BYTES',
    'Library object bytes must be a Buffer, Uint8Array, or UTF-8 string',
  );
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertSafeId(value, field) {
  if (typeof value !== 'string' || !SAFE_ID_RE.test(value)) {
    throw new MemoryLibraryError('INVALID_ID', field + ' must match ' + SAFE_ID_RE);
  }
}

function assertString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new MemoryLibraryError('INVALID_FIELD', field + ' must be a non-empty string');
  }
}

function assertExactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new MemoryLibraryError(
        'UNEXPECTED_FIELD',
        label + ' contains unsupported field: ' + key,
        { field: key },
      );
    }
  }
  for (const key of allowed) {
    if (!(key in value)) {
      throw new MemoryLibraryError(
        'MISSING_FIELD',
        label + ' is missing required field: ' + key,
        { field: key },
      );
    }
  }
}
