import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MemoryProjectionError,
  projectMemoryGraph,
} from '../src/memory-projection.mjs';

function lifecycle(lifecycleName, overrides = {}) {
  return {
    state: 'OK',
    artifact_id: overrides.artifact_id ?? null,
    lifecycle: lifecycleName,
    accepted_by: lifecycleName === 'ACCEPTED' ? 'author' : null,
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
  project = 'p',
  subject = artifactId,
  summary = artifactId,
  status = null,
  context = 'v1',
  relations = [],
  semanticProvenance = [],
  lifecycleName = 'ACCEPTED',
  lifecycleOverrides = {},
} = {}) {
  return {
    artifact_id: artifactId,
    kind,
    project,
    subject,
    summary,
    status,
    context,
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
    task: node('task', {
      kind: 'task',
      subject: 'bounded projection implementation',
      summary: 'implement relation native projection',
      status: 'OPEN',
      relations: [{ type: 'depends_on', target: 'decision' }],
      semanticProvenance: ['github:issue/5'],
    }),
    decision: node('decision', {
      subject: 'projection architecture',
      summary: 'use structural dependencies and provenance',
      relations: [{ type: 'evidence', target: 'evidence' }],
      semanticProvenance: ['github:issue/10'],
      lifecycleOverrides: {
        provenance: [{
          event_id: 'decision-accept',
          action: 'accept',
          refs: ['chat:author-approval'],
        }],
      },
    }),
    evidence: node('evidence', {
      kind: 'evidence',
      subject: 'repository evidence',
      summary: 'tests demonstrate structural traversal',
      status: 'ACTIVE',
      lifecycleName: 'OBSERVED',
      semanticProvenance: ['github:commit/example'],
    }),
    old: node('old', {
      subject: 'projection architecture',
      summary: 'old superseded projection plan',
      lifecycleName: 'SUPERSEDED',
      lifecycleOverrides: {
        replacement_artifact_id: 'decision',
      },
    }),
    rejected: node('rejected', {
      kind: 'hypothesis',
      subject: 'vector only projection',
      summary: 'rejected vector-only hypothesis',
      lifecycleName: 'REJECTED',
    }),
  };

  for (let index = 0; index < 24; index += 1) {
    const id = 'noise-' + String(index).padStart(2, '0');
    nodes[id] = node(id, {
      kind: 'note',
      subject: 'projection noise ' + index,
      summary: 'textually similar projection context but structurally disconnected',
    });
  }

  return {
    protocol: 'anet-memory/graph-v1',
    generated_at: 'ignored',
    source: {
      memory_event_source_sha256: 'events-digest',
      semantic_artifact_source_sha256: 'artifact-digest',
    },
    classifications: {},
    nodes,
    missing_semantic_records: [],
    semantic_without_lifecycle: [],
    dangling_relations: [],
  };
}

const roomyBudget = {
  max_nodes: 20,
  max_bytes: 100_000,
};

test('explicit seed projection follows structural dependencies and excludes disconnected noise', () => {
  const graph = graphFixture();
  const before = structuredClone(graph);

  const result = projectMemoryGraph(
    graph,
    {
      project: 'p',
      seed_ids: ['task'],
      terms: ['projection'],
    },
    roomyBudget,
  );

  assert.equal(result.status, 'OK');
  assert.deepEqual(result.seeds.selected, ['task']);
  assert.deepEqual(
    result.nodes.map((item) => item.artifact_id),
    ['task', 'decision', 'evidence'],
  );
  assert.ok(result.nodes.every((item) => !item.artifact_id.startsWith('noise-')));
  assert.equal(result.nodes[2].lifecycle.lifecycle, 'OBSERVED');
  assert.deepEqual(result.nodes[0].semantic_provenance, ['github:issue/5']);
  assert.deepEqual(
    result.nodes[1].lifecycle.provenance[0].refs,
    ['chat:author-approval'],
  );
  assert.ok(result.budget.used_nodes <= result.budget.max_nodes);
  assert.ok(result.budget.used_bytes <= result.budget.max_bytes);
  assert.deepEqual(graph, before);
});

test('default current-state policy redirects superseded explicit seed to replacement', () => {
  const result = projectMemoryGraph(
    graphFixture(),
    {
      project: 'p',
      seed_ids: ['old'],
      terms: [],
    },
    roomyBudget,
  );

  assert.deepEqual(result.seeds.selected, ['decision']);
  assert.deepEqual(result.redirects, [{ from: 'old', to: 'decision' }]);
  assert.deepEqual(
    result.nodes.map((item) => item.artifact_id),
    ['decision', 'evidence'],
  );
});

test('historical policy intentionally retrieves superseded and rejected nodes', () => {
  const oldResult = projectMemoryGraph(
    graphFixture(),
    {
      project: 'p',
      seed_ids: ['old'],
      terms: [],
    },
    roomyBudget,
    {
      include_historical: true,
    },
  );

  assert.deepEqual(
    oldResult.nodes.map((item) => item.artifact_id),
    ['old', 'decision', 'evidence'],
  );
  assert.equal(oldResult.nodes[0].lifecycle.lifecycle, 'SUPERSEDED');

  const rejectedResult = projectMemoryGraph(
    graphFixture(),
    {
      project: 'p',
      seed_ids: ['rejected'],
      terms: [],
    },
    roomyBudget,
    {
      include_historical: true,
    },
  );

  assert.deepEqual(
    rejectedResult.nodes.map((item) => item.artifact_id),
    ['rejected'],
  );
});

