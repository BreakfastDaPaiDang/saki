/** Fixed safe Git query grammar for Local Host repository status. @module @breakfastdapaidang/saki-execution-local/status-query */

const STATUS_ARGUMENTS = [
  'status',
  '--porcelain=v2',
  '--branch',
  '-z',
  '--untracked-files=all',
  '--ignore-submodules=all',
  '--no-renames',
] as const

/**
 * Construct the complete repository-status arguments after the shared Git safety prefix.
 * @returns fixed porcelain-v2 raw-byte query without a pathspec.
 */
export function projectStatusQueryArguments(): readonly string[] {
  return STATUS_ARGUMENTS
}

/**
 * Test whether arguments are the exact provider-owned status query.
 * @param args - candidate repository-aware Git arguments.
 * @returns whether the query cannot select a path, ignored records, or configurable rename behavior.
 */
export function isSafeProjectStatusQuery(args: readonly string[]): boolean {
  return args.length === STATUS_ARGUMENTS.length
    && args.every((value, index) => value === STATUS_ARGUMENTS[index])
}
