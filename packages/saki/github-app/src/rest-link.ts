/** Strict GitHub REST Link-header parsing. @module @breakfastdapaidang/saki-github-app/rest-link */

/**
 * Parse the unique `rel="next"` target token from one REST Link header.
 * @param link - Link header returned by GitHub, when present.
 * @returns The target token, `null` at pagination end, or `invalid` for malformed or ambiguous syntax.
 */
export function parseNextLinkTarget(link: string | undefined): string | null {
  if (link === undefined) return null
  const nextTargets: string[] = []
  for (const segment of link.split(/,(?=\s*<)/u)) {
    const match = /^\s*<([^<>]+)>\s*((?:;[^;]+)*)\s*$/u.exec(segment)
    if (match === null) return 'invalid'
    let relations: readonly string[] | undefined
    for (const attribute of String(match[2]).split(';').slice(1)) {
      const parsed = /^\s*([A-Za-z][A-Za-z0-9_-]*)=(?:"([^"]*)"|([^\s]+))\s*$/u.exec(attribute)
      if (parsed === null) return 'invalid'
      if (String(parsed[1]).toLowerCase() === 'rel') {
        if (relations !== undefined) return 'invalid'
        relations = String(parsed[2] ?? parsed[3]).split(/\s+/u).filter(Boolean)
      }
    }
    if (relations?.includes('next') === true) nextTargets.push(String(match[1]))
  }
  return nextTargets.length > 1 ? 'invalid' : nextTargets[0] ?? null
}
