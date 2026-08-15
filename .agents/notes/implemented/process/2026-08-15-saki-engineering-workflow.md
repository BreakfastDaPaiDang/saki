# Agent Note: Saki engineering workflow

Status: implemented

English | [中文](2026-08-15-saki-engineering-workflow.zh.md)

## Problem

Saki needs one repository-owned system for work intake, Agent routing, delivery status, milestones, releases, and domain terminology. Tool-local task lists cannot coordinate multiple users or preserve project state outside one Agent session.

## Decision

GitHub Issues is the Work Item store for Saki. The five triage labels route unclaimed work according to [`docs/agents/triage-labels.md`](../../../../docs/agents/triage-labels.md), while Work Item Status records delivery progress independently of routing and blockage.

[`CONTEXT-MAP.md`](../../../../CONTEXT-MAP.md) identifies Saki's domain contexts. Each context owns its glossary, and architecture decisions live under the corresponding ADR path described by [`docs/agents/domain.md`](../../../../docs/agents/domain.md). Work Management is the first context and defines the relationship among Work Items, milestones, releases, tags, commits, and the incorporated DeepSeek Harness baseline.

The repository variable `SAKI_CI_RUNNERS=standard` selects GitHub-hosted Linux and Windows runners for required pull-request jobs. Saki does not depend on DeepSeek's private runner labels; the inherited failover variables remain available when a compatible self-hosted pool is deliberately provisioned.

## Alternatives considered

**Keep work state inside Agent sessions.** This has low setup cost but prevents shared triage, durable ownership, and synchronization with repository delivery.

**Use GitHub Projects as the source of truth.** Projects provides board presentation, but Issues remains the stable work record and lets Saki add or replace board views without migrating Work Items.

**Use one repository-wide glossary.** A single file starts simply but mixes unrelated business language and increases merge contention as Saki adds product contexts.

## Consequences

Humans and Agents share one durable Work Item lifecycle and one routing vocabulary. Board implementations must project GitHub Issue state instead of owning a second copy, every new domain context must register through the context map, and standard Saki CI consumes public GitHub-hosted capacity instead of an unavailable upstream runner pool.
