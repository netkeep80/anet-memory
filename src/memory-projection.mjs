export const MEMORY_PROJECTION_PROTOCOL = 'anet-memory/projection-v1';

const DEFAULT_POLICY = Object.freeze({
  relation_types: ['depends_on', 'evidence'],
  max_depth: 3,
  include_historical: false,
  include_proposed: false,
  allow_observed_targets: true,
  follow_supersession: true,
  augment_explicit_seeds: false,
  max_seed_candidates: 8,
});

export class MemoryProjectionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MemoryProjectionError';
    this.code = code;
    this.details = details;
  }
}

export function projectMemoryGraph(graph, query, budget, policy = {}) {
  validateGraph(graph);
  const normalizedQuery = normalizeQuery(query);
  const normalizedBudget = normalizeBudget(budget);
  const normalizedPolicy = normalizePolicy(policy);

  const graphBefore = stableJson(graph);
  const seedResolution = resolveSeeds(graph, normalizedQuery, normalizedPolicy);

  const selected = [];
  const selectedIds = new Set();
  const queuedIds = new Set();
  const queue = [];
  const omittedBudget = [];
  const omittedPolicy = [...seedResolution.filtered];
  const unresolved = [...seedResolution.unresolved];
  const redirects = [...seedResolution.redirects];
  const frontier = new Set();

  for (const seedId of seedResolution.selected) {
    enqueue(queue, queuedIds, {
      artifact_id: seedId,
      depth: 0,
      via: null,
      seed: true,
    });
  }

  let usedBytes = 0;

  while (queue.length > 0) {
    const item = queue.shift();
    queuedIds.delete(item.artifact_id);
    if (selectedIds.has(item.artifact_id)) continue;

    const node = graph.nodes[item.artifact_id];
    if (!node) {
      unresolved.push({
        artifact_id: item.artifact_id,
        reason: 'MISSING_NODE',
        via: item.via,
      });
      continue;
    }

    const eligibility = targetEligibility(node, normalizedQuery, normalizedPolicy, item.seed);
    if (!eligibility.allowed) {
      omittedPolicy.push({
        artifact_id: item.artifact_id,
        reason: eligibility.reason,
        via: item.via,
      });
      continue;
    }

    const projectedNode = normalizeProjectedNode(node);
    const costBytes = jsonBytes(projectedNode);

    if (selected.length >= normalizedBudget.max_nodes ||
        usedBytes + costBytes > normalizedBudget.max_bytes) {
      omittedBudget.push({
        artifact_id: item.artifact_id,
        cost_bytes: costBytes,
        depth: item.depth,
        via: item.via,
      });
      continue;
    }

    selected.push(projectedNode);
    selectedIds.add(item.artifact_id);
    usedBytes += costBytes;

    const expansion = outgoingExpansion(
      graph,
      node,
      normalizedQuery,
      normalizedPolicy,
    );

    redirects.push(...expansion.redirects);
    unresolved.push(...expansion.unresolved);
    omittedPolicy.push(...expansion.filtered);

    if (item.depth >= normalizedPolicy.max_depth) {
      for (const edge of expansion.edges) {
        if (!selectedIds.has(edge.target)) frontier.add(edge.target);
      }
      continue;
    }

    for (const edge of expansion.edges) {
      enqueue(queue, queuedIds, {
        artifact_id: edge.target,
        depth: item.depth + 1,
        via: {
          source: node.artifact_id,
          type: edge.type,
          requested_target: edge.requested_target,
        },
        seed: false,
      });
    }
  }

  const status = selected.length > 0
    ? 'OK'
    : seedResolution.selected.length === 0
      ? 'NO_SEEDS'
      : 'INSUFFICIENT_BUDGET';

  const result = {
    protocol: MEMORY_PROJECTION_PROTOCOL,
    source: {
      graph_protocol: graph.protocol,
      memory_event_source_sha256: graph.source?.memory_event_source_sha256 ?? null,
      semantic_artifact_source_sha256: graph.source?.semantic_artifact_source_sha256 ?? null,
    },
    status,
    query: normalizedQuery,
    policy: normalizedPolicy,
    budget: {
      metric: 'utf8-json-node-bytes',
      max_nodes: normalizedBudget.max_nodes,
      max_bytes: normalizedBudget.max_bytes,
      used_nodes: selected.length,
      used_bytes: usedBytes,
      exhausted: omittedBudget.length > 0,
    },
    seeds: {
      requested: normalizedQuery.seed_ids,
      lexical_terms: normalizedQuery.terms,
      selected: seedResolution.selected,
      lexical_candidates: seedResolution.lexicalCandidates,
      lexical_candidate_count: seedResolution.lexicalCandidateCount,
    },
    nodes: selected,
    frontier: [...frontier].sort(),
    redirects: dedupeObjects(redirects),
    omitted: {
      budget: dedupeObjects(omittedBudget),
      policy: dedupeObjects(omittedPolicy),
      unresolved: dedupeObjects(unresolved),
    },
  };

  if (stableJson(graph) !== graphBefore) {
    throw new MemoryProjectionError(
      'GRAPH_MUTATED',
      'projection must be side-effect-free and must not mutate the input graph',
    );
  }

  return result;
}

