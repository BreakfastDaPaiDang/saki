/** Pure launch-time Saki Installation paths and dynamic storage patch. */

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  CURRENT_SAKI_BUILD_ID,
  type SakiServingInstallationOptions,
} from '@breakfastdapaidang/saki-installation-maintenance'

export { CURRENT_SAKI_BUILD_ID }

const SHIPPED_AGENT_PRESET_ROOT = fileURLToPath(new URL('../config/agent-presets/', import.meta.url))

/**
 * Resolve the Installation root and exact legacy B03 path from launch environment.
 * `SAKI_DATABASE_PATH` never selects state after an Installation manifest exists.
 * @param environment - immutable process environment snapshot.
 * @returns strict paths and creator provenance for serving preparation.
 */
export function sakiServingInstallationOptions(
  environment: NodeJS.ProcessEnv = process.env,
): SakiServingInstallationOptions {
  const home = resolveDshHome(undefined, environment)
  const installationRoot = join(home, 'saki')
  return {
    installationRoot,
    legacyDatabasePath: environment.SAKI_DATABASE_PATH ?? join(installationRoot, 'control.sqlite'),
    currentBuildId: CURRENT_SAKI_BUILD_ID,
  }
}

/**
 * Override the inert static SQLite row with the exact manifest-selected database.
 * @param databasePath - absolute path verified by Installation maintenance.
 * @returns final id-targeted include patch.
 */
export function sakiPreparedStoragePatch(databasePath: string): PatchOptions {
  return {
    id: 'saki-storage-sqlite',
    name: '@deepseek-ai/dsh-storage-sqlite',
    config: {
      backend: 'sqlite',
      path: databasePath,
      journalMode: 'wal',
    },
  }
}

/**
 * Bind the private launcher to the preset assets shipped beside its own build.
 * The system root is the complete Saki roster; local files cannot add or
 * shadow Product Agent capabilities.
 * @returns final id-targeted preset-roster patch with an absolute root.
 */
export function sakiAgentPresetsPatch(): PatchOptions {
  return {
    id: 'agent-presets',
    name: '@deepseek-ai/dsh-agent-presets',
    config: {
      default: 'development',
      roots: [{ path: SHIPPED_AGENT_PRESET_ROOT, trust: 'system' }],
      includeShippedRoot: false,
      includeUserRoot: false,
    },
  }
}
