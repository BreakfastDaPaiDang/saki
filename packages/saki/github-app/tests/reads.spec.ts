import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  githubAccountId,
  githubAppId,
  githubCommitId,
  githubInstallationId,
  githubIssueId,
  githubProjectId,
  githubReleaseTagName,
  githubRepositoryDatabaseId,
  githubRepositoryId,
  githubTagObjectId,
} from '@breakfastdapaidang/saki-github'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SakiGitHubApp from '../src/index.ts'
import { expectedReadPermissions, json, privateKey, TestCredentials } from './harness.ts'

const repositoryId = githubRepositoryId('R_kgDOBoundRepository')
const repositoryDatabaseId = githubRepositoryDatabaseId('4242')
const commitA = githubCommitId('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
const commitB = githubCommitId('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
const tagObjectA = githubTagObjectId('cccccccccccccccccccccccccccccccccccccccc')
const tagObjectB = githubTagObjectId('dddddddddddddddddddddddddddddddddddddddd')
const profile = {
  appId: githubAppId('12345'),
  installationId: githubInstallationId('98765'),
  accountId: githubAccountId('O_kgDOBoundAccount'),
  privateKeyRef: credentialRef('SAKI_PRODUCT_APP_PRIVATE_KEY'),
}

const rateLimit = {
  cost: 1,
  limit: 5_000,
  used: 1,
  remaining: 4_999,
  resetAt: '2026-08-26T09:00:00Z',
}

describe('Saki Product GitHub App exact reads', () => {
  const contexts: Context[] = []

  afterEach(async () => {
    vi.unstubAllGlobals()
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  })

  it('reads Issue, Project, tag peel, Release, Commit, and ancestry from exact configured identities', async () => {
    const tokenBodies: unknown[] = []
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      const pathname = decodeURIComponent(new URL(request.url).pathname)
      if (pathname === '/app/installations/98765/access_tokens') {
        tokenBodies.push(JSON.parse(await request.text()) as unknown)
        return json({
          token: `ghs_exact_read_${tokenBodies.length}`,
          expires_at: '2030-01-02T03:04:05Z',
          permissions: expectedReadPermissions,
          repository_selection: 'selected',
          repositories: [{ id: 4_242 }],
        }, { status: 201 })
      }
      if (pathname === '/graphql') {
        const body = JSON.parse(await request.text()) as { query?: unknown; variables?: unknown }
        const query = String(body.query)
        if (query.includes('query SakiIssue')) {
          expect(body.variables).toEqual({ issueId: 'I_kwDOIssueOne' })
          return json({ data: {
            node: {
              __typename: 'Issue',
              id: 'I_kwDOIssueOne',
              number: 27,
              state: 'OPEN',
              title: 'Publish a read-only Board',
              url: 'https://github.com/BreakfastDaPaiDang/saki/issues/27',
              updatedAt: '2026-08-26T08:01:00Z',
              repository: { id: repositoryId, databaseId: '4242' },
            },
            rateLimit,
          } })
        }
        if (query.includes('query SakiProject')) {
          expect(body.variables).toEqual({ projectId: 'PVT_kwDOBoard' })
          return json({ data: {
            node: {
              __typename: 'ProjectV2',
              id: 'PVT_kwDOBoard',
              number: 1,
              title: 'Saki 0.1.0',
              closed: false,
              url: 'https://github.com/orgs/BreakfastDaPaiDang/projects/1',
              updatedAt: '2026-08-26T08:00:00Z',
              owner: { id: 'O_kgDOBoundAccount' },
            },
            rateLimit,
          } })
        }
        if (query.includes('query SakiRepository')) {
          return json({ data: {
            node: {
              __typename: 'Repository',
              id: repositoryId,
              databaseId: '4242',
              nameWithOwner: 'BreakfastDaPaiDang/saki',
              visibility: 'PUBLIC',
              url: 'https://github.com/BreakfastDaPaiDang/saki',
              updatedAt: '2026-08-26T08:00:00Z',
              owner: { id: 'O_kgDOBoundAccount' },
            },
            rateLimit,
          } })
        }
        throw new Error(`unexpected GraphQL document: ${query}`)
      }
      if (pathname === '/repos/BreakfastDaPaiDang/saki/git/ref/tags/saki-v0.1.0') {
        return json({
          ref: 'refs/tags/saki-v0.1.0',
          object: { type: 'tag', sha: tagObjectA },
        })
      }
      if (pathname === `/repos/BreakfastDaPaiDang/saki/git/tags/${tagObjectA}`) {
        return json({
          sha: tagObjectA,
          object: { type: 'tag', sha: tagObjectB },
          tagger: { date: '2026-08-26T07:00:00Z' },
          html_url: `https://github.com/BreakfastDaPaiDang/saki/releases/tag/${tagObjectA}`,
        })
      }
      if (pathname === `/repos/BreakfastDaPaiDang/saki/git/tags/${tagObjectB}`) {
        return json({
          sha: tagObjectB,
          object: { type: 'commit', sha: commitA },
          tagger: { date: '2026-08-26T07:01:00Z' },
          html_url: `https://github.com/BreakfastDaPaiDang/saki/releases/tag/${tagObjectB}`,
        })
      }
      if (pathname === '/repos/BreakfastDaPaiDang/saki/releases/tags/saki-v0.1.0') {
        return json({
          id: 777,
          node_id: 'REL_kwDORelease',
          tag_name: 'saki-v0.1.0',
          target_commitish: 'master',
          draft: false,
          prerelease: true,
          html_url: 'https://github.com/BreakfastDaPaiDang/saki/releases/tag/saki-v0.1.0',
          published_at: '2026-08-26T07:05:00Z',
        })
      }
      if (pathname === `/repos/BreakfastDaPaiDang/saki/commits/${commitA}`) {
        return json({
          sha: commitA,
          html_url: `https://github.com/BreakfastDaPaiDang/saki/commit/${commitA}`,
          commit: { committer: { date: '2026-08-26T07:02:00Z' } },
        })
      }
      if (pathname === `/repos/BreakfastDaPaiDang/saki/compare/${commitA}...${commitB}`) {
        return json({
          status: 'ahead',
          ahead_by: 2,
          behind_by: 0,
          merge_base_commit: { sha: commitA },
        })
      }
      throw new Error(`unexpected GitHub request: ${request.method} ${pathname}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const ctx = new Context()
    contexts.push(ctx)
    new TestCredentials(ctx, privateKey, true)
    await ctx.plugin(SakiGitHubApp, {})
    const signal = new AbortController().signal

    await expect(ctx.sakiGitHub.read({
      kind: 'issue', installation: profile, repositoryId, repositoryDatabaseId,
      issueId: githubIssueId('I_kwDOIssueOne'),
    }, signal)).resolves.toMatchObject({ id: 'I_kwDOIssueOne', number: 27, state: 'open' })

    await expect(ctx.sakiGitHub.read({
      kind: 'project', installation: profile, projectId: githubProjectId('PVT_kwDOBoard'),
    }, signal)).resolves.toMatchObject({ id: 'PVT_kwDOBoard', number: 1, closed: false })

    const tagName = githubReleaseTagName('saki-v0.1.0')
    await expect(ctx.sakiGitHub.read({
      kind: 'tag-reference', installation: profile, repositoryId, repositoryDatabaseId, tagName,
    }, signal)).resolves.toMatchObject({
      ref: 'refs/tags/saki-v0.1.0',
      target: { kind: 'tag', id: tagObjectA },
    })

    await expect(ctx.sakiGitHub.read({
      kind: 'tag-object', installation: profile, repositoryId, repositoryDatabaseId,
      target: { kind: 'tag', id: tagObjectA },
    }, signal)).resolves.toMatchObject({
      tagObjects: [{ id: tagObjectA }, { id: tagObjectB }],
      commitId: commitA,
    })

    await expect(ctx.sakiGitHub.read({
      kind: 'release-by-tag', installation: profile, repositoryId, repositoryDatabaseId, tagName,
    }, signal)).resolves.toMatchObject({
      kind: 'present',
      release: { id: 'REL_kwDORelease', tagName, targetCommitish: 'master', prerelease: true },
    })

    await expect(ctx.sakiGitHub.read({
      kind: 'commit', installation: profile, repositoryId, repositoryDatabaseId, commitId: commitA,
    }, signal)).resolves.toMatchObject({ id: commitA, committedAt: Date.parse('2026-08-26T07:02:00Z') })

    await expect(ctx.sakiGitHub.read({
      kind: 'compare-commits', installation: profile, repositoryId, repositoryDatabaseId,
      baseCommitId: commitA, headCommitId: commitB,
    }, signal)).resolves.toMatchObject({
      status: 'ahead', aheadBy: 2, behindBy: 0, mergeBaseCommitId: commitA,
    })

    expect(tokenBodies).toHaveLength(7)
    expect(tokenBodies.filter(body => JSON.stringify(body).includes('repository_ids'))).toHaveLength(6)
    expect(JSON.stringify(tokenBodies)).not.toContain('write')
    expect(JSON.stringify(tokenBodies)).not.toContain('workflows')
  })

  it('reports a missing exact GraphQL node as not found', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      const pathname = new URL(request.url).pathname
      if (pathname === '/app/installations/98765/access_tokens') {
        return json({
          token: 'ghs_missing_node',
          expires_at: '2030-01-02T03:04:05Z',
          permissions: expectedReadPermissions,
          repository_selection: 'selected',
          repositories: [{ id: 4_242 }],
        }, { status: 201 })
      }
      if (pathname === '/graphql') return json({ data: { node: null, rateLimit } })
      throw new Error(`unexpected GitHub request: ${request.method} ${pathname}`)
    }))

    const ctx = new Context()
    contexts.push(ctx)
    new TestCredentials(ctx, privateKey, true)
    await ctx.plugin(SakiGitHubApp, {})

    await expect(ctx.sakiGitHub.read({
      kind: 'repository',
      installation: profile,
      repositoryId,
      repositoryDatabaseId,
    }, new AbortController().signal)).rejects.toMatchObject({
      failure: { code: 'not-found', resource: 'repository' },
    })
  })

  it.each(['complete', 'wrong-owner', 'wrong-project', 'duplicate-field', 'duplicate-option', 'missing-page'] as const)(
    'discovers complete mapping fields and rejects %s admission failures', async (scenario) => {
      let fieldReads = 0
      vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const request = new Request(input, init)
        const pathname = new URL(request.url).pathname
        if (pathname === '/app/installations/98765/access_tokens') return json({
          token: 'ghs_mapping_fields', expires_at: '2030-01-02T03:04:05Z',
          permissions: expectedReadPermissions, repository_selection: 'selected', repositories: [{ id: 4_242 }],
        }, { status: 201 })
        if (pathname !== '/graphql') throw new Error(`Unexpected field-discovery request: ${pathname}`)
        const body = JSON.parse(await request.text()) as { query: string; variables: { after?: string | null } }
        if (!body.query.includes('SakiProjectFields')) return json({ data: { node: {
          __typename: 'ProjectV2', id: 'PVT_kwDOBoard', number: 1, title: 'Saki', closed: false,
          url: 'https://github.com/orgs/BreakfastDaPaiDang/projects/1', updatedAt: '2026-08-26T08:00:00Z',
          owner: { id: scenario === 'wrong-owner' ? 'O_another_owner' : profile.accountId },
        }, rateLimit } })
        fieldReads += 1
        const first = body.variables.after === null
        const field = first ? { __typename: 'ProjectV2Field', id: 'PVTF_title', name: 'Title', dataType: 'TITLE' }
          : { __typename: 'ProjectV2SingleSelectField', id: scenario === 'duplicate-field' ? 'PVTF_title' : 'PVTSSF_status',
            name: 'Status', options: [
              { id: 'option-ready', name: 'Ready' },
              { id: scenario === 'duplicate-option' ? 'option-ready' : 'option-done', name: 'Done' },
            ] }
        return json({ data: { project: {
          __typename: 'ProjectV2', id: scenario === 'wrong-project' ? 'PVT_another_project' : 'PVT_kwDOBoard',
          fields: { totalCount: 2, nodes: [field], pageInfo: {
            hasNextPage: first && scenario !== 'missing-page', endCursor: first ? 'field-page-2' : null,
          } },
        }, rateLimit } })
      }))
      const ctx = new Context()
      contexts.push(ctx)
      new TestCredentials(ctx, privateKey, true)
      await ctx.plugin(SakiGitHubApp, {})
      const result = ctx.sakiGitHub.read({
        kind: 'project-fields', installation: profile, projectId: githubProjectId('PVT_kwDOBoard'),
      }, new AbortController().signal)
      if (scenario === 'complete') {
        await expect(result).resolves.toMatchObject({ projectId: 'PVT_kwDOBoard', fields: [
          { kind: 'field', id: 'PVTF_title' },
          { kind: 'single-select', id: 'PVTSSF_status', options: [{ id: 'option-ready' }, { id: 'option-done' }] },
        ] })
        expect(fieldReads).toBe(2)
      } else {
        await expect(result).rejects.toMatchObject({ failure: {
          code: scenario === 'wrong-owner' ? 'permission-mismatch' : 'invalid-external-response',
        } })
        if (scenario === 'wrong-owner') expect(fieldReads).toBe(0)
      }
    },
  )
})