function resolveSeeds(graph, query, policy) {
  const selected = [];
  const selectedSet = new Set();
  const filtered = [];
  const unresolved = [];
  const redirects = [];

  for (const requested of query.seed_ids) {
    const resolved = resolveCurrentTarget(graph, requested, query, policy);
    redirects.push(...resolved.redirects);

    if (!resolved.artifact_id) {
      unresolved.push({
        artifact_id: requested,
        reason: resolved.reason,
        via: null,
      });
      continue;
    }

    const node = graph.nodes[resolved.artifact_id];
    const eligibility = targetEligibility(node, query, policy, true);
    if (!eligibility.allowed) {
      filtered.push({
        artifact_id: resolved.artifact_id,
        requested_artifact_id: requested,
        reason: eligibility.reason,
        via: null,
      });
      continue;
    }

    if (!selectedSet.has(resolved.artifact_id)) {
      selected.push(resolved.artifact_id);
      selectedSet.add(resolved.artifact_id);
    }
  }

  const shouldUseLexical = query.terms.length > 0 &&
    (query.seed_ids.length === 0 || policy.augment_explicit_seeds);

  const allLexicalCandidates = shouldUseLexical
    ? lexicalSeedCandidates(graph, query, policy)
    : [];
  const lexicalCandidates = allLexicalCandidates.slice(0, policy.max_seed_candidates);

  for (const candidate of lexicalCandidates) {
    if (!selectedSet.has(candidate.artifact_id)) {
      selected.push(candidate.artifact_id);
      selectedSet.add(candidate.artifact_id);
    }
  }

  return {
    selected,
    lexicalCandidates,
    lexicalCandidateCount: allLexicalCandidates.length,
    filtered,
    unresolved,
    redirects,
  };
}

function lexicalSeedCandidates(graph, query, policy) {
  const candidates = [];

  for (const artifactId of Object.keys(graph.nodes).sort()) {
    const node = graph.nodes[artifactId];
    const eligibility = targetEligibility(node, query, policy, true);
    if (!eligibility.allowed) continue;

    const haystack = [
      node.artifact_id,
      node.kind,
      node.project,
      node.subject,
      node.summary,
      node.status,
      node.context,
    ]
      .filter((value) => typeof value === 'string')
      .join('\n')
      .toLocaleLowerCase('en-US');

    let score = 0;
    for (const term of query.terms) {
      if (haystack.includes(term)) score += 1;
    }
    if (score > 0) candidates.push({ artifact_id: artifactId, score });
  }

  return candidates.sort((a, b) => b.score - a.score || a.artifact_id.localeCompare(b.artifact_id));
}

function outgoingExpansion(graph, node, query, policy) {
  const edges = [];
  const redirects = [];
  const unresolved = [];
  const filtered = [];

  const relations = [...(node.relations ?? [])]
    .filter((relation) => policy.relation_types.includes(relation.type))
    .sort((a, b) => a.type.localeCompare(b.type) || a.target.localeCompare(b.target));

  for (const relation of relations) {
    const resolved = resolveCurrentTarget(graph, relation.target, query, policy);
    redirects.push(...resolved.redirects.map((item) => ({
      ...item,
      source: node.artifact_id,
      relation_type: relation.type,
    })));

    if (!resolved.artifact_id) {
      unresolved.push({
        artifact_id: relation.target,
        reason: resolved.reason,
        via: {
          source: node.artifact_id,
          type: relation.type,
        },
      });
      continue;
    }

    const target = graph.nodes[resolved.artifact_id];
    const eligibility = targetEligibility(target, query, policy, false);
    if (!eligibility.allowed) {
      filtered.push({
        artifact_id: resolved.artifact_id,
        reason: eligibility.reason,
        via: {
          source: node.artifact_id,
          type: relation.type,
          requested_target: relation.target,
        },
      });
      continue;
    }

    edges.push({
      type: relation.type,
      requested_target: relation.target,
      target: resolved.artifact_id,
    });
  }

  if (node.lifecycle?.state === 'OK' &&
      node.lifecycle?.lifecycle === 'SUPERSEDED' &&
      policy.follow_supersession &&
      node.lifecycle?.replacement_artifact_id) {
    const replacement = resolveCurrentTarget(
      graph,
      node.lifecycle.replacement_artifact_id,
      query,
      { ...policy, include_historical: false },
    );
    redirects.push(...replacement.redirects);

    if (replacement.artifact_id) {
      const target = graph.nodes[replacement.artifact_id];
      const eligibility = targetEligibility(target, query, policy, false);
      if (eligibility.allowed) {
        edges.push({
          type: 'superseded_by',
          requested_target: node.lifecycle.replacement_artifact_id,
          target: replacement.artifact_id,
        });
      } else {
        filtered.push({
          artifact_id: replacement.artifact_id,
          reason: eligibility.reason,
          via: {
            source: node.artifact_id,
            type: 'superseded_by',
          },
        });
      }
    } else {
      unresolved.push({
        artifact_id: node.lifecycle.replacement_artifact_id,
        reason: replacement.reason,
        via: {
          source: node.artifact_id,
          type: 'superseded_by',
        },
      });
    }
  }

  edges.sort((a, b) =>
    a.type.localeCompare(b.type) ||
    a.target.localeCompare(b.target) ||
    a.requested_target.localeCompare(b.requested_target)
  );

  return { edges, redirects, unresolved, filtered };
}

