import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { describe, expect, it } from 'vitest'

describe('Saki bundle package', () => {
  it('declares one parseable readiness row through dsh.bundle', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      name?: string
      private?: boolean
      publishConfig?: unknown
      dsh?: { bundle?: { patch?: string } }
    }

    expect(manifest.name).toBe('@breakfastdapaidang/saki-bundle')
    expect(manifest.private).toBe(true)
    expect(manifest.publishConfig).toBeUndefined()
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')

    const parsed = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    )
    expect(parsed).toEqual([
      {
        insert: [{
          id: 'saki-readiness',
          name: '@breakfastdapaidang/saki-bundle',
        }],
      },
    ])
  })
})
