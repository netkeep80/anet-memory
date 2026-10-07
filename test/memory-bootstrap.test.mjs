import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MemoryBootstrapError,
  bootstrapMemoryGraph,
  deriveTaskTerms,
} from '../src/memory-bootstrap.mjs';

function lifecycle(name, overrides = {}) {
  return {
    state: 'OK',
    artifact_id: overrides.artifact_id ?? null,
    lifecycle: name,
    accepted_by: name === 'ACCEPTED' ? 'author' : null,
    replacement_artifact_id: null,
    verifications: [],
    authority_errors: [],
    provenance: [],
    events: [],
    last_event_id: null,
    next_sequence: 2,
    duplicate_count: 0,
    ...overrides,
  };
}

function node(artifactId, {
  kind = 'decision',
  project = 'anet-memory',
  subject = artifactId,
  summary = artifactId,
  status = null,
  relations = [],
  lifecycleName = 'ACCEPTED',
  lifecycleOverrides = {},
  semanticProvenance = [],
} = {}) {
  return {
    artifact_id: artifactId,
    kind,
    project,
    subject,
    summary,
    status,
    context: 'bootstrap-test',
    relations,
    semantic_provenance: semanticProvenance,
    lifecycle: lifecycle(lifecycleName, {
      artifact_id: artifactId,
      ...lifecycleOverrides,
    }),
  };
}

function graphFixture() {
  const nodes = {
    'task-bootstrap': node('task-bootstrap', {
      kind: 'task',
      subject: 'fresh chat bootstrap continuation',
      summary: 'continue project development without manual handoff',
      status: 'OPEN',
      relations: [
        { type: 'depends_on', target: 'decision-current' },
        { type: 'depends_on', target: 'task-blocked' },
      ],
      semanticProvenance: ['github:issue/6'],
    }),
    'decision-current': node('decision-current', {
      kind: 'decision',
      subject: 'bootstrap source of truth',
      summary: 'use current accepted relation-native memory',
      relations: [{ type: 'evidence', target: 'evidence-ci' }],
      semanticProvenance: ['github:issue/1'],
    }),
    'task-blocked': node('task-blocked', {
      kind: 'task',
      subject: 'external acceptance gate',
      summary: 'real fresh chat experiment is still required',
      status: 'BLOCKED',
      relations: [],
      semanticProvenance: ['github:issue/6'],
    }),
    'evidence-ci': node('evidence-ci', {
      kind: 'evidence',
      subject: 'current implementation evidence',
      summary: 'CI passed structural bootstrap prerequisites',
      status: 'ACTIVE',
      lifecycleName: 'OBSERVED',
      semanticProvenance: ['github:actions/success'],
    }),
    'decision-old': node('decision-old', {
      kind: 'decision',
      subject: 'bootstrap source of truth',
      summary: 'replay the giant historical transcript',
      lifecycleName: 'SUPERSEDED',
      lifecycleOverrides: {
        replacement_artifact_id: 'decision-current',
      },
    }),
    'hypothesis-rejected': node('hypothesis-rejected', {
      kind: 'claim',
      subject: 'fresh chat bootstrap continuation',
      summary: 'raw transcript is required for every new chat',
      lifecycleName: 'REJECTED',
    }),
  };

  for (let index = 0; index < 40; index += 1) {
    const id = 'noise-' + String(index).padStart(2, '0');
    nodes[id] = node(id, {
      kind: 'note',
      subject: 'fresh chat bootstrap noise',
      summary: 'historically related but structurally disconnected note ' + index,
    });
  }

  return {
    protocol: 'anet-memory/graph-v1',
    generated_at: 'ignored',
    source: {
      memory_event_source_sha256: 'event-digest',
      semantic_artifact_source_sha256: 'artifact-digest',
    },
    classifications: {},
    nodes,
    missing_semantic_records: [],
    semantic_without_lifecycle: [],
    dangling_relations: [],
  };
}

test('task terms are Unicode-aware, deterministic and explicitly bounded', () => {
  assert.deepEqual(
    deriveTaskTerms('Продолжить MTS v0.15 acceptance: продолжить проект', 8),
    ['продолжить', 'mts', 'v0.15', 'acceptance:', 'проект'],
  );

  assert.throws(
    () => deriveTaskTerms('x', 0),
    (error) => error instanceof MemoryBootstrapError && error.code === 'INVALID_TERM_LIMIT',
  );
});

