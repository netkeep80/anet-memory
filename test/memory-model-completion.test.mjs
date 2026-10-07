import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  appendMemoryArtifact,
  buildMemoryGraph,
  createMemoryArtifact,
  rebuildArtifactCatalog,
} from '../src/memory-artifacts.mjs';
import {
  appendMemoryEvent,
  createMemoryEvent,
  rebuildMemoryState,
} from '../src/memory-events.mjs';
import { projectMemoryGraph } from '../src/memory-projection.mjs';

async function tempRoot() {
  return mkdtemp(path.join(os.tmpdir(), 'anet-memory-model-completion-'));
}

function accepted(eventId, artifactId, second, overrides = {}) {
  return createMemoryEvent({
    eventId,
    artifactId,
    sequence: 1,
    action: 'accept',
    authority: 'author',
    actor: 'user',
    provenance: ['test:memory-model-completion'],
    createdAt: `2026-10-08T01:00:${String(second).padStart(2, '0')}.000Z`,
    ...overrides,
  });
}

function observed(eventId, artifactId, second) {
  return createMemoryEvent({
    eventId,
    artifactId,
    sequence: 1,
    action: 'observe',
    authority: 'external',
    actor: 'test',
    provenance: ['test:memory-model-completion'],
    createdAt: `2026-10-08T01:00:${String(second).padStart(2, '0')}.000Z`,
  });
}

