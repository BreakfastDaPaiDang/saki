# Agent Note: Explicit browser delivery with retained requests

Status: implemented

English | [中文](2026-09-14-saki-explicit-browser-delivery.zh.md)

## Problem

A browser needs current selection premises before the first Branch Delivery exists. It also needs to distinguish creating a PR from associating an existing one, and current CI health from retained success. A lost Push or PR response leaves the browser unable to infer whether the effect happened; replacing that request can duplicate work or detach the operator's confirmation from its effect.

## Decision

The Delivery destination uses one safe Host query for current selection revisions, configured credential-manager identity, complete PR discovery, retained delivery sources, and advisory action availability. Submission remains owned by the [Branch Delivery mechanism](2026-08-18-saki-branch-delivery-and-milestone-release-evidence.md), which rechecks current authority, context, exact Commit, remote ref, PR, and CI. Changes supplies the local Git observation used to select a Commit.

The Host retains PR discovery for the same target and delivery revision so cached invalidation reads can preserve its result without granting the browser authority to infer creation eligibility. Each interactive read discards previous discovery before fetching; failure cannot resurrect it. Provider detachment clears the cache. A late result from an older delivery revision cannot replace a newer cached result.

Every selection, Push, PR creation or association, review transition, and human acceptance has an explicit confirmation. The browser freezes its displayed target and original request in Principal-scoped Project persistence. One outstanding delivery request blocks replacement gestures across Work Items in that Project; a pending Changes request also blocks new delivery gestures. Pending, reconciliation, and receipt-free replies retain the request for exact recovery. Only a durable terminal receipt permits acknowledgement and clearance. Temporary unavailability of a nonterminal Branch Delivery Intent therefore returns a pending receipt.

The page displays the Git credential-manager id without resolving an account, the GitHub App installation for PR operations, and the Saki operator for acceptance. Retained CI facts and current source health remain separate. The acceptance record and current Work Item status are independently displayed because the recoverable Done and Issue-close child transition can remain unresolved after acceptance is recorded.

## Alternatives considered

**Infer the first selection from an existing delivery.** No delivery exists at the start of the flow. The Host query provides current safe premises without allocating a placeholder record or exposing private installation configuration.

**Clear an operation after any error response.** Transport failure or a nonterminal receipt cannot prove no effect occurred. Retaining and replaying the original request preserves the operator's confirmation and existing recovery ownership.

**Compute transition eligibility from browser CI rows.** Raw rows omit current Host authority and revision checks. The Host owns advisory eligibility and independently rechecks every submitted transition.

## Consequences

Operators can complete the manual Commit-to-acceptance flow while keeping each remote effect attributable and recoverable. Uncertain requests intentionally block replacement work until recovery establishes a terminal outcome. Automatic claiming, merging, and completion remain outside this UI. The existing delivery and [structured Git](../architecture/2026-08-28-saki-recoverable-structured-git-operations.md) decisions retain their independent durability and safety rationale; this note owns browser confirmation and request retention.
