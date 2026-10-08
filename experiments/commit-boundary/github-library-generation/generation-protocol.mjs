import { createHash } from 'node:crypto';

export const SCHEMA = 'anet-github-library-generation/research-1';

const COMMIT_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const FILE_ID_RE = /^file_[A-Za-z0-9_-]+$/;
const SCOPE_RE = /^[A-Za-z0-9._:-]+$/;

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name}: expected object`);
  }
}

function assertCommit(value, name) {
  if (typeof value !== 'string' || !COMMIT_RE.test(value)) {
    throw new Error(`${name}: invalid Git commit SHA`);
  }
}

export function validateLibraryDescriptor(root) {
  assertObject(root, 'root');

  if (typeof root.path !== 'string' || !root.path.startsWith('/')) {
    throw new Error('root.path: expected absolute Library path');
  }
  if (typeof root.file_id !== 'string' || !FILE_ID_RE.test(root.file_id)) {
    throw new Error('root.file_id: invalid file_id');
  }
  if (!Number.isSafeInteger(root.size_bytes) || root.size_bytes < 0) {
    throw new Error('root.size_bytes: expected non-negative safe integer');
  }
  if (typeof root.sha256 !== 'string' || !SHA256_RE.test(root.sha256)) {
    throw new Error('root.sha256: invalid SHA-256');
  }

  return root;
}

export function validateGenerationRecord(record) {
  assertObject(record, 'record');

  if (record.schema !== SCHEMA) {
    throw new Error('record.schema: unsupported schema');
  }
  if (typeof record.scope !== 'string' || !SCOPE_RE.test(record.scope)) {
    throw new Error('record.scope: invalid scope');
  }
  if (!Number.isSafeInteger(record.generation) || record.generation < 1) {
    throw new Error('record.generation: expected positive safe integer');
  }

  if (record.generation === 1) {
    if (record.predecessor_commit !== null) {
      throw new Error('record.predecessor_commit: generation 1 must use null');
    }
  } else {
    assertCommit(record.predecessor_commit, 'record.predecessor_commit');
  }

  validateLibraryDescriptor(record.root);

  if (record.application_effects_allowed !== false) {
    throw new Error('record.application_effects_allowed: must be false in research profile');
  }

  return record;
}

export function validateTransition({
  currentRecord,
  currentCommit,
  candidateRecord,
  candidateParent,
}) {
  validateGenerationRecord(currentRecord);
  validateGenerationRecord(candidateRecord);
  assertCommit(currentCommit, 'currentCommit');
  assertCommit(candidateParent, 'candidateParent');

  if (candidateRecord.scope !== currentRecord.scope) {
    throw new Error('transition: scope changed');
  }
  if (candidateRecord.generation !== currentRecord.generation + 1) {
    throw new Error('transition: generation must advance by exactly one');
  }
  if (candidateRecord.predecessor_commit !== currentCommit) {
    throw new Error('transition: predecessor_commit does not match current authority head');
  }
  if (candidateParent !== currentCommit) {
    throw new Error('transition: actual Git parent does not match current authority head');
  }

  return {
    classification: 'VALID_NEXT_GENERATION',
    expected_head: currentCommit,
  };
}

export function classifyCasObservation({
  expectedHead,
  candidateCommit,
  observedHead,
  mutationStatus,
}) {
  assertCommit(expectedHead, 'expectedHead');
  assertCommit(candidateCommit, 'candidateCommit');
  assertCommit(observedHead, 'observedHead');

  if (!['success', 'error'].includes(mutationStatus)) {
    throw new Error('mutationStatus: expected success or error');
  }

  if (observedHead === candidateCommit) {
    return {
      classification: 'COMMITTED',
      retry: false,
    };
  }

  if (observedHead === expectedHead) {
    if (mutationStatus === 'success') {
      return {
        classification: 'FAIL_CLOSED_INCONSISTENT_SUCCESS',
        retry: false,
      };
    }
    return {
      classification: 'SAFE_RETRY_SAME_CANDIDATE',
      retry: true,
    };
  }

  return {
    classification: 'LOST_RACE',
    retry: false,
  };
}

export function verifySelectedLibraryObject({ descriptor, bytes }) {
  validateLibraryDescriptor(descriptor);

  if (bytes === null || bytes === undefined) {
    return {
      classification: 'PENDING_LIBRARY_OBJECT',
      usable: false,
    };
  }

  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);

  if (buffer.length !== descriptor.size_bytes) {
    return {
      classification: 'LIBRARY_SIZE_MISMATCH',
      usable: false,
    };
  }

  const actualSha256 = createHash('sha256').update(buffer).digest('hex');
  if (actualSha256 !== descriptor.sha256) {
    return {
      classification: 'LIBRARY_SHA256_MISMATCH',
      usable: false,
      actual_sha256: actualSha256,
    };
  }

  return {
    classification: 'VERIFIED_SELECTED_LIBRARY_OBJECT',
    usable: true,
    actual_sha256: actualSha256,
  };
}
