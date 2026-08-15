---
status: accepted
---

# Separate Agent Identity, Agent Profile, and Agent Run

English | [中文](0001-agent-identity-profile-run.zh.md)

Saki models a durable Agent actor, reusable execution configuration, and an individual attempt as Agent Identity, Agent Profile, and Agent Run. Combining them would make configuration changes rewrite identity, make retries overwrite history, or make persistent responsibility depend on one Session.

## Consequences

An Agent Identity may use different Agent Profiles over time, and a versioned Agent Profile may be reused for many Agent Runs. Every Agent Run records the actual Profile version; an Agent Run may omit Agent Identity when no durable actor owns one-off work. Long-term responsibility and memory belong to Agent Identity, execution instructions belong to Agent Profile, and attempt status, inputs, grants, costs, and evidence belong to Agent Run.
