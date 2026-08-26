/** Shared bounds for the Saki control-plane interface. @module @breakfastdapaidang/saki-control-plane */

import { GITHUB_PROJECT_BOARD_SCAN_COLLECTION_LIMIT } from '@breakfastdapaidang/saki-github/constants'

/** Maximum Work Items in one complete confirmed Board publication. */
export const SAKI_BOARD_WORK_ITEM_LIMIT = 10_000

/** Maximum complete mapping-defect list produced from one publishable Project-board scan. */
export const SAKI_GITHUB_MAPPING_ISSUE_LIMIT = SAKI_BOARD_WORK_ITEM_LIMIT + 7

/** Maximum raw candidate facts that can contribute to a Board capacity observation. */
export const SAKI_GITHUB_CAPACITY_OBSERVED_LIMIT = GITHUB_PROJECT_BOARD_SCAN_COLLECTION_LIMIT * 2
