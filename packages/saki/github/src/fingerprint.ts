/** Deterministic identity for complete GitHub Project-board scans. @module @breakfastdapaidang/saki-github/fingerprint */

import stringify from 'fast-json-stable-stringify'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import type {
  GitHubProjectBoardFingerprint,
  GitHubProjectBoardFingerprintSource,
  GitHubProjectItemContent,
} from './types.ts'

const UTF8 = new TextEncoder()
const DOMAIN = UTF8.encode('saki/github-project-board/v1')

/**
 * Compute the version-1 identity of one complete Project-board candidate.
 * Rate observations and provider observation time are excluded; external ids,
 * Issue revisions and state, Project membership, Status, archive state, item
 * order, open-Issue API order, and update fences are retained.
 * @param source - complete candidate without its fingerprint.
 * @returns versioned lowercase SHA-256 fingerprint.
 */
export function computeGitHubProjectBoardFingerprint(
  source: GitHubProjectBoardFingerprintSource,
): GitHubProjectBoardFingerprint {
  const material = {
    version: 1,
    installation: {
      id: source.installation.installationId,
      accountId: source.installation.account.id,
    },
    repository: {
      id: source.repository.id,
      databaseId: source.repository.databaseId,
      ownerAccountId: source.repository.ownerAccountId,
      updatedAt: source.repository.updatedAt,
    },
    project: {
      id: source.project.id,
      ownerAccountId: source.project.ownerAccountId,
      updatedAt: source.project.updatedAt,
    },
    statusFieldId: source.statusFieldId,
    fields: [...source.fields]
      .sort((left, right) => compareText(left.id, right.id))
      .map(field => field.kind === 'single-select'
        ? {
          kind: field.kind,
          id: field.id,
          options: [...field.options].sort((left, right) => compareText(left.id, right.id)).map(option => option.id),
        }
        : { kind: field.kind, id: field.id, dataType: field.dataType }),
    items: source.items.map((item, index, items) => ({
      id: item.id,
      projectId: item.projectId,
      content: contentIdentity(item.content),
      statusOptionId: item.statusOptionId ?? null,
      archived: item.archived,
      apiOrder: item.apiOrder,
      previousItemId: items[index - 1]?.id ?? null,
      nextItemId: items[index + 1]?.id ?? null,
      updatedAt: item.updatedAt,
    })),
    openIssues: source.openIssues.map(issue => ({
      id: issue.id,
      repositoryId: issue.repositoryId,
      repositoryDatabaseId: issue.repositoryDatabaseId,
      number: issue.number,
      state: issue.state,
      updatedAt: issue.updatedAt,
    })),
    fences: source.fences,
  }
  const payload = UTF8.encode(stringify(material))
  const length = new Uint8Array(8)
  new DataView(length.buffer).setBigUint64(0, BigInt(payload.byteLength))
  return {
    version: 1,
    digest: bytesToHex(sha256.create()
      .update(DOMAIN)
      .update(Uint8Array.of(0))
      .update(length)
      .update(payload)
      .digest()),
  }
}

function contentIdentity(content: GitHubProjectItemContent): object {
  switch (content.kind) {
    case 'issue':
      return {
        kind: content.kind,
        id: content.issue.id,
        repositoryId: content.issue.repositoryId,
        repositoryDatabaseId: content.issue.repositoryDatabaseId,
        number: content.issue.number,
        state: content.issue.state,
        updatedAt: content.issue.updatedAt,
      }
    case 'pull-request':
      return {
        kind: content.kind,
        id: content.id,
        repositoryId: content.repositoryId ?? null,
      }
    case 'draft-issue': return { kind: content.kind, title: content.title }
    case 'redacted': return { kind: content.kind }
    case 'other': return { kind: content.kind, typeName: content.typeName }
    default: return assertNever(content)
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function assertNever(value: never): never {
  throw new Error(`unhandled GitHub Project item content: ${JSON.stringify(value)}`)
}
