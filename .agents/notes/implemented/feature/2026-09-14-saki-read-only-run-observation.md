# Agent Note: Read-only Saki Run observation

Status: implemented

English | [中文](2026-09-14-saki-read-only-run-observation.zh.md)

## Problem

A succeeded Host operation proves durable input delivery before the model finishes. Treating that receipt as the Run outcome hides later failure and can misrepresent Work Item completion. Reading an old Session can also accidentally restore execution, while a recycled terminal id can select an unrelated process after a registry restart.

## Decision

The [Host execution seam](../../../../packages/saki/execution/README.md#durable-agent-starts) exposes an independent read-only Run observation. The Local Host validates physical Session identity and folds consumed work; an empty completed turn cannot replace preceding model work. It reports history availability, latest execution outcome, and current Agent state separately. The observation does not create, resume, wake, or send input to an Agent. Startup recovery retains its separate restoration authority.

Startup recovery mounts the Development Agent Preset while the control plane is still initializing. The Intervention tool therefore registers without a control-plane injection prerequisite and resolves that service for each request or finalization. Requiring its initializing owner during preset activation creates a dependency cycle and prevents Host restart. Missing operation-time availability fails explicitly; it never authorizes a question or bypasses recovery validation.

The bundle activates Connection only after control-plane recovery completes. Until then, the generic Conversation API cannot race the Local Host to restore a retained Session under a different Agent owner. Both the Intervention registration order and Connection activation order are required for browser reconnect during Host restart.

Terminal reads use only the exact live Agent owned by that Local Host and its existing Terminal registry. Responses contain bounded names, process status and scrollback. Opaque ids include registry lifetime, preventing a stale selection from addressing a recycled PTY id. Unavailable ownership, provider absence and read failure remain explicit. A readable Session does not prove that its terminal process or later model execution is available.

The control plane joins validated Work Session, Run, source, Dispatch and Intervention records into complete protected views. It checks Project scope and current read authority before and after awaited Host observation. Stable Session and Dispatch cursors bound pages to 32 records; recent Intervention history retains the current blocker and indicates omitted older records. Run admission state remains independent of the latest DSH execution result and Work Item status.

The [Web client](../../../../packages/saki/web-ui/README.md#plan-a-project) persists Run selection, tab, pagination and return destinations under the Principal and Project. Watch heartbeats re-read the selected Run because model completion need not change a control-plane record. The existing Conversation owns messages and unfinished drafts; a Session-header action returns to the retained Run. Changes and Delivery preserve that return destination. Reading any of these execution views grants no execution or acceptance authority.

## Alternatives considered

**Add terminal Run states to the admission records.** The Run can receive later Conversation input after a completed turn. The Session log already owns model outcomes; a second persisted status would require synchronization and could drift from that history.

**Resume the Agent when the page opens.** Read access does not authorize restoration or execution. Existing startup recovery validates the exact persisted request independently.

**Persist raw PTY ids or build another terminal runtime.** Registry ids can be reused, and an additional runtime duplicates process ownership and teardown. Lifetime-scoped selection over the existing registry preserves that ownership.

## Consequences

Operators can inspect waiting, failed and historical work without changing Work Item status or sending model input. Complete Session reads and selected-Run polling have a cost; terminal output and browser history pages remain bounded. The manual dispatch, durable answer, planning and browser delivery decisions retain their independent admission, mutation and recovery rationale. This decision implements the Session and Run observation part of the [Web client proposal](../../proposed/architecture/2026-08-18-saki-projection-driven-web-client.md); automatic dispatch, coordinator lineage, terminal restoration and automatic acceptance remain separate work.