test('one persistent corpus satisfies #4 current-state and history/rationale completion', async (t) => {
  const root = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  const artifacts = [
    createMemoryArtifact({
      artifactId: 'decision-current',
      kind: 'decision',
      project: 'memory-model-completion',
      subject: 'retrieval policy',
      summary: 'current accepted decision',
      status: 'ACTIVE',
      context: 'issue-4-completion',
      relations: [{ type: 'evidence', target: 'evidence-current' }],
      provenance: ['github:issue/4'],
    }),
    createMemoryArtifact({
      artifactId: 'decision-old',
      kind: 'decision',
      project: 'memory-model-completion',
      subject: 'retrieval policy',
      summary: 'superseded historical decision',
      status: 'HISTORICAL',
      context: 'issue-4-completion',
      relations: [{ type: 'evidence', target: 'evidence-old' }],
      provenance: ['github:issue/4'],
    }),
    createMemoryArtifact({
      artifactId: 'hypothesis-rejected',
      kind: 'hypothesis',
      project: 'memory-model-completion',
      subject: 'rejected alternative',
      summary: 'rejected hypothesis retained only for rationale queries',
      status: 'HISTORICAL',
      context: 'issue-4-completion',
      relations: [{ type: 'rejected_by', target: 'decision-reject' }],
      provenance: ['github:issue/4'],
    }),
    createMemoryArtifact({
      artifactId: 'decision-reject',
      kind: 'decision',
      project: 'memory-model-completion',
      subject: 'rejection rationale',
      summary: 'accepted decision explaining why the hypothesis was rejected',
      status: 'ACTIVE',
      context: 'issue-4-completion',
      relations: [{ type: 'evidence', target: 'evidence-reject' }],
      provenance: ['github:issue/4'],
    }),
    createMemoryArtifact({
      artifactId: 'task-open',
      kind: 'task',
      project: 'memory-model-completion',
      subject: 'current open task',
      summary: 'continue work from current accepted state',
      status: 'OPEN',
      context: 'issue-4-completion',
      relations: [
        { type: 'depends_on', target: 'decision-old' },
        { type: 'depends_on', target: 'hypothesis-rejected' },
        { type: 'depends_on', target: 'task-blocked' },
      ],
      provenance: ['github:issue/4'],
    }),
    createMemoryArtifact({
      artifactId: 'task-blocked',
      kind: 'task',
      project: 'memory-model-completion',
      subject: 'blocked task',
      summary: 'blocked until external prerequisite is satisfied',
      status: 'BLOCKED',
      context: 'issue-4-completion',
      relations: [],
      provenance: ['github:issue/4'],
    }),
    createMemoryArtifact({
      artifactId: 'evidence-current',
      kind: 'evidence',
      project: 'memory-model-completion',
      subject: 'current evidence',
      summary: 'supports the current decision',
      status: 'ACTIVE',
      context: 'issue-4-completion',
      relations: [],
      provenance: ['test:evidence-current'],
    }),
    createMemoryArtifact({
      artifactId: 'evidence-old',
      kind: 'evidence',
      project: 'memory-model-completion',
      subject: 'historical evidence',
      summary: 'supports the old decision for rationale recovery',
      status: 'HISTORICAL',
      context: 'issue-4-completion',
      relations: [],
      provenance: ['test:evidence-old'],
    }),
    createMemoryArtifact({
      artifactId: 'evidence-reject',
      kind: 'evidence',
      project: 'memory-model-completion',
      subject: 'rejection evidence',
      summary: 'supports rejection of the historical hypothesis',
      status: 'ACTIVE',
      context: 'issue-4-completion',
      relations: [],
      provenance: ['test:evidence-reject'],
    }),
  ];

  for (const artifact of artifacts) {
    await appendMemoryArtifact(root, artifact);
  }

  const events = [
    accepted('decision-current-1', 'decision-current', 1),
    accepted('decision-old-1', 'decision-old', 2),
    createMemoryEvent({
      eventId: 'decision-old-2',
      artifactId: 'decision-old',
      sequence: 2,
      previousEventId: 'decision-old-1',
      action: 'supersede',
      authority: 'author',
      actor: 'user',
      replacementArtifactId: 'decision-current',
      provenance: ['github:issue/4', 'test:memory-model-completion'],
      createdAt: '2026-10-08T01:00:03.000Z',
    }),
    createMemoryEvent({
      eventId: 'hypothesis-rejected-1',
      artifactId: 'hypothesis-rejected',
      sequence: 1,
      action: 'reject',
      authority: 'author',
      actor: 'user',
      provenance: ['github:issue/4', 'test:memory-model-completion'],
      createdAt: '2026-10-08T01:00:04.000Z',
    }),
    accepted('decision-reject-1', 'decision-reject', 5),
    accepted('task-open-1', 'task-open', 6),
    accepted('task-blocked-1', 'task-blocked', 7),
    observed('evidence-current-1', 'evidence-current', 8),
    observed('evidence-old-1', 'evidence-old', 9),
    observed('evidence-reject-1', 'evidence-reject', 10),
  ];

  for (const event of events) {
    await appendMemoryEvent(root, event);
  }

  const memoryState = await rebuildMemoryState(root);
  const artifactCatalog = await rebuildArtifactCatalog(root);
  const graph = buildMemoryGraph(memoryState, artifactCatalog);

  assert.equal(graph.nodes['decision-current'].lifecycle.lifecycle, 'ACCEPTED');
  assert.equal(graph.nodes['decision-old'].lifecycle.lifecycle, 'SUPERSEDED');
  assert.equal(graph.nodes['hypothesis-rejected'].lifecycle.lifecycle, 'REJECTED');
  assert.equal(graph.nodes['task-open'].status, 'OPEN');
  assert.equal(graph.nodes['task-blocked'].status, 'BLOCKED');
  assert.equal(graph.nodes['evidence-current'].lifecycle.lifecycle, 'OBSERVED');

  const current = projectMemoryGraph(
    graph,
    {
      project: 'memory-model-completion',
      seed_ids: ['task-open'],
      terms: [],
    },
    {
      max_nodes: 8,
      max_bytes: 100_000,
    },
    {
      relation_types: ['depends_on', 'evidence'],
      max_depth: 3,
    },
  );

  const currentIds = current.nodes.map((item) => item.artifact_id);
  assert.deepEqual(currentIds, [
    'task-open',
    'decision-current',
    'task-blocked',
    'evidence-current',
  ]);
  assert.ok(!currentIds.includes('decision-old'));
  assert.ok(!currentIds.includes('hypothesis-rejected'));
  assert.ok(current.redirects.some((item) =>
    item.from === 'decision-old' && item.to === 'decision-current'
  ));
  assert.ok(current.omitted.policy.some((item) =>
    item.artifact_id === 'hypothesis-rejected' &&
    item.reason === 'HISTORICAL_EXCLUDED'
  ));

  const oldHistory = projectMemoryGraph(
    graph,
    {
      project: 'memory-model-completion',
      seed_ids: ['decision-old'],
      terms: [],
    },
    {
      max_nodes: 8,
      max_bytes: 100_000,
    },
    {
      relation_types: ['evidence'],
      include_historical: true,
      max_depth: 3,
    },
  );

  assert.deepEqual(
    oldHistory.nodes.map((item) => item.artifact_id),
    ['decision-old', 'evidence-old', 'decision-current', 'evidence-current'],
  );

  const rejectedHistory = projectMemoryGraph(
    graph,
    {
      project: 'memory-model-completion',
      seed_ids: ['hypothesis-rejected'],
      terms: [],
    },
    {
      max_nodes: 8,
      max_bytes: 100_000,
    },
    {
      relation_types: ['rejected_by', 'evidence'],
      include_historical: true,
      max_depth: 3,
    },
  );

  assert.deepEqual(
    rejectedHistory.nodes.map((item) => item.artifact_id),
    ['hypothesis-rejected', 'decision-reject', 'evidence-reject'],
  );
  assert.ok(rejectedHistory.nodes.every((item) =>
    item.semantic_provenance.length > 0
  ));
});
