# Agent Note: Reproducible CI bubblewrap package

Status: implemented

English | [中文](2026-09-19-ci-bubblewrap-snapshot.zh.md)

## Problem

Ubuntu removes superseded package revisions from its live archive. A version and SHA-256 pin against that archive can therefore become unavailable without a repository change. The bubblewrap preparation step returned HTTP 404 before the Node compatibility, coverage, and snapshot jobs reached their checks in [run 35455546913](https://github.com/BreakfastDaPaiDang/saki/actions/runs/35455546913).

## Decision

`scripts/prepare-ci-bubblewrap.sh` downloads Ubuntu Noble's `0.9.0-1ubuntu0.3` amd64 package from the dated `20260919T000000Z` [Ubuntu snapshot](https://snapshot.ubuntu.com/). Its SHA-256 matches the official Noble security package index. The script verifies the downloaded bytes before extraction and requires a real namespace probe before tests run.

## Alternatives considered

**Updating only the live-archive URL.** A later security revision can remove that package again. A dated snapshot preserves the reviewed payload while the checksum still rejects different bytes.

## Consequences

A live-archive replacement does not invalidate the pinned URL. Maintenance must update the snapshot, package version, and digest together when adopting a security revision. Snapshot retention remains an external service dependency; download, checksum, extraction, and probe failures stay fatal.
