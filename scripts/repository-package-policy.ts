/** Shared classification for the two product package namespaces in this repository. */

import { valid } from 'semver'

const DSH_CLI_PACKAGE = '@deepseek-ai/dsh'
const DSH_PACKAGE_PREFIX = '@deepseek-ai/dsh-'
const SAKI_PACKAGE_PREFIX = '@breakfastdapaidang/saki-'

/** Stable package identity used by repository gates and generated graphs. */
export interface ProductPackageClassification {
  /** Namespace family and publication policy owner. */
  family: 'dsh' | 'saki'
  /** Collision-free display key used for dependency graph nodes. */
  short: string
}

/** Manifest fields that decide whether a private Saki package is publishable. */
export interface PrivateSakiManifest {
  /** Full npm package name. */
  name?: string
  /** npm's hard publication guard. */
  private?: boolean
  /** npm publication settings, forbidden for private Saki packages. */
  publishConfig?: unknown
  /** npm source metadata, forbidden for private Saki packages. */
  repository?: unknown
  /** Package-local SemVer. */
  version?: string
}

/**
 * Classify one npm package name without admitting adjacent scopes.
 * @param name - full npm package name.
 * @returns the governed family and graph key, or `undefined` for a non-product package.
 */
export function classifyProductPackage(name: string): ProductPackageClassification | undefined {
  if (name === DSH_CLI_PACKAGE) return { family: 'dsh', short: 'dsh' }
  if (name.startsWith(DSH_PACKAGE_PREFIX) && name.length > DSH_PACKAGE_PREFIX.length) {
    return { family: 'dsh', short: name.slice(DSH_PACKAGE_PREFIX.length) }
  }
  if (name.startsWith(SAKI_PACKAGE_PREFIX) && name.length > SAKI_PACKAGE_PREFIX.length) {
    return { family: 'saki', short: `saki/${name.slice(SAKI_PACKAGE_PREFIX.length)}` }
  }
  return undefined
}

/**
 * Whether a package belongs to Saki's private, non-npm product family.
 * @param name - full npm package name.
 * @returns true only for the governed `@breakfastdapaidang/saki-*` namespace.
 */
export function isPrivateSakiPackage(name: string): boolean {
  return classifyProductPackage(name)?.family === 'saki'
}

/**
 * Validate the coupled Saki directory, namespace, and non-publication rules.
 * @param directory - repository-relative package directory with `/` separators.
 * @param manifest - package fields that carry namespace and publication state.
 * @returns one message for every violated Saki package rule.
 */
export function privateSakiPackageViolations(
  directory: string,
  manifest: PrivateSakiManifest,
): string[] {
  const classification = manifest.name === undefined ? undefined : classifyProductPackage(manifest.name)
  const inSakiGroup = /^packages\/saki\/[^/]+$/.test(directory)
  const problems: string[] = []
  if (inSakiGroup && classification?.family !== 'saki') {
    problems.push('packages/saki packages must use the @breakfastdapaidang/saki-* namespace')
  }
  if (classification?.family === 'saki' && !inSakiGroup) {
    problems.push('@breakfastdapaidang/saki-* packages must live under packages/saki/')
  }
  if (!inSakiGroup || classification?.family !== 'saki') return problems
  if (manifest.private !== true) problems.push('Saki package must set "private": true')
  if (manifest.publishConfig !== undefined) problems.push('private Saki package must not declare publishConfig')
  if (manifest.repository !== undefined) problems.push('private Saki package must not declare npm repository metadata')
  if (manifest.version === undefined || valid(manifest.version) === null) {
    problems.push('private Saki package version must be valid SemVer')
  }
  return problems
}
