# Work Management

English | [中文](CONTEXT.zh.md)

Work Management defines how Saki organizes intended work, delivery progress, milestones, and releases.

## Language

**Work Item**: A unit of intended project work with an explicit outcome and acceptance conditions. _Avoid_: Ticket, card

**Work Item Status**: The current delivery stage of a Work Item, independent of its Triage Role and any Agent Execution status. _Avoid_: Project status, Agent status

**Inbox**: A Work Item awaiting initial evaluation.

**Backlog**: An accepted Work Item that is not ready to be claimed.

**Ready**: A fully specified and unblocked Work Item that may be claimed.

**In progress**: A claimed Work Item with active implementation.

**In review**: A Work Item whose implementation awaits review, CI, or acceptance.

**Done**: A Work Item whose acceptance conditions are satisfied.

**Canceled**: A Work Item explicitly closed without delivery.

**Blockage**: A condition preventing progress without replacing the Work Item Status. _Avoid_: Blocked as a Work Item Status

**Triage Role**: The routing decision that identifies the next human or Agent action before a Work Item is claimed.

**Board**: A view of Work Items grouped by Work Item Status.

**Milestone**: A named delivery target that groups Work Items and measures scope completion. A Milestone describes planned delivery, not shipped code. _Avoid_: Release, version

**Milestone Phase**: The delivery stage of a Milestone: Planned, In Progress, Ready to Release, Released, or Canceled.

**Release**: A delivered repository snapshot identified by a Saki version. _Avoid_: Milestone, build

**Release Tag**: A `saki-v*` Git tag that binds a Release version to one exact commit.

**Release Commit**: The exact commit selected for a Release. _Avoid_: Versioned commit

**Upstream Baseline**: The exact official DeepSeek Harness commit incorporated into a Saki Release.
