# Context map

## Contexts

- [Work Management](docs/contexts/work-management/CONTEXT.md) — organizes Work Items from intake through milestones and releases.
- [Agent Operations](docs/contexts/agent-operations/CONTEXT.md) — defines Installation and Host identities, state generations and portable exports, Principals, Grants, action attribution, persistent Agent actors, work responsibility, recoverable control intent, fenced dispatch admission, Host operations, intervention, exclusive execution claims, runs, and incoming signals.
- [Model Supply](docs/contexts/model-supply/CONTEXT.md) — resolves provider accounts, credential protection, model routes, context limits, and generated-media jobs.

## Relationships

- **Work Management → Agent Operations**: A Work Item may have a Work Assignment and multiple Work Sessions while designating at most one Session as primary; Agent Runs may use those relations without determining Work Item Status.
- **Agent Operations → Model Supply**: An Agent Profile requests a Model Route and Context Policy; each Agent Run records the route and account actually resolved.
- **Model Supply → Work Management**: A Generation Job may attach generated artifacts and their provenance to a Work Item as Outcome Evidence.
