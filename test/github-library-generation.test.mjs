import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  SCHEMA,
  classifyCasObservation,
  validateGenerationRecord,
  validateTransition,
  verifySelectedLibraryObject,
} from '../experiments/commit-boundary/github-library-generation/generation-protocol.mjs';

const H1 = '1111111111111111111111111111111111111111';
const H2 = '2222222222222222222222222222222222222222';
const H3 = '3333333333333333333333333333333333333333';

function descriptor(bytes, suffix = '01') {
  const b = Buffer.from(bytes);
  return {
    path: `/anet-memory/v1/state/g${suffix}/root.json`,
    file_id: `file_test_${suffix}`,
    size_bytes: b.length,
    sha256: createHash('sha256').update(b).digest('hex'),
  };
}

function record({ generation, predecessor, bytes, scope = 'anet-memory.main', suffix }) {
  return {
    schema: SCHEMA,
    scope,
    generation,
    predecessor_commit: predecessor,
    root: descriptor(bytes, suffix ?? String(generation).padStart(2, '0')),
    application_effects_allowed: false,
  };
}

test('valid next generation binds logical predecessor and actual Git parent', () => {
  const current = record({ generation: 1, predecessor: null, bytes: '{"n":1}' });
  const next = record({ generation: 2, predecessor: H1, bytes: '{"n":2}' });

  const result = validateTransition({
    currentRecord: current,
    currentCommit: H1,
    candidateRecord: next,
    candidateParent: H1,
  });

  assert.deepEqual(result, {
    classification: 'VALID_NEXT_GENERATION',
    expected_head: H1,
  });
});

test('generation gap is rejected', () => {
  const current = record({ generation: 1, predecessor: null, bytes: 'a' });
  const candidate = record({ generation: 3, predecessor: H1, bytes: 'b' });

  assert.throws(() => validateTransition({
    currentRecord: current,
    currentCommit: H1,
    candidateRecord: candidate,
    candidateParent: H1,
  }), /advance by exactly one/);
});

test('scope change is rejected', () => {
  const current = record({ generation: 1, predecessor: null, bytes: 'a' });
  const candidate = record({
    generation: 2,
    predecessor: H1,
    bytes: 'b',
    scope: 'anet-memory.other',
  });

  assert.throws(() => validateTransition({
    currentRecord: current,
    currentCommit: H1,
    candidateRecord: candidate,
    candidateParent: H1,
  }), /scope changed/);
});

test('record predecessor mismatch is rejected', () => {
  const current = record({ generation: 1, predecessor: null, bytes: 'a' });
  const candidate = record({ generation: 2, predecessor: H2, bytes: 'b' });

  assert.throws(() => validateTransition({
    currentRecord: current,
    currentCommit: H1,
    candidateRecord: candidate,
    candidateParent: H1,
  }), /predecessor_commit/);
});

test('actual Git parent mismatch is rejected', () => {
  const current = record({ generation: 1, predecessor: null, bytes: 'a' });
  const candidate = record({ generation: 2, predecessor: H1, bytes: 'b' });

  assert.throws(() => validateTransition({
    currentRecord: current,
    currentCommit: H1,
    candidateRecord: candidate,
    candidateParent: H2,
  }), /actual Git parent/);
});

test('malformed Library descriptor is rejected', () => {
  const r = record({ generation: 1, predecessor: null, bytes: 'a' });
  r.root.file_id = 'not-a-file-id';
  assert.throws(() => validateGenerationRecord(r), /file_id/);
});

test('exact selected Library bytes verify', () => {
  const bytes = Buffer.from('{"payload":"exact"}');
  const root = descriptor(bytes, 'exact');

  const result = verifySelectedLibraryObject({ descriptor: root, bytes });
  assert.equal(result.classification, 'VERIFIED_SELECTED_LIBRARY_OBJECT');
  assert.equal(result.usable, true);
});

test('missing selected Library object is pending, never committed by visibility inference', () => {
  const root = descriptor('x', 'missing');
  const result = verifySelectedLibraryObject({ descriptor: root, bytes: null });
  assert.deepEqual(result, {
    classification: 'PENDING_LIBRARY_OBJECT',
    usable: false,
  });
});

test('wrong Library size is rejected', () => {
  const root = descriptor('abc', 'size');
  const result = verifySelectedLibraryObject({ descriptor: root, bytes: 'abcd' });
  assert.equal(result.classification, 'LIBRARY_SIZE_MISMATCH');
  assert.equal(result.usable, false);
});

test('wrong Library SHA-256 is rejected even when size matches', () => {
  const root = descriptor('abc', 'sha');
  const result = verifySelectedLibraryObject({ descriptor: root, bytes: 'abd' });
  assert.equal(result.classification, 'LIBRARY_SHA256_MISMATCH');
  assert.equal(result.usable, false);
});

test('ambiguous mutation error with unchanged head permits only same-candidate retry', () => {
  assert.deepEqual(classifyCasObservation({
    expectedHead: H1,
    candidateCommit: H2,
    observedHead: H1,
    mutationStatus: 'error',
  }), {
    classification: 'SAFE_RETRY_SAME_CANDIDATE',
    retry: true,
  });
});

test('error response followed by candidate head is classified committed', () => {
  assert.deepEqual(classifyCasObservation({
    expectedHead: H1,
    candidateCommit: H2,
    observedHead: H2,
    mutationStatus: 'error',
  }), {
    classification: 'COMMITTED',
    retry: false,
  });
});

test('another authoritative head means the candidate lost the race', () => {
  assert.deepEqual(classifyCasObservation({
    expectedHead: H1,
    candidateCommit: H2,
    observedHead: H3,
    mutationStatus: 'error',
  }), {
    classification: 'LOST_RACE',
    retry: false,
  });
});

test('reported success contradicted by unchanged authoritative head fails closed', () => {
  assert.deepEqual(classifyCasObservation({
    expectedHead: H1,
    candidateCommit: H2,
    observedHead: H1,
    mutationStatus: 'success',
  }), {
    classification: 'FAIL_CLOSED_INCONSISTENT_SUCCESS',
    retry: false,
  });
});

test('visible orphan Library bytes do not affect CAS classification', () => {
  const orphan = verifySelectedLibraryObject({
    descriptor: descriptor('orphan', 'orphan'),
    bytes: 'orphan',
  });
  assert.equal(orphan.usable, true);

  const authority = classifyCasObservation({
    expectedHead: H1,
    candidateCommit: H2,
    observedHead: H3,
    mutationStatus: 'error',
  });

  assert.equal(authority.classification, 'LOST_RACE');
  assert.equal(authority.retry, false);
});