test('depth bound exposes deterministic frontier for iterative expansion', () => {
  const depth0 = projectMemoryGraph(
    graphFixture(),
    {
      project: 'p',
      seed_ids: ['task'],
      terms: [],
    },
    roomyBudget,
    {
      max_depth: 0,
    },
  );

  assert.deepEqual(depth0.nodes.map((item) => item.artifact_id), ['task']);
  assert.deepEqual(depth0.frontier, ['decision']);

  const depth1 = projectMemoryGraph(
    graphFixture(),
    {
      project: 'p',
      seed_ids: ['task'],
      terms: [],
    },
    roomyBudget,
    {
      max_depth: 1,
    },
  );

  assert.deepEqual(depth1.nodes.map((item) => item.artifact_id), ['task', 'decision']);
  assert.deepEqual(depth1.frontier, ['evidence']);
});

test('node budget fails closed without exceeding declared limit', () => {
  const result = projectMemoryGraph(
    graphFixture(),
    {
      project: 'p',
      seed_ids: ['task'],
      terms: [],
    },
    {
      max_nodes: 2,
      max_bytes: 100_000,
    },
  );

  assert.deepEqual(result.nodes.map((item) => item.artifact_id), ['task', 'decision']);
  assert.equal(result.budget.used_nodes, 2);
  assert.equal(result.budget.exhausted, true);
  assert.ok(result.omitted.budget.some((item) => item.artifact_id === 'evidence'));
});

test('byte budget can report insufficient projection without partial node overflow', () => {
  const result = projectMemoryGraph(
    graphFixture(),
    {
      project: 'p',
      seed_ids: ['task'],
      terms: [],
    },
    {
      max_nodes: 10,
      max_bytes: 1,
    },
  );

  assert.equal(result.status, 'INSUFFICIENT_BUDGET');
  assert.equal(result.nodes.length, 0);
  assert.equal(result.budget.used_bytes, 0);
  assert.ok(result.omitted.budget.some((item) => item.artifact_id === 'task'));
});

test('terms-only query uses deterministic lexical seeds then structural traversal', () => {
  const graph = graphFixture();

  const first = projectMemoryGraph(
    graph,
    {
      project: 'p',
      seed_ids: [],
      terms: ['bounded', 'implementation'],
    },
    roomyBudget,
    {
      max_seed_candidates: 1,
    },
  );
  const second = projectMemoryGraph(
    graph,
    {
      project: 'p',
      seed_ids: [],
      terms: ['implementation', 'bounded'],
    },
    roomyBudget,
    {
      max_seed_candidates: 1,
    },
  );

  assert.deepEqual(first, second);
  assert.deepEqual(first.seeds.selected, ['task']);
  assert.deepEqual(
    first.nodes.map((item) => item.artifact_id),
    ['task', 'decision', 'evidence'],
  );
});

test('lexical diagnostics remain capped instead of scaling with the full corpus', () => {
  const graph = graphFixture();
  for (let index = 0; index < 500; index += 1) {
    const id = 'bulk-' + String(index).padStart(4, '0');
    graph.nodes[id] = node(id, {
      kind: 'note',
      subject: 'bounded projection implementation noise ' + index,
      summary: 'lexical candidate that must not all be returned',
    });
  }

  const result = projectMemoryGraph(
    graph,
    {
      project: 'p',
      seed_ids: [],
      terms: ['bounded', 'projection'],
    },
    roomyBudget,
    {
      max_seed_candidates: 3,
    },
  );

  assert.equal(result.seeds.lexical_candidates.length, 3);
  assert.ok(result.seeds.lexical_candidate_count > result.seeds.lexical_candidates.length);
  assert.ok(result.seeds.selected.length <= 3);
});


test('rejected and superseded nodes are excluded from default lexical seed generation', () => {
  const result = projectMemoryGraph(
    graphFixture(),
    {
      project: 'p',
      seed_ids: [],
      terms: ['old', 'rejected', 'vector'],
    },
    roomyBudget,
    {
      max_seed_candidates: 10,
    },
  );

  assert.ok(!result.seeds.selected.includes('old'));
  assert.ok(!result.seeds.selected.includes('rejected'));
  assert.ok(result.nodes.every((item) =>
    !['SUPERSEDED', 'REJECTED'].includes(item.lifecycle.lifecycle)
  ));
});

test('observed evidence is traversable but cannot silently become a lexical seed', () => {
  const result = projectMemoryGraph(
    graphFixture(),
    {
      project: 'p',
      seed_ids: [],
      terms: ['repository', 'evidence'],
    },
    roomyBudget,
    {
      max_seed_candidates: 10,
    },
  );

  assert.ok(!result.seeds.selected.includes('evidence'));
});

test('invalid query and budget are rejected explicitly', () => {
  assert.throws(
    () => projectMemoryGraph(graphFixture(), { project: 'p', seed_ids: [], terms: [] }, roomyBudget),
    (error) => error instanceof MemoryProjectionError && error.code === 'EMPTY_QUERY',
  );

  assert.throws(
    () => projectMemoryGraph(
      graphFixture(),
      { project: 'p', seed_ids: ['task'], terms: [] },
      { max_nodes: 0, max_bytes: 100 },
    ),
    (error) => error instanceof MemoryProjectionError && error.code === 'INVALID_FIELD',
  );
});
