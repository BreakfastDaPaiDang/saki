/** Plugin that cannot activate because its required service is absent. */

/** Fixture plugin name. */
export const name = 'pending-readiness-test'
/** Deliberately absent service required by this fixture. */
export const inject = ['missingReadinessDependency']

/** The Loader must keep this fixture pending and never call its body. */
export function apply(): void {
  throw new Error('pending readiness fixture unexpectedly activated')
}
