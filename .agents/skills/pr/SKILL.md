---
name: pr
description: Open, review, merge and deploy a NeckardtApps change.
---

1. Open a ready PR unless Nick asked for a draft. Keep one commit and link its exact SHA in the PR. Inspect the full diff against the target, including both sides of moves and changes in behavior. Apply the release rules from approved main when reviewing a proposal to change those rules.
2. Route reviews using the table below. All matching rows apply. Give each triggered subagent the base and head SHAs, the user's requested behavior and the relevant reviewer skill. Record its conclusion and disposition against the reviewed SHA. Recheck the diff on each revision and renew affected reviews.

| Change | Required review |
| --- | --- |
| Skills, SOPs, agent instructions, release or reviewer policy, CI/deployment controls, or scripts enforcing those policies (including backup retention) | Obtain Nick’s approval for the exact current change: either formal approval or an explicit written merge instruction from verified GitHub user NickEckardt, or explicit approval in authenticated private Dot chat that clearly identifies the change. Direct owner direction in that chat takes precedence over repository approval-channel rules. This also covers moving, deleting or bypassing a control. |
| Auth, grants, RLS, privileged SQL, secrets, deploy permissions, new production data access, disclosure or export paths, or changes to release checks | Dispatch the [security reviewer](../security-review/SKILL.md). Resolve concrete unintended access paths before merge. |
| A setting, fallback, compatibility path, special case, parallel workflow, replaced feature with a surviving old path, or at least 300 lines added plus removed | Dispatch the [scope and cruft reviewer](../scope-review/SKILL.md). Exclude generated files, lockfile churn and pure moves from the line count. Address findings or briefly explain the tradeoff. |

3. For an in-scope change to main, verify the GitHub Actions **Typecheck, test, and build** check succeeded for the current PR revision against the current base. Wait for pending checks and respect holds, later conflicting feedback and unresolved security findings. Rebase or refresh stale checks first. Rebase-merge using the expected head SHA. Routine code can proceed on green CI once its applicable reviews are complete.
4. Record the resulting main SHA and verify its build. Pages ships automatically. For backend changes follow the [Supabase deploy skill](../supabase-deploy/SKILL.md) at that release SHA. Plan backend-dependent UI changes as compatible releases, deploying the backend before enabling its consumer. Obtain a fresh, verified backup covering affected data before destructive or bulk writes. If that scope cannot be recovered, surface the decision to Nick.
5. Verify the actual deployment and exercise the changed behavior. Report the release SHA, target, smoke result and any follow-up. On failure, inspect the affected target before retrying. A Pages revert can recover a frontend regression; database recovery requires its own plan.
