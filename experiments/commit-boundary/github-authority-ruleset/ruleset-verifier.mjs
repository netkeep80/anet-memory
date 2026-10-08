export const RULESET_NAME = 'anet-memory-authority-non-rewind-v1';
export const AUTHORITY_PATTERN = 'refs/heads/anet-authority/**';

function hasRule(rules, type) {
  return Array.isArray(rules) && rules.some((rule) => rule?.type === type);
}

export function inspectAuthorityRuleset(ruleset) {
  if (!ruleset || typeof ruleset !== 'object' || Array.isArray(ruleset)) {
    return {
      accepted: false,
      classification: 'INVALID_RULESET_OBJECT',
    };
  }

  if (ruleset.name !== RULESET_NAME) {
    return {
      accepted: false,
      classification: 'WRONG_RULESET_NAME',
    };
  }

  if (ruleset.target !== 'branch') {
    return {
      accepted: false,
      classification: 'WRONG_RULESET_TARGET',
    };
  }

  if (ruleset.enforcement !== 'active') {
    return {
      accepted: false,
      classification: 'RULESET_NOT_ACTIVE',
    };
  }

  const refName = ruleset.conditions?.ref_name;
  if (!refName || !Array.isArray(refName.include) || !Array.isArray(refName.exclude)) {
    return {
      accepted: false,
      classification: 'INVALID_REF_CONDITIONS',
    };
  }

  if (!refName.include.includes(AUTHORITY_PATTERN)) {
    return {
      accepted: false,
      classification: 'AUTHORITY_PATTERN_NOT_INCLUDED',
    };
  }

  if (refName.exclude.length !== 0) {
    return {
      accepted: false,
      classification: 'AUTHORITY_EXCLUSIONS_NOT_ALLOWED',
    };
  }

  if (!Object.prototype.hasOwnProperty.call(ruleset, 'bypass_actors')) {
    return {
      accepted: false,
      classification: 'BYPASS_VISIBILITY_UNKNOWN',
    };
  }

  if (!Array.isArray(ruleset.bypass_actors)) {
    return {
      accepted: false,
      classification: 'INVALID_BYPASS_LIST',
    };
  }

  if (ruleset.bypass_actors.length !== 0) {
    return {
      accepted: false,
      classification: 'BYPASS_ACTORS_PRESENT',
    };
  }

  if (!hasRule(ruleset.rules, 'non_fast_forward')) {
    return {
      accepted: false,
      classification: 'NON_FAST_FORWARD_RULE_MISSING',
    };
  }

  if (!hasRule(ruleset.rules, 'deletion')) {
    return {
      accepted: false,
      classification: 'DELETION_RULE_MISSING',
    };
  }

  return {
    accepted: true,
    classification: 'RULESET_CONTRACT_VERIFIED',
    authority_pattern: AUTHORITY_PATTERN,
    force_rewind_policy: 'BLOCKED',
    deletion_policy: 'BLOCKED',
    bypass_count: 0,
  };
}

export function classifyForceProbe({
  childCommit,
  observedHeadAfterForceAttempt,
  forceMutationStatus,
  subsequentFastForwardSucceeded,
}) {
  if (typeof childCommit !== 'string' || childCommit.length !== 40) {
    throw new Error('childCommit: expected 40-character commit SHA');
  }
  if (typeof observedHeadAfterForceAttempt !== 'string' || observedHeadAfterForceAttempt.length !== 40) {
    throw new Error('observedHeadAfterForceAttempt: expected 40-character commit SHA');
  }
  if (!['rejected', 'succeeded'].includes(forceMutationStatus)) {
    throw new Error('forceMutationStatus: expected rejected or succeeded');
  }

  if (observedHeadAfterForceAttempt !== childCommit) {
    return {
      accepted: false,
      classification: 'FAIL_FORCE_REWRITE_OBSERVED',
    };
  }

  if (forceMutationStatus !== 'rejected') {
    return {
      accepted: false,
      classification: 'FAIL_FORCE_MUTATION_REPORTED_SUCCESS',
    };
  }

  if (subsequentFastForwardSucceeded !== true) {
    return {
      accepted: false,
      classification: 'FAIL_MONOTONIC_ADVANCE_BLOCKED',
    };
  }

  return {
    accepted: true,
    classification: 'PASS_GITHUB_SERVER_SIDE_NON_REWIND_FORCE_PROBE',
  };
}
