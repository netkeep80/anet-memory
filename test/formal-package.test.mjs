import test from 'node:test';
import assert from 'node:assert/strict';

import { decodePayload } from '../src/sandbox-bus.mjs';
import {
  FORMAL_PACKAGE_CONTENT_TYPE,
  FormalPackageError,
  createFormalBusEnvelope,
  createFormalPackage,
  decodeFormalArtifact,
  parseFormalPackage,
  readFormalBusEnvelope,
  serializeFormalPackage,
  validateFormalPackage,
} from '../src/formal-package.mjs';

function fixture(bytes = '{"fixture":"opaque-not-a-canonical-MTS-artifact"}\n') {
  return createFormalPackage({
    formalProfile: 'fixture/formal-profile',
    semanticVersion: 'fixture-semantic-version',
    resolverProfile: 'fixture/resolver-profile',
    metacompilerRef: 'fixture-metacompiler-ref',
    entry: ':Fixture',
    artifactBytes: bytes,
    artifactMediaType: 'application/json',
    authority: {
      kind: 'fixture-only',
      note: 'This is not an accepted MTS semantic artifact.',
    },
  });
}

test('FORMAL package preserves exact opaque artifact bytes', () => {
  const bytes = Buffer.from('{"fixture":"opaque-not-a-canonical-MTS-artifact"}\n', 'utf8');
  const value = fixture(bytes);

  assert.deepEqual(decodeFormalArtifact(value), bytes);
  assert.equal(
    value.artifact_sha256,
    'b4eb573252f3522ed45517dd0285995ba68d018eb5c6ee93ba5cf29af01ae446',
  );
});

test('artifact hash is over exact bytes, independent from package JSON formatting', () => {
  const compactArtifact = fixture('{"x":1}');
  const spacedArtifact = fixture('{"x": 1}');

  assert.notEqual(compactArtifact.artifact_sha256, spacedArtifact.artifact_sha256);

  const pretty = serializeFormalPackage(compactArtifact);
  const roundTrip = parseFormalPackage(pretty);
  assert.equal(roundTrip.artifact_sha256, compactArtifact.artifact_sha256);
});

test('tampered artifact bytes are rejected by inner semantic package integrity', () => {
  const value = fixture();
  const tampered = {
    ...value,
    artifact: Buffer.from('changed', 'utf8').toString('base64'),
  };

  assert.throws(
    () => validateFormalPackage(tampered),
    (error) => error instanceof FormalPackageError && error.code === 'ARTIFACT_HASH_MISMATCH',
  );
});

test('FORMAL package travels as ordinary sandbox-bus exact-byte payload', () => {
  const packageValue = fixture();
  const envelope = createFormalBusEnvelope({
    source: 'thread-a',
    target: 'thread-b',
    sequence: 1,
    previousMessageId: null,
    messageId: 'formal-package-1',
    createdAt: '2026-10-07T20:10:00.000Z',
    packageValue,
    transportMeta: {
      sandbox_ip: 'diagnostic-only',
    },
  });

  assert.equal(envelope.type, 'formal-package');
  assert.equal(envelope.content_type, FORMAL_PACKAGE_CONTENT_TYPE);

  const busPayload = decodePayload(envelope);
  assert.equal(busPayload.toString('utf8'), serializeFormalPackage(packageValue));

  const received = readFormalBusEnvelope(envelope);
  assert.deepEqual(received.package, packageValue);
  assert.deepEqual(received.artifactBytes, decodeFormalArtifact(packageValue));
});

test('semantic package metadata is distinct from transport metadata', () => {
  const packageValue = fixture();
  const first = createFormalBusEnvelope({
    source: 'thread-a',
    target: 'thread-b',
    sequence: 1,
    messageId: 'formal-meta-1',
    packageValue,
    transportMeta: { sandbox_ip: 'one' },
  });
  const second = createFormalBusEnvelope({
    source: 'thread-a',
    target: 'thread-b',
    sequence: 1,
    messageId: 'formal-meta-2',
    packageValue,
    transportMeta: { sandbox_ip: 'two' },
  });

  assert.equal(first.payload_sha256, second.payload_sha256);
  assert.equal(
    readFormalBusEnvelope(first).package.artifact_sha256,
    readFormalBusEnvelope(second).package.artifact_sha256,
  );
});

test('wrong bus content type is rejected even if payload contains a valid package', () => {
  const packageValue = fixture();
  const envelope = createFormalBusEnvelope({
    source: 'thread-a',
    target: 'thread-b',
    sequence: 1,
    messageId: 'formal-wrong-type',
    packageValue,
  });

  envelope.content_type = 'application/json';
  assert.throws(
    () => readFormalBusEnvelope(envelope),
    (error) => error instanceof FormalPackageError && error.code === 'INVALID_CONTENT_TYPE',
  );
});
