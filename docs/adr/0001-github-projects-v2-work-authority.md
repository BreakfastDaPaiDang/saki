---
status: accepted
---

# Use GitHub Projects v2 as the shared Work Item authority

English | [中文](0001-github-projects-v2-work-authority.zh.md)

GitHub Projects v2 owns shared Work Item Status and manual ordering. Saki maps its fixed statuses to the selected Project's Status options, projects the result into its Board, and keeps only recovery metadata and caches locally. Open repository Issues outside the Project appear in Inbox and join the Project when moved out; Done and Canceled close the Issue, while reopening restores its latest non-terminal status.

## Considered options

Issue labels cannot represent ordered Board state reliably, and a Saki-only database would hide current work from GitHub collaborators. Projects v2 preserves GitHub collaboration and supports status and item-position mutations, at the cost of field mapping, organization-level permission, polling, and conflict recovery.

## Consequences

Board writes fail visibly when GitHub is unavailable or its fields no longer match the configured mapping. Saki never claims that an optimistic local move succeeded until GitHub confirms it.