test('fresh-chat bootstrap groups one bounded current structural working set', () => {
  const graph = graphFixture();
  const before = structuredClone(graph);

  const result = bootstrapMemoryGraph(
    graph,
    {
      project: 'anet-memory',
      task: 'fresh chat bootstrap continuation',
      seed_ids: [],
    },
    {
      max_nodes: 4,
      max_bytes: 100_000,
    },
    {
      max_seed_candidates: 1,
    },
  );

  assert.equal(result.protocol, 'anet-memory/bootstrap-v1');
  assert.equal(result.status, 'OK');
  assert.deepEqual(result.seeds.selected, ['task-bootstrap']);
  assert.deepEqual(
    result.working_set.tasks.open.map((item) => item.artifact_id),
    ['task-bootstrap'],
  );
  assert.deepEqual(
    result.working_set.tasks.blocked.map((item) => item.artifact_id),
    ['task-blocked'],
  );
  assert.deepEqual(
    result.working_set.decisions.map((item) => item.artifact_id),
    ['decision-current'],
  );
  assert.deepEqual(
    result.working_set.evidence.map((item) => item.artifact_id),
    ['evidence-ci'],
  );
  assert.equal(result.budget.used_nodes, 4);
  assert.ok(result.budget.used_bytes <= result.budget.max_bytes);
  assert.deepEqual(graph, before);
});

test('current bootstrap resists rejected and superseded history pollution', () => {
  const result = bootstrapMemoryGraph(
    graphFixture(),
    {
      project: 'anet-memory',
      task: 'fresh chat bootstrap continuation raw transcript',
      seed_ids: [],
    },
    {
      max_nodes: 10,
      max_bytes: 100_000,
    },
    {
      max_seed_candidates: 2,
    },
  );

  const ids = [
    ...result.working_set.decisions,
    ...result.working_set.tasks.open,
    ...result.working_set.tasks.blocked,
    ...result.working_set.tasks.other,
    ...result.working_set.evidence,
    ...result.working_set.claims,
    ...result.working_set.other,
  ].map((item) => item.artifact_id);

  assert.ok(!ids.includes('decision-old'));
  assert.ok(!ids.includes('hypothesis-rejected'));
  assert.ok(ids.includes('task-bootstrap'));
});

test('explicit task seed suppresses unrelated lexical augmentation by default', () => {
  const result = bootstrapMemoryGraph(
    graphFixture(),
    {
      project: 'anet-memory',
      task: 'fresh chat bootstrap noise',
      seed_ids: ['task-bootstrap'],
    },
    {
      max_nodes: 4,
      max_bytes: 100_000,
    },
  );

  assert.deepEqual(result.seeds.selected, ['task-bootstrap']);
  assert.equal(result.seeds.lexical_candidates.length, 0);
  assert.deepEqual(
    result.working_set.other.map((item) => item.artifact_id),
    [],
  );
});

test('bootstrap preserves explicit frontier when depth policy requests less context', () => {
  const result = bootstrapMemoryGraph(
    graphFixture(),
    {
      project: 'anet-memory',
      task: 'fresh chat bootstrap continuation',
      seed_ids: ['task-bootstrap'],
    },
    {
      max_nodes: 4,
      max_bytes: 100_000,
    },
    {
      max_depth: 0,
    },
  );

  assert.deepEqual(
    result.working_set.tasks.open.map((item) => item.artifact_id),
    ['task-bootstrap'],
  );
  assert.deepEqual(result.frontier, ['decision-current', 'task-blocked']);
});

test('bootstrap rejects empty or unbounded task text instead of becoming a transcript carrier', () => {
  assert.throws(
    () => bootstrapMemoryGraph(
      graphFixture(),
      { project: 'anet-memory', task: '', seed_ids: [] },
      { max_nodes: 4, max_bytes: 100_000 },
    ),
    (error) => error instanceof MemoryBootstrapError && error.code === 'INVALID_TASK',
  );

  assert.throws(
    () => bootstrapMemoryGraph(
      graphFixture(),
      { project: 'anet-memory', task: 'x'.repeat(4097), seed_ids: [] },
      { max_nodes: 4, max_bytes: 100_000 },
    ),
    (error) => error instanceof MemoryBootstrapError && error.code === 'INVALID_TASK',
  );
});
