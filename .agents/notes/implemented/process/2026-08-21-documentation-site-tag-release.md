# Agent Note: Publish the documentation site from a Saki release tag

Status: implemented

English | [中文](2026-08-21-documentation-site-tag-release.zh.md)

## Problem

The repository and its GitHub Pages site are public, while `master` advances with in-progress Saki work. Publishing on every branch merge would expose documentation before a Saki release and spend an Actions deployment on ordinary development. Pull-request CI already builds the production site, so deployment needs its own release cadence without becoming a merge check.

## Decision

`docs-pages.yml` listens to `saki-v*` tag pushes and explicit `workflow_dispatch` events. It does not listen to pull requests or branch pushes. A Saki release tag therefore publishes the matching documentation automatically, while manual dispatch remains available for recovery or an operator-approved redeploy. Both jobs require `SAKI_DOCS_PAGES_ENABLED == 'true'`, so a repository without configured Pages remains inert.

The workflow does not run `release:verify --family dsh`. Private Saki packages have a version line independent of the publishable DSH family, and the DSH verifier correctly rejects a `saki-v*` ref. The tag filter chooses the normal Saki publication event; the `github-pages` environment and its repository settings authorize the deployment. A manual run can deploy its selected ref only when those environment rules allow it.

`DOCS_REPOSITORY` identifies `BreakfastDaPaiDang/saki`, and `DOCS_REPOSITORY_REF` stays `master`. Projected links to unpublished source files, the GitHub navigation item, and both locales' edit links therefore target Saki's public source tree instead of the upstream repository, while avoiding a dependency on retained historical tags. The deployed pages remain the tagged snapshot; only their source-navigation links follow the maintained default branch.

Build coverage does not depend on deployment. The required ready-pull-request CI builds the production site through `check:ci:static`; Saki deliberately runs no CI workflow on every `master` push. [`ci-workflow.spec.ts`](../../../../scripts/ci-workflow.spec.ts), [`saki-actions-workflow.spec.ts`](../../../../scripts/saki-actions-workflow.spec.ts), and [`project-doc-site.spec.ts`](../../../../scripts/project-doc-site.spec.ts) pin the `saki-v*`/manual triggers, the Pages enable switch, the credential-free checkout, the Saki repository and `master` source-link ref, the generated source/edit URLs, and the `github-pages` environment.

## Alternatives considered

**Dispatch only from a `dsh-v*` tag.** Rejected because the site documents Saki and Saki's private package version is intentionally independent of the DSH npm release family. Reusing DSH release verification would make every `saki-v*` deployment fail or couple two release lines that the package policy keeps separate.

**Deploy on every `master` push.** Rejected because a merge is not a Saki release, makes deployment an ordinary development cost, and can publish documentation for incomplete work.

**Follow the deployed tag in `DOCS_REPOSITORY_REF`.** A tagged page linking to the same source snapshot is more exact, but it makes old deployments depend on historical tags remaining available. The public default branch is the durable source-navigation target.

**Make the Pages site private.** Rejected because the repository and product documentation are intentionally public. Access control would hide the intended reader surface without solving publication cadence.

## Consequences

A `saki-v*` tag publishes documentation without a separate dispatch, and an authorized manual run can redeploy when necessary. Ordinary merges and pull requests never deploy the site. Documentation fixes between Saki tags remain visible in the repository and in CI previews but do not reach Pages unless an operator deliberately dispatches the workflow. The environment configuration is operationally significant because it is the authorization check for manual refs and the final deployment step.
