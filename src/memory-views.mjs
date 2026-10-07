import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { rebuildMemoryState } from './memory-events.mjs';

export const MEMORY_VIEW_PROTOCOL = 'anet-memory/views-v1';

export function buildMemoryViews(memoryState, { generatedAt = new Date().toISOString() } = {}) {
  if (!memoryState || memoryState.protocol !== 'anet-memory/state-v1') {
    throw new Error('memoryState must be an anet-memory/state-v1 value');
  }

  const accepted = [];
  const candidates = [];
  const rejected = [];
  const superseded = [];
  const attention = [];

  for (const [artifactId, artifact] of Object.entries(memoryState.artifacts).sort(([a], [b]) => a.localeCompare(b))) {
    const summary = summarizeArtifact(artifactId, artifact);

    if (artifact.state !== 'OK') {
      attention.push(summary);
      continue;
    }

    switch (artifact.lifecycle) {
      case 'ACCEPTED':
        accepted.push(summary);
        break;
      case 'PROPOSED':
      case 'OBSERVED':
      case 'UNKNOWN':
        candidates.push(summary);
        break;
      case 'REJECTED':
        rejected.push(summary);
        break;
      case 'SUPERSEDED':
        superseded.push(summary);
        break;
      default:
        attention.push(summary);
        break;
    }
  }

  return {
    protocol: MEMORY_VIEW_PROTOCOL,
    generated_at: generatedAt,
    source: {
      protocol: memoryState.protocol,
      journal_files: memoryState.journal.files,
      journal_source_sha256: memoryState.journal.source_sha256,
      invalid_events: memoryState.journal.invalid_events,
    },
    current: {
      accepted,
      candidates,
    },
    historical: {
      rejected,
      superseded,
    },
    attention,
  };
}

export async function rebuildMemoryViews(root, { now = () => new Date().toISOString() } = {}) {
  const memoryState = await rebuildMemoryState(root, { now });
  const view = buildMemoryViews(memoryState, { generatedAt: now() });

  const destination = path.join(path.resolve(root), 'views', 'memory-current.json');
  await atomicWrite(destination, `${JSON.stringify(view, null, 2)}\n`);
  return view;
}

export function isMemoryViewFresh(view, memoryState) {
  return Boolean(
    view &&
    memoryState &&
    view.protocol === MEMORY_VIEW_PROTOCOL &&
    memoryState.protocol === 'anet-memory/state-v1' &&
    view.source?.journal_source_sha256 === memoryState.journal?.source_sha256
  );
}

function summarizeArtifact(artifactId, artifact) {
  return {
    artifact_id: artifactId,
    state: artifact.state,
    lifecycle: artifact.lifecycle,
    accepted_by: artifact.accepted_by ?? null,
    replacement_artifact_id: artifact.replacement_artifact_id ?? null,
    last_event_id: artifact.last_event_id ?? null,
    next_sequence: artifact.next_sequence ?? null,
    verifications: artifact.verifications ?? [],
    provenance: artifact.provenance ?? [],
    authority_errors: artifact.authority_errors ?? [],
  };
}

async function atomicWrite(destination, content) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, content);
  await rename(temporary, destination);
}
