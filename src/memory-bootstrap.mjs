import { projectMemoryGraph } from './memory-projection.mjs';

export const MEMORY_BOOTSTRAP_PROTOCOL = 'anet-memory/bootstrap-v1';

const DEFAULT_MAX_TASK_TERMS = 16;
const MAX_TASK_LENGTH = 4096;

export class MemoryBootstrapError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MemoryBootstrapError';
    this.code = code;
    this.details = details;
  }
}

export function bootstrapMemoryGraph(
  graph,
  request,
  budget,
  policy = {},
  { maxTaskTerms = DEFAULT_MAX_TASK_TERMS } = {},
) {
  const normalized = normalizeBootstrapRequest(request, maxTaskTerms);

  const projection = projectMemoryGraph(
    graph,
    {
      project: normalized.project,
      seed_ids: normalized.seed_ids,
      terms: normalized.task_terms,
    },
    budget,
    {
      max_seed_candidates: 1,
      ...policy,
    },
  );

  const workingSet = {
    decisions: [],
    tasks: {
      open: [],
      blocked: [],
      other: [],
    },
    evidence: [],
    claims: [],
    other: [],
  };

  for (const node of projection.nodes) {
    if (node.kind === 'decision') {
      workingSet.decisions.push(node);
    } else if (node.kind === 'task') {
      if (node.status === 'OPEN') workingSet.tasks.open.push(node);
      else if (node.status === 'BLOCKED') workingSet.tasks.blocked.push(node);
      else workingSet.tasks.other.push(node);
    } else if (node.kind === 'evidence') {
      workingSet.evidence.push(node);
    } else if (node.kind === 'claim') {
      workingSet.claims.push(node);
    } else {
      workingSet.other.push(node);
    }
  }

  return {
    protocol: MEMORY_BOOTSTRAP_PROTOCOL,
    source: projection.source,
    status: projection.status,
    project: normalized.project,
    task: normalized.task,
    task_terms: normalized.task_terms,
    projection_policy: projection.policy,
    budget: projection.budget,
    seeds: projection.seeds,
    working_set: workingSet,
    frontier: projection.frontier,
    redirects: projection.redirects,
    omitted: projection.omitted,
  };
}

export function deriveTaskTerms(task, maxTerms = DEFAULT_MAX_TASK_TERMS) {
  if (typeof task !== 'string' || task.length === 0 || task.length > MAX_TASK_LENGTH) {
    throw new MemoryBootstrapError(
      'INVALID_TASK',
      'task must be a non-empty string no longer than ' + MAX_TASK_LENGTH + ' characters',
    );
  }
  if (!Number.isSafeInteger(maxTerms) || maxTerms < 1 || maxTerms > 64) {
    throw new MemoryBootstrapError(
      'INVALID_TERM_LIMIT',
      'maxTaskTerms must be a safe integer between 1 and 64',
    );
  }

  const normalized = task.normalize('NFKC').toLocaleLowerCase('en-US');
  const tokens = normalized.match(/[\p{L}\p{N}][\p{L}\p{N}._-]*/gu) ?? [];
  const unique = [];
  const seen = new Set();

  for (const token of tokens) {
    if (token.length < 2 || seen.has(token)) continue;
    seen.add(token);
    unique.push(token);
    if (unique.length >= maxTerms) break;
  }

  return unique;
}

function normalizeBootstrapRequest(request, maxTaskTerms) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new MemoryBootstrapError('INVALID_REQUEST', 'bootstrap request must be an object');
  }
  if (typeof request.project !== 'string' || request.project.length === 0) {
    throw new MemoryBootstrapError(
      'INVALID_PROJECT',
      'request.project must be a non-empty string',
    );
  }

  const seedIds = request.seed_ids ?? [];
  if (!Array.isArray(seedIds) ||
      seedIds.some((value) => typeof value !== 'string' || value.length === 0)) {
    throw new MemoryBootstrapError(
      'INVALID_SEEDS',
      'request.seed_ids must be an array of non-empty strings',
    );
  }

  const terms = deriveTaskTerms(request.task, maxTaskTerms);
  if (seedIds.length === 0 && terms.length === 0) {
    throw new MemoryBootstrapError(
      'NO_BOOTSTRAP_SEED',
      'task did not produce usable terms and no explicit seed_ids were supplied',
    );
  }

  return {
    project: request.project,
    task: request.task,
    seed_ids: uniquePreserveOrder(seedIds),
    task_terms: terms,
  };
}

function uniquePreserveOrder(values) {
  const output = [];
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    output.push(value);
  }
  return output;
}
