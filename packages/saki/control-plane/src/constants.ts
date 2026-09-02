/** Shared bounds for the Saki control-plane interface. @module @breakfastdapaidang/saki-control-plane */

import { GITHUB_PROJECT_BOARD_SCAN_COLLECTION_LIMIT } from '@breakfastdapaidang/saki-github/constants'

/** Maximum characters retained in one durable Intervention prompt. */
export const MAX_INTERVENTION_PROMPT_CHARS = 4_096

/** Maximum characters accepted in one durable Intervention text answer. */
export const MAX_INTERVENTION_ANSWER_CHARS = 16_384

/** Maximum ordered Dispatches retained by one current Agent Run. */
export const MAX_AGENT_RUN_DISPATCHES = 32

/** Maximum Work Items in one complete confirmed Board publication. */
export const SAKI_BOARD_WORK_ITEM_LIMIT = 10_000

/** Maximum complete mapping-defect list produced from one publishable Project-board scan. */
export const SAKI_GITHUB_MAPPING_ISSUE_LIMIT = SAKI_BOARD_WORK_ITEM_LIMIT + 7

/** Maximum raw candidate facts that can contribute to a Board capacity observation. */
export const SAKI_GITHUB_CAPACITY_OBSERVED_LIMIT = GITHUB_PROJECT_BOARD_SCAN_COLLECTION_LIMIT * 2
