/** Complete single-select field discovery shared by Board scans and mapping repair. */
import { z } from 'zod'
import { GITHUB_PROJECT_BOARD_FIELD_LIMIT, githubProjectFieldId, githubProjectOptionId } from '@breakfastdapaidang/saki-github'
import type { GitHubProjectFieldFact, GitHubProjectId } from '@breakfastdapaidang/saki-github'
import type { ResolvedConfig } from './index.ts'
import type { GitHubOperationSession } from './operation-session.ts'
import { graphqlPageInfoSchema as pageInfoSchema, graphqlRateSchema, invalidGraphqlResponse as invalid, nextGraphqlCursor as nextCursor, queryGraphql } from './graphql.ts'

const FIELDS_QUERY = `
query SakiProjectFields($projectId: ID!, $first: Int!, $after: String) {
  project: node(id: $projectId) {
    __typename
    ... on ProjectV2 {
      id
      fields(first: $first, after: $after) {
        totalCount
        nodes {
          __typename
          ... on ProjectV2Field { id name dataType }
          ... on ProjectV2IterationField { id name dataType }
          ... on ProjectV2MultiSelectField { id name dataType }
          ... on ProjectV2SingleSelectField { id name options { id name } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
  rateLimit { cost limit used remaining resetAt }
}`

const fieldSchema = z.object({
  __typename: z.string().min(1),
  id: z.string().min(1),
  name: z.string().min(1),
  dataType: z.string().min(1).optional(),
  options: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) }).loose()).optional(),
}).loose()

const fieldsDataSchema = z.object({
  project: z.object({
    __typename: z.literal('ProjectV2'),
    id: z.string().min(1),
    fields: z.object({
      totalCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      nodes: z.array(fieldSchema),
      pageInfo: pageInfoSchema,
    }).loose(),
  }).loose(),
  rateLimit: graphqlRateSchema,
}).loose()

/**
 * Read every field page while checking page counts and exact Project identity.
 * @param session - authenticated operation-scoped GitHub client.
 * @param projectId - exact selected Project.
 * @param config - validated pagination limits.
 * @param signal - operation lifetime.
 * @param observeRate - scan or interactive rate accounting.
 * @returns complete fields; no partial page escapes a failed read.
 */
export async function readProjectFieldsFromSession(
  session: GitHubOperationSession,
  projectId: GitHubProjectId,
  config: ResolvedConfig,
  signal: AbortSignal,
  observeRate?: (rate: z.infer<typeof graphqlRateSchema>) => void,
): Promise<GitHubProjectFieldFact[]> {
  const fields: GitHubProjectFieldFact[] = []
  let cursor: string | null = null
  let reportedTotal: number | undefined
  const cursors = new Set<string>()
  for (let page = 1; ; page += 1) {
    if (page > config.maxPages) invalid('project-fields')
    const data = fieldsDataSchema.parse(await queryGraphql(
      session.installation,
      FIELDS_QUERY,
      { projectId: projectId, first: config.pageSize, after: cursor },
      signal,
      'project-fields',
    ))
    if (data.project.id !== projectId) invalid('project-fields')
    observeRate?.(data.rateLimit)
    reportedTotal ??= data.project.fields.totalCount
    if (data.project.fields.totalCount !== reportedTotal
      || reportedTotal > GITHUB_PROJECT_BOARD_FIELD_LIMIT) {
      invalid('project-fields')
    }
    for (const field of data.project.fields.nodes) {
      fields.push(field.__typename === 'ProjectV2SingleSelectField'
        ? {
          kind: 'single-select',
          id: githubProjectFieldId(field.id),
          name: field.name,
          options: (field.options ?? []).map(option => ({
            id: githubProjectOptionId(option.id),
            name: option.name,
          })),
        }
        : {
          kind: 'field',
          id: githubProjectFieldId(field.id),
          name: field.name,
          dataType: field.dataType ?? field.__typename,
        })
    }
    if (fields.length > reportedTotal) invalid('project-fields')
    cursor = nextCursor(data.project.fields.pageInfo, cursors, 'project-fields')
    if (cursor === null) {
      if (fields.length !== reportedTotal) invalid('project-fields')
      return fields
    }
  }
}
