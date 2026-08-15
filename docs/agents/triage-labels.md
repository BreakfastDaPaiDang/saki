# Triage labels

The engineering skills use five canonical triage roles. Each role maps to one GitHub label and, where applicable, a Work Item Status.

| Canonical role | GitHub label | Work Item Status | Meaning |
| --- | --- | --- | --- |
| `needs-triage` | `needs-triage` | `Inbox` | A maintainer must evaluate the Work Item |
| `needs-info` | `needs-info` | `Inbox` | The reporter must provide information |
| `ready-for-agent` | `ready-for-agent` | `Ready` | An Agent can claim the fully specified Work Item |
| `ready-for-human` | `ready-for-human` | `Ready` | The Work Item requires human implementation or judgment |
| `wontfix` | `wontfix` | `Canceled` | The Work Item will close without delivery |

At most one triage label applies to a Work Item. Applying a new triage label removes the previous one.

Claiming a ready Work Item removes its ready label and changes its status to `In progress`. Pull request review changes the status to `In review`. Acceptance changes it to `Done`.

A blockage does not replace Work Item Status. Record the blockage separately so the Work Item retains its delivery stage.