function resolveCurrentTarget(graph, requestedId, query, policy) {
  if (!graph.nodes[requestedId]) {
    return {
      artifact_id: null,
      reason: 'MISSING_NODE',
      redirects: [],
    };
  }

  if (policy.include_historical || !policy.follow_supersession) {
    return { artifact_id: requestedId, reason: null, redirects: [] };
  }

  let current = requestedId;
  const seen = new Set();
  const redirects = [];

  while (true) {
    if (seen.has(current)) {
      return {
        artifact_id: null,
        reason: 'SUPERSESSION_CYCLE',
        redirects,
      };
    }
    seen.add(current);

    const node = graph.nodes[current];
    if (!node) {
      return {
        artifact_id: null,
        reason: 'MISSING_NODE',
        redirects,
      };
    }

    if (node.lifecycle?.state !== 'OK' ||
        node.lifecycle?.lifecycle !== 'SUPERSEDED') {
      return { artifact_id: current, reason: null, redirects };
    }

    const replacement = node.lifecycle?.replacement_artifact_id;
    if (!replacement || !graph.nodes[replacement]) {
      return {
        artifact_id: null,
        reason: 'MISSING_SUPERSESSION_REPLACEMENT',
        redirects,
      };
    }

    redirects.push({ from: current, to: replacement });
    current = replacement;
  }
}

function targetEligibility(node, query, policy, seed) {
  if (!node) return { allowed: false, reason: 'MISSING_NODE' };
  if (node.project !== query.project) {
    return { allowed: false, reason: 'PROJECT_MISMATCH' };
  }

  const lifecycle = node.lifecycle;
  if (!lifecycle) return { allowed: false, reason: 'MISSING_LIFECYCLE' };
  if (lifecycle.state !== 'OK') {
    return { allowed: false, reason: 'LIFECYCLE_ATTENTION' };
  }

  switch (lifecycle.lifecycle) {
    case 'ACCEPTED':
      return { allowed: true, reason: null };
    case 'OBSERVED':
      return seed
        ? { allowed: false, reason: 'OBSERVED_NOT_SEED' }
        : policy.allow_observed_targets
          ? { allowed: true, reason: null }
          : { allowed: false, reason: 'OBSERVED_TARGET_DISABLED' };
    case 'PROPOSED':
    case 'UNKNOWN':
      return policy.include_proposed
        ? { allowed: true, reason: null }
        : { allowed: false, reason: 'PROPOSED_EXCLUDED' };
    case 'REJECTED':
    case 'SUPERSEDED':
      return policy.include_historical
        ? { allowed: true, reason: null }
        : { allowed: false, reason: 'HISTORICAL_EXCLUDED' };
    default:
      return { allowed: false, reason: 'UNSUPPORTED_LIFECYCLE' };
  }
}

function normalizeProjectedNode(node) {
  const lifecycle = node.lifecycle ?? null;
  return {
    artifact_id: node.artifact_id,
    kind: node.kind,
    project: node.project,
    subject: node.subject,
    summary: node.summary,
    status: node.status,
    context: node.context,
    relations: [...(node.relations ?? [])]
      .map((relation) => ({ type: relation.type, target: relation.target }))
      .sort((a, b) => a.type.localeCompare(b.type) || a.target.localeCompare(b.target)),
    semantic_provenance: [...(node.semantic_provenance ?? [])].sort(),
    lifecycle: lifecycle ? {
      state: lifecycle.state,
      lifecycle: lifecycle.lifecycle,
      accepted_by: lifecycle.accepted_by ?? null,
      replacement_artifact_id: lifecycle.replacement_artifact_id ?? null,
      last_event_id: lifecycle.last_event_id ?? null,
      verifications: [...(lifecycle.verifications ?? [])],
      provenance: [...(lifecycle.provenance ?? [])],
      authority_errors: [...(lifecycle.authority_errors ?? [])],
    } : null,
  };
}

