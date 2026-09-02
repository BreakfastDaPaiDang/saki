/**
 * Fixed Saki build provenance used by the maintenance and serving launchers.
 * @module @breakfastdapaidang/saki-installation-maintenance/release
 */

import { sakiBuildIdSchema } from '@breakfastdapaidang/saki-control-plane'

/** Provenance for generations created by this B09 source build. */
export const CURRENT_SAKI_BUILD_ID = sakiBuildIdSchema.parse('saki-build-0.1.0-b09')

/** Provenance attached to the sole supported manifest-less B03 source. */
export const LEGACY_B03_BUILD_ID = sakiBuildIdSchema.parse('saki-build-0.1.0-b03')
