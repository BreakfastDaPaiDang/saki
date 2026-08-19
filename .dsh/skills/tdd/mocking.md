# Mocking

Mock nondeterministic or external systems such as remote APIs, time, randomness, and unavailable operating-system resources. Prefer a real test database or filesystem when it remains deterministic and affordable.

Do not mock code owned by the interface under test. Supply a narrow typed provider at the external boundary instead of a generic conditional fetcher, and assert the caller-visible outcome rather than the mock's internal call count.

An assembled snapshot may replay a model or external provider while retaining the real Loader, plugins, persistence, tools, and presentation path. Record which external dependency is replaced and which product path remains real.
