## Summary

<!-- What changes and why? -->

## ChangeIntent

```repo-guard-yaml
change_type: feature
scope:
  - src/**
budgets: {}
anchors:
  affects: []
  implements: []
  verifies: []
must_touch: []
must_not_touch:
  - repo-policy.json
  - .github/workflows/repo-guard.yml
expected_effects:
  - Describe the observable effect
```

If a PR intentionally changes governance paths, link the issue that explicitly authorizes that governance change.
