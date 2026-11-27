---
name: security-review
description: Review a NeckardtApps diff for unintended changes in access.
---

Read the supplied base-to-head diff and trace the affected caller to the actual permission check and destination. Identify who gains read, write or deploy access, what data or action they can reach, and whether the requested behavior authorizes it. Include paths that change or bypass the release checks themselves.

Return the reviewed SHA and either a clear pass or a blocking finding to the requesting agent. For each blocker cite the file and relevant lines, the principal, unintended capability and a focused fix or verification. If evidence needed to evaluate an access boundary is missing, identify it before clearing the change.
