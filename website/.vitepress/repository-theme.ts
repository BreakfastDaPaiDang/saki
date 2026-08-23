/** Repository-derived links shared by both documentation locales. */

import type { DefaultTheme } from 'vitepress'
import { resolveRepositorySlug } from '../../scripts/project-doc-site.ts'

/** Read the projection-owned edit target without depending on config-module scope. */
function projectedPageEditUrl({ frontmatter }: { frontmatter: unknown }): string {
  const data: unknown = frontmatter
  const editUrl: unknown = typeof data === 'object' && data !== null ? Reflect.get(data, 'editUrl') : undefined
  if (typeof editUrl !== 'string') throw new Error('Projected documentation page has no editUrl frontmatter.')
  return editUrl
}

/**
 * Build the GitHub navigation and edit-link configuration without projecting documentation.
 *
 * @param environment Build environment containing the public repository slug.
 * @returns Social navigation and a locale-label-aware edit-link factory over projected page metadata.
 */
export function repositoryThemeLinks(environment: NodeJS.ProcessEnv) {
  const repositorySlug = resolveRepositorySlug(environment)
  const repositoryUrl = `https://github.com/${repositorySlug}`

  return {
    socialLinks: [{ icon: 'github', link: repositoryUrl }] satisfies DefaultTheme.SocialLink[],
    editLink: (text: string) => ({ pattern: projectedPageEditUrl, text }),
  }
}
