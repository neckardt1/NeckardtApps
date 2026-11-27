---
name: scope-review
description: Review a NeckardtApps diff for accumulating requirements and leftover behavior.
---

Compare the change with the user's request. Identify any new behavior the team is implicitly promising to maintain. Look for settings, exceptions and compatibility paths without a current use, plus superseded code, tests or operating instructions that can retire together. Check callers and prior decisions before recommending removal of an existing commitment.

Return the reviewed SHA and a short advisory finding for each concrete opportunity, or say the scope fits. Name the behavior, evidence and smallest useful cut. Leave an existing user-facing requirement in place when its retirement needs Nick's decision. Duplicated lines or an extra dependency alone do not warrant a finding.
