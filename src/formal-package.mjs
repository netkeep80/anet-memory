import { sha256Hex, createEnvelope, decodePayload, validateEnvelope } from './sandbox-bus.mjs';

export const FORMAL_PACKAGE_PROTOCOL = 'anet-memory/formal-package/1';
export const FORMAL_PACKAGE_CONTENT_TYPE = 'application/vnd.anet-memory.formal-package+json';

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export class FormalPackageError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'FormalPackageError';
    this.code = code;
    this.details = details;
  }
}

export function createFormalPackage({
  formalProfile,
  semanticVersion,
  resolverProfile,
  metacompilerRef,
  entry,
  artifactBytes,
  artifactMediaType = 'application/json',
  authority,
} = {}) {
  assertString(formalProfile, 'formalProfile');
  assertString(semanticVersion, 'semanticVersion');
  assertString(resolverProfile, 'resolverProfile');
  assertString(metacompilerRef, 'metacompilerRef');
  assertString(entry, 'entry');
  assertString(artifactMediaType, 'artifactMediaType');

  const bytes = toBuffer(artifactBytes);
  const value = {
    package_protocol: FORMAL_PACKAGE_PROTOCOL,
    formal_profile: formalProfile,
    semantic_version: semanticVersion,
    resolver_profile: resolverProfile,
    metacompiler_ref: metacompilerRef,
    entry,
    artifact_media_type: artifactMediaType,
    artifact_encoding: 'base64',
    artifact: bytes.toString('base64'),
    artifact_sha256: sha256Hex(bytes),
  };

  if (authority !== undefined) {
    if (!authority || typeof authority !== 'object' || Array.isArray(authority)) {
      throw new FormalPackageError('INVALID_AUTHORITY', 'authority must be an object when present');
    }
    value.authority = authority;
  }

  return value;
}

export function validateFormalPackage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new FormalPackageError('INVALID_PACKAGE', 'FORMAL package must be an object');
  }
  if (value.package_protocol !== FORMAL_PACKAGE_PROTOCOL) {
    throw new FormalPackageError('UNSUPPORTED_PACKAGE_PROTOCOL', `expected ${FORMAL_PACKAGE_PROTOCOL}`);
  }

  for (const field of [
    'formal_profile',
    'semantic_version',
    'resolver_profile',
    'metacompiler_ref',
    'entry',
    'artifact_media_type',
  ]) {
    assertString(value[field], field);
  }

  if (value.artifact_encoding !== 'base64') {
    throw new FormalPackageError('UNSUPPORTED_ARTIFACT_ENCODING', 'artifact_encoding must be base64');
  }
  if (typeof value.artifact !== 'string' || !isCanonicalBase64(value.artifact)) {
    throw new FormalPackageError('INVALID_ARTIFACT_ENCODING', 'artifact must be canonical base64');
  }
  if (!/^[0-9a-f]{64}$/.test(value.artifact_sha256 ?? '')) {
    throw new FormalPackageError('INVALID_ARTIFACT_HASH', 'artifact_sha256 must be lowercase SHA-256 hex');
  }

  const bytes = Buffer.from(value.artifact, 'base64');
  const actual = sha256Hex(bytes);
  if (actual !== value.artifact_sha256) {
    throw new FormalPackageError('ARTIFACT_HASH_MISMATCH', 'artifact SHA-256 does not match package', {
      expected: value.artifact_sha256,
      actual,
    });
  }

  if (value.authority !== undefined &&
      (!value.authority || typeof value.authority !== 'object' || Array.isArray(value.authority))) {
    throw new FormalPackageError('INVALID_AUTHORITY', 'authority must be an object when present');
  }

  return value;
}

export function decodeFormalArtifact(value) {
  validateFormalPackage(value);
  return Buffer.from(value.artifact, 'base64');
}

export function serializeFormalPackage(value) {
  validateFormalPackage(value);
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function parseFormalPackage(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new FormalPackageError('INVALID_JSON', 'FORMAL package is not valid JSON', {
      cause: error.message,
    });
  }
  return validateFormalPackage(value);
}

export function createFormalBusEnvelope({
  source,
  target,
  sequence,
  previousMessageId = null,
  messageId,
  createdAt,
  packageValue,
  transportMeta,
} = {}) {
  validateFormalPackage(packageValue);
  return createEnvelope({
    type: 'formal-package',
    messageId,
    source,
    target,
    sequence,
    previousMessageId,
    createdAt,
    contentType: FORMAL_PACKAGE_CONTENT_TYPE,
    payloadBytes: Buffer.from(serializeFormalPackage(packageValue), 'utf8'),
    transportMeta,
  });
}

export function readFormalBusEnvelope(envelope) {
  validateEnvelope(envelope);
  if (envelope.type !== 'formal-package') {
    throw new FormalPackageError('NOT_FORMAL_PACKAGE', 'sandbox-bus envelope type must be formal-package');
  }
  if (envelope.content_type !== FORMAL_PACKAGE_CONTENT_TYPE) {
    throw new FormalPackageError('INVALID_CONTENT_TYPE', `expected ${FORMAL_PACKAGE_CONTENT_TYPE}`);
  }

  const packageValue = parseFormalPackage(decodePayload(envelope).toString('utf8'));
  return {
    package: packageValue,
    artifactBytes: decodeFormalArtifact(packageValue),
  };
}

function assertString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new FormalPackageError('INVALID_FIELD', `${field} must be a non-empty string`);
  }
}

function isCanonicalBase64(value) {
  if (!BASE64_RE.test(value)) return false;
  return Buffer.from(value, 'base64').toString('base64') === value;
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  throw new FormalPackageError('INVALID_ARTIFACT', 'artifactBytes must be Buffer, Uint8Array, or string');
}