function normalizeQuery(query) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw new MemoryProjectionError('INVALID_QUERY', 'query must be an object');
  }
  if (typeof query.project !== 'string' || query.project.length === 0) {
    throw new MemoryProjectionError('INVALID_QUERY', 'query.project must be a non-empty string');
  }

  const seedIds = normalizeStringArray(query.seed_ids ?? [], 'query.seed_ids', false);
  const terms = normalizeStringArray(query.terms ?? [], 'query.terms', true)
    .map((value) => value.toLocaleLowerCase('en-US'));

  if (seedIds.length === 0 && terms.length === 0) {
    throw new MemoryProjectionError(
      'EMPTY_QUERY',
      'query must contain at least one seed_id or lexical term',
    );
  }

  return {
    project: query.project,
    seed_ids: uniquePreserveOrder(seedIds),
    terms: [...new Set(terms)].sort(),
  };
}

function normalizeBudget(budget) {
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)) {
    throw new MemoryProjectionError('INVALID_BUDGET', 'budget must be an object');
  }
  assertPositiveInteger(budget.max_nodes, 'budget.max_nodes');
  assertPositiveInteger(budget.max_bytes, 'budget.max_bytes');
  return {
    max_nodes: budget.max_nodes,
    max_bytes: budget.max_bytes,
  };
}

function normalizePolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new MemoryProjectionError('INVALID_POLICY', 'policy must be an object');
  }

  const merged = { ...DEFAULT_POLICY, ...policy };
  const relationTypes = normalizeStringArray(
    merged.relation_types,
    'policy.relation_types',
    false,
  );

  if (!Number.isSafeInteger(merged.max_depth) || merged.max_depth < 0) {
    throw new MemoryProjectionError(
      'INVALID_POLICY',
      'policy.max_depth must be a non-negative safe integer',
    );
  }
  assertPositiveInteger(merged.max_seed_candidates, 'policy.max_seed_candidates');

  for (const key of [
    'include_historical',
    'include_proposed',
    'allow_observed_targets',
    'follow_supersession',
    'augment_explicit_seeds',
  ]) {
    if (typeof merged[key] !== 'boolean') {
      throw new MemoryProjectionError('INVALID_POLICY', 'policy.' + key + ' must be boolean');
    }
  }

  return {
    relation_types: [...new Set(relationTypes)].sort(),
    max_depth: merged.max_depth,
    include_historical: merged.include_historical,
    include_proposed: merged.include_proposed,
    allow_observed_targets: merged.allow_observed_targets,
    follow_supersession: merged.follow_supersession,
    augment_explicit_seeds: merged.augment_explicit_seeds,
    max_seed_candidates: merged.max_seed_candidates,
  };
}

function validateGraph(graph) {
  if (!graph || graph.protocol !== 'anet-memory/graph-v1') {
    throw new MemoryProjectionError(
      'INVALID_GRAPH',
      'graph must be an anet-memory/graph-v1 value',
    );
  }
  if (!graph.nodes || typeof graph.nodes !== 'object' || Array.isArray(graph.nodes)) {
    throw new MemoryProjectionError('INVALID_GRAPH', 'graph.nodes must be an object');
  }
}

function normalizeStringArray(value, field, trim) {
  if (!Array.isArray(value)) {
    throw new MemoryProjectionError('INVALID_FIELD', field + ' must be an array');
  }

  return value.map((item) => {
    if (typeof item !== 'string') {
      throw new MemoryProjectionError('INVALID_FIELD', field + ' must contain strings');
    }
    const normalized = trim ? item.trim() : item;
    if (normalized.length === 0) {
      throw new MemoryProjectionError('INVALID_FIELD', field + ' must not contain empty strings');
    }
    return normalized;
  });
}

function enqueue(queue, queuedIds, item) {
  if (queuedIds.has(item.artifact_id)) return;
  queue.push(item);
  queuedIds.add(item.artifact_id);
}

function uniquePreserveOrder(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    output.push(value);
  }
  return output;
}

function assertPositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new MemoryProjectionError('INVALID_FIELD', field + ' must be a positive safe integer');
  }
}

function jsonBytes(value) {
  return Buffer.byteLength(stableJson(value), 'utf8');
}

function dedupeObjects(values) {
  const byJson = new Map();
  for (const value of values) byJson.set(stableJson(value), value);
  return [...byJson.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, value]) => value);
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
