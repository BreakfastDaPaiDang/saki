# Context glossary format

Saki is a multi-context repository. `CONTEXT-MAP.md` locates each glossary under `docs/contexts/<context>/CONTEXT.md` and records relationships between contexts.

Write one entry in the owning glossary as:

```md
**Canonical Term**: One or two sentences defining what the concept is. _Avoid_: Ambiguous synonym, overloaded name
```

Choose one context-specific term, keep the definition independent of implementation, and list misleading alternatives under `_Avoid_`. General programming concepts do not belong in a domain glossary. Update `CONTEXT-MAP.md` only when a context or a relationship between contexts changes.
