#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const OVERSIZED_PROJECTION_VERIFY_PROTOCOL =
  'anet-memory/oversized-projection-verification/1';

async function main(argv) {
  const args = parseArgs(argv);
  const runId = required(args, 'run-id');
  const meta = JSON.parse(await readFile(required(args, 'meta'), 'utf8'));
  const shallowBytes = await readFile(required(args, 'shallow'));
  const expandedBytes = await readFile(required(args, 'expanded'));
  const shallowWrapper = JSON.parse(shallowBytes.toString('utf8'));
  const expandedWrapper = JSON.parse(expandedBytes.toString('utf8'));

  if (meta.protocol !== 'anet-memory/oversized-projection-benchmark-meta/1') {
    throw new Error('unexpected benchmark meta protocol');
  }
  if (meta.run_id !== runId) throw new Error('meta run_id mismatch');

  const shallow = shallowWrapper.projection;
  const expanded = expandedWrapper.projection;
  const root = runId + '-task';
  const oldDecision = runId + '-d-old';
  const currentDecision = runId + '-d-current';
  const rejected = runId + '-r-rejected';
  const evidence = runId + '-e-current';

  if (meta.corpus_bytes < meta.query.expanded.max_bytes * 10) {
    throw new Error('corpus is not at least 10x expanded projection budget');
  }

  assertIds(shallow.nodes, [root], 'shallow nodes');
  if (!shallow.frontier.includes(currentDecision)) {
    throw new Error('shallow frontier does not expose current decision');
  }
  if (!shallow.redirects.some((item) =>
    item.from === oldDecision && item.to === currentDecision
  )) {
    throw new Error('shallow projection lacks old->current redirect');
  }
  if (!shallow.omitted.policy.some((item) =>
    item.artifact_id === rejected && item.reason === 'HISTORICAL_EXCLUDED'
  )) {
    throw new Error('shallow projection lacks rejected historical exclusion');
  }
  if (shallow.nodes.some((item) =>
    item.summary.includes('AUTHORITATIVE_VERDICT=') ||
    item.summary.includes('AUTHORITATIVE_EVIDENCE_TOKEN=')
  )) {
    throw new Error('shallow projection leaked authoritative answer');
  }

  assertIds(expanded.nodes, [root, currentDecision, evidence], 'expanded nodes');
  if (expanded.nodes.some((item) => item.artifact_id.includes('-noise-'))) {
    throw new Error('expanded projection contains distractor node');
  }
  if (expanded.budget.used_nodes > meta.query.expanded.max_nodes ||
      expanded.budget.used_bytes > meta.query.expanded.max_bytes) {
    throw new Error('expanded projection exceeded declared budget');
  }
  if (expanded.omitted.budget.length !== 0 ||
      expanded.omitted.unresolved.length !== 0 ||
      expanded.frontier.length !== 0) {
    throw new Error('expanded projection has unexpected frontier/omission');
  }

  const decisionNode = expanded.nodes.find((item) =>
    item.artifact_id === currentDecision
  );
  const evidenceNode = expanded.nodes.find((item) =>
    item.artifact_id === evidence
  );

  const verdict = extractValue(decisionNode.summary, 'AUTHORITATIVE_VERDICT');
  const evidenceToken = extractValue(
    evidenceNode.summary,
    'AUTHORITATIVE_EVIDENCE_TOKEN',
  );
  const derivedCommitment = sha256(Buffer.from(JSON.stringify({
    evidence_token: evidenceToken,
    verdict,
  }), 'utf8'));

  if (derivedCommitment !== meta.answer_commitment_sha256) {
    throw new Error('derived answer commitment does not match publisher commitment');
  }

  const result = {
    protocol: OVERSIZED_PROJECTION_VERIFY_PROTOCOL,
    run_id: runId,
    corpus_bytes: meta.corpus_bytes,
    corpus_to_projection_budget_ratio: meta.corpus_to_projection_budget_ratio,
    answer_commitment_sha256: meta.answer_commitment_sha256,
    derived_answer_commitment_sha256: derivedCommitment,
    answer_commitment_match: true,
    shallow_projection_sha256: sha256(shallowBytes),
    expanded_projection_sha256: sha256(expandedBytes),
    shallow_selected_ids: shallow.nodes.map((item) => item.artifact_id),
    shallow_frontier: shallow.frontier,
    expanded_selected_ids: expanded.nodes.map((item) => item.artifact_id),
    shallow_budget: shallow.budget,
    expanded_budget: expanded.budget,
  };

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

function assertIds(nodes, expected, label) {
  const actual = nodes.map((item) => item.artifact_id);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      label + ' mismatch: expected ' + JSON.stringify(expected) +
      ', got ' + JSON.stringify(actual),
    );
  }
}

function extractValue(summary, key) {
  const match = summary.match(new RegExp(key + '=([^.;\\s]+)'));
  if (!match) throw new Error('missing ' + key + ' in projected summary');
  return match[1];
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseArgs(tokens) {
  const output = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) throw new Error('unexpected argument: ' + token);
    const key = token.slice(2);
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error('missing value for --' + key);
    }
    if (output[key] !== undefined) {
      throw new Error('--' + key + ' may be supplied only once');
    }
    output[key] = value;
    index += 1;
  }
  return output;
}

function required(args, key) {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('missing required --' + key);
  }
  return path.resolve(value) === value && key !== 'run-id' ? value : value;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write((error?.stack ?? String(error)) + '\n');
    process.exitCode = 1;
  }
}

export { main as verifyOversizedProjectionBenchmark };
