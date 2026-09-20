# Agent Note: GitHub Repository database identity

Status: implemented

English | [中文](2026-09-21-github-repository-database-id.zh.md)

## Problem

GitHub Repository GraphQL queries using `fullDatabaseId` fail before returning any data. Mock responses can conceal this error when they return string ids without checking the selected field.

## Decision

Product App reads and mutation inspections select the documented Repository `databaseId` field and admit positive safe integers. The provider converts admitted values to decimal strings for provider-neutral identity matching and facts. Issue and PullRequest field availability does not determine Repository fields; see the [GitHub Repository reference](https://docs.github.com/en/graphql/reference/repos#repository).

## Alternatives considered

**Alias `fullDatabaseId` to `databaseId`.** An alias changes the result key but cannot make an absent Repository field valid.

**Accept numeric strings as well as integers.** This hides wire-schema mistakes in fixtures. Durable ids remain strings, while GraphQL responses retain their documented numeric type.

## Consequences

Targeted Issue reads and Repository-dependent delivery operations can use the same identity checks as complete scans. Existing persisted identities are unchanged. Read tests check query selections and reject null, string, fractional, nonpositive, and unsafe numeric ids. A real Product App read verifies complete Issue detail against GitHub.
