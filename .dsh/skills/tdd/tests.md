# Observable tests

A durable test names behavior and exercises a public interface or real assembled entry path. It survives internal renames and refactors because its expected result comes from a specification, worked example, protocol, or other independent authority.

Avoid tests that mock an internal collaborator, inspect private methods, assert incidental call order, or query storage behind the interface merely to prove the implementation wrote something. Avoid recomputing the expected value with the same algorithm under test.

Prefer the narrowest real path that would fail for the regression. Add broader assembled evidence when the behavior is model-visible, user-visible, configuration-driven, dynamically loaded, process-bound, or otherwise invisible to a package-only test.
