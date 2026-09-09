/**
 * Presenter for the wire `ProjectGitHead`: the dialog and the workspace facts
 * derive branch text, detached state, and the short object id through this
 * one mapping instead of re-reading the union in two components.
 */
import type { ProjectGitHead } from '@breakfastdapaidang/saki-execution'

const HEADS_PREFIX = 'refs/heads/'

/**
 * Display triple for one Git HEAD row. A detached HEAD carries no branch
 * name; an unborn branch carries no object id.
 */
export type GitHeadDisplay =
  | { readonly detached: true; readonly branch: null; readonly shortHead: string }
  | { readonly detached: false; readonly branch: string; readonly shortHead: string | null }

function branchNameOf(symbolicRef: string): string {
  return symbolicRef.startsWith(HEADS_PREFIX) ? symbolicRef.slice(HEADS_PREFIX.length) : symbolicRef
}

/**
 * Derive the display triple from the wire head.
 * @param head - versioned wire HEAD observation.
 * @returns branch name, detached flag, and short object id for rendering.
 */
export function displayGitHead(head: ProjectGitHead): GitHeadDisplay {
  switch (head.kind) {
    case 'commit':
      return head.symbolicRef === undefined
        ? { detached: true, branch: null, shortHead: head.objectId.slice(0, 10) }
        : { detached: false, branch: branchNameOf(head.symbolicRef), shortHead: head.objectId.slice(0, 10) }
    case 'unborn':
      return { detached: false, branch: branchNameOf(head.symbolicRef), shortHead: null }
  }
}
