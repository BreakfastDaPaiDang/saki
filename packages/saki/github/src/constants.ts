/** Fixed GitHub Service limits shared by definitions and providers. @module @breakfastdapaidang/saki-github/constants */

/** Maximum rate observations retained by one complete scan candidate. */
export const GITHUB_RATE_OBSERVATION_LIMIT = 10_000

/** Maximum Repository identities retained by one installation observation. */
export const GITHUB_INSTALLATION_REPOSITORY_LIMIT = 100_000

/** Maximum Project fields retained by one complete scan candidate. */
export const GITHUB_PROJECT_BOARD_FIELD_LIMIT = 10_000

/** Maximum Project items or open Issues retained by one complete scan candidate. */
export const GITHUB_PROJECT_BOARD_SCAN_COLLECTION_LIMIT = 100_000

/** Maximum annotated-tag objects retained by one complete peel fact. */
export const GITHUB_TAG_PEEL_DEPTH_LIMIT = 100

/** Maximum complete Issue-create title size after UTF-8 encoding. */
export const GITHUB_ISSUE_CREATE_TITLE_UTF8_LIMIT = 1_024

/** Maximum complete Issue-create body size after UTF-8 encoding. */
export const GITHUB_ISSUE_CREATE_BODY_UTF8_LIMIT = 60_000

/** Maximum complete targeted Issue body admitted after UTF-8 encoding. */
export const GITHUB_ISSUE_DETAIL_BODY_UTF8_LIMIT = 256 * 1024
