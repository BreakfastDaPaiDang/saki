import { execFile as execFileCallback } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rename as renamePath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EXPECTED_SAKI_SKILLS,
  parseSkillPackUpdateArgs,
  pinSkillMetadataCommit,
  publishSakiSkillPackCandidate,
  verifySakiSkillPack,
} from './saki-skill-pack.ts'

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..')
const temporaryDirectories: string[] = []
const execFile = promisify(execFileCallback)

async function temporaryDirectory(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `${name}-`))
  temporaryDirectories.push(directory)
  return directory
}

async function copyPack(): Promise<string> {
  const root = await temporaryDirectory('saki-skill-pack')
  await cp(resolve(REPOSITORY_ROOT, '.dsh'), resolve(root, '.dsh'), { recursive: true })
  return root
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('Saki Development Skill Pack verifier', () => {
  it('accepts the pinned repository pack and detects content drift', async () => {
    const root = await copyPack()
    expect(await verifySakiSkillPack(root)).toEqual([])

    const askMatt = resolve(root, '.dsh/skills/ask-matt/SKILL.md')
    await writeFile(askMatt, `${await readFile(askMatt, 'utf8')}drift\n`)

    expect(await verifySakiSkillPack(root)).toContain(
      '.dsh/skills/ask-matt/SKILL.md: SHA-256 does not match manifest',
    )
  })

  it('rejects missing provenance, unexpected files, and invalid compatibility declarations', async () => {
    const root = await copyPack()
    await rm(resolve(root, '.dsh/skill-pack/LICENSE.mattpocock-skills'))
    await writeFile(resolve(root, '.dsh/skills/unreviewed.md'), '# unreviewed\n')
    const handoff = resolve(root, '.dsh/skills/handoff/SKILL.md')
    await writeFile(handoff, (await readFile(handoff, 'utf8')).replace('## DSH compatibility preflight', '## Compatibility'))

    const violations = await verifySakiSkillPack(root)
    expect(violations).toContain('.dsh/skill-pack/LICENSE.mattpocock-skills: missing file')
    expect(violations).toContain('.dsh/skills/unreviewed.md: unexpected file')
    expect(violations).toContain('.dsh/skills/handoff/SKILL.md: missing DSH compatibility preflight')
  })

  it('rejects manifest paths that can escape a repository on Windows', async () => {
    const root = await copyPack()
    const manifestPath = resolve(root, '.dsh/skill-pack/manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      license: { vendoredPath: string }
    }
    manifest.license.vendoredPath = 'C:/Windows/win.ini'
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    await expect(verifySakiSkillPack(root)).resolves.toContain(
      '.dsh/skill-pack/manifest.json: manifest.license.vendoredPath must be a normalized repository-relative path',
    )
  })

  it.skipIf(process.platform === 'win32')('rejects symbolic links inside the tracked pack', async () => {
    const root = await copyPack()
    const target = resolve(root, '.dsh/skills/handoff/linked.md')
    await symlink(resolve(root, '.dsh/skills/handoff/SKILL.md'), target)

    expect(await verifySakiSkillPack(root)).toContain('.dsh/skills/handoff/linked.md: symbolic links are forbidden')
  })

  it.skipIf(process.platform !== 'win32')('rejects Windows directory junctions inside the tracked pack', async () => {
    const root = await copyPack()
    const target = resolve(root, '.dsh/skills/handoff/linked')
    await symlink(resolve(root, '.dsh/skills/handoff'), target, 'junction')

    expect(await verifySakiSkillPack(root)).toContain('.dsh/skills/handoff/linked: symbolic links are forbidden')
  })

  it.skipIf(process.platform !== 'win32')('rejects a Windows junction used as a tracked root', async () => {
    const root = await copyPack()
    const outside = await copyPack()
    const skills = resolve(root, '.dsh/skills')
    await rm(skills, { recursive: true })
    await symlink(resolve(outside, '.dsh/skills'), skills, 'junction')

    expect(await verifySakiSkillPack(root)).toContain('.dsh/skills: symbolic links are forbidden')
  })
})

describe('Saki Development Skill Pack update arguments', () => {
  it('requires an explicit full commit and keeps dry-run as the default', () => {
    expect(parseSkillPackUpdateArgs(['--ref', '9c9f36ccd3995266cd675468af71639c8dde1ec5'])).toEqual({
      ref: '9c9f36ccd3995266cd675468af71639c8dde1ec5',
      write: false,
    })
    expect(parseSkillPackUpdateArgs(['--write', '--ref', '9c9f36ccd3995266cd675468af71639c8dde1ec5'])).toEqual({
      ref: '9c9f36ccd3995266cd675468af71639c8dde1ec5',
      write: true,
    })
    expect(() => parseSkillPackUpdateArgs(['--ref', 'main'])).toThrow('must be a full 40-character commit')
    expect(() => parseSkillPackUpdateArgs([])).toThrow('requires --ref')
  })

  it('rejects an invalid candidate without changing the current pack', async () => {
    const current = await copyPack()
    const candidate = await copyPack()
    const currentSkill = resolve(current, '.dsh/skills/ask-matt/SKILL.md')
    const before = await readFile(currentSkill, 'utf8')
    const candidateSkill = resolve(candidate, '.dsh/skills/ask-matt/SKILL.md')
    await writeFile(candidateSkill, `${await readFile(candidateSkill, 'utf8')}drift\n`)

    await expect(publishSakiSkillPackCandidate(current, candidate)).rejects.toThrow(
      'candidate skill pack is invalid',
    )

    expect(await readFile(currentSkill, 'utf8')).toBe(before)
    expect(await verifySakiSkillPack(current)).toEqual([])
  })

  it('publishes a verified pack and preserves unrelated DSH files', async () => {
    const current = await copyPack()
    const candidate = await copyPack()
    const unrelated = resolve(current, '.dsh/runtime.json')
    await writeFile(unrelated, '{"preserved":true}\n')
    const candidateManifest = resolve(candidate, '.dsh/skill-pack/manifest.json')
    const manifest = JSON.parse(await readFile(candidateManifest, 'utf8')) as {
      upstream: { commitDate: string }
    }
    manifest.upstream.commitDate = '2026-08-18T07:54:22.000Z'
    await writeFile(candidateManifest, `${JSON.stringify(manifest, null, 2)}\n`)

    await publishSakiSkillPackCandidate(current, candidate)

    expect(JSON.parse(await readFile(resolve(current, '.dsh/skill-pack/manifest.json'), 'utf8'))).toMatchObject({
      upstream: { commitDate: '2026-08-18T07:54:22.000Z' },
    })
    expect(await readFile(unrelated, 'utf8')).toBe('{"preserved":true}\n')
    expect(await verifySakiSkillPack(current)).toEqual([])
  })

  it('restores the current pack when candidate publication fails', async () => {
    const current = await copyPack()
    const candidate = await copyPack()
    const currentManifest = resolve(current, '.dsh/skill-pack/manifest.json')
    const before = await readFile(currentManifest, 'utf8')
    let renameCount = 0

    await expect(publishSakiSkillPackCandidate(current, candidate, {
      async rename(from, to) {
        renameCount += 1
        if (renameCount === 2) throw new Error('simulated candidate publication failure')
        await renamePath(from, to)
      },
    })).rejects.toThrow('simulated candidate publication failure')

    expect(await readFile(currentManifest, 'utf8')).toBe(before)
    expect(await verifySakiSkillPack(current)).toEqual([])
  })

  it('restores by copy when publication and rename rollback both fail', async () => {
    const current = await copyPack()
    const candidate = await copyPack()
    const currentManifest = resolve(current, '.dsh/skill-pack/manifest.json')
    const before = await readFile(currentManifest, 'utf8')
    let renameCount = 0

    await expect(publishSakiSkillPackCandidate(current, candidate, {
      async rename(from, to) {
        renameCount += 1
        if (renameCount === 2 || renameCount === 3) throw new Error(`simulated rename failure ${String(renameCount)}`)
        await renamePath(from, to)
      },
    })).rejects.toThrow('restored the previous .dsh tree by copy')

    expect(await readFile(currentManifest, 'utf8')).toBe(before)
    expect(await verifySakiSkillPack(current)).toEqual([])
  })

  it('materializes the requested full commit in one adapted skill', async () => {
    const skill = await readFile(resolve(REPOSITORY_ROOT, '.dsh/skills/ask-matt/SKILL.md'), 'utf8')
    const nextCommit = '068b6e0c62393147daf03530149cdce209c93da8'

    const materialized = pinSkillMetadataCommit(skill, nextCommit, '.dsh/skills/ask-matt/SKILL.md')

    expect(materialized).toContain(`    commit: ${nextCommit}`)
    expect(materialized).not.toContain('    commit: 9c9f36ccd3995266cd675468af71639c8dde1ec5')
  })
})

describe('repository-owned skill discovery', () => {
  it('finds exactly the pinned pack from an isolated clean project', async () => {
    const project = await temporaryDirectory('saki-skill-project')
    const dshHome = await temporaryDirectory('saki-skill-dsh-home')
    const agentsHome = await temporaryDirectory('saki-skill-agents-home')
    await cp(resolve(REPOSITORY_ROOT, '.dsh/skills'), resolve(project, '.dsh/skills'), { recursive: true })
    await mkdir(resolve(project, 'packages/example'), { recursive: true })
    await execFile('git', ['init', '--quiet'], { cwd: project })
    await execFile('git', ['add', '--', '.dsh'], { cwd: project })
    await execFile('git', [
      '-c', 'user.name=Saki fixture',
      '-c', 'user.email=saki-fixture@example.invalid',
      '-c', 'commit.gpgsign=false',
      'commit', '--quiet', '-m', 'Add repository skill pack',
    ], { cwd: project })
    expect((await execFile('git', ['status', '--porcelain'], { cwd: project })).stdout).toBe('')

    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, { dshHome, agentsHome, watch: false })
    const snapshot = await ctx.skills.snapshot({ cwd: join(project, 'packages/example') })

    expect(snapshot.complete).toBe(true)
    expect(snapshot.skills.map(skill => skill.name)).toEqual(EXPECTED_SAKI_SKILLS)
    expect(snapshot.skills.every(skill => skill.source === 'project-dsh')).toBe(true)
    for (const name of EXPECTED_SAKI_SKILLS) {
      const loaded = await ctx.skills.get(name, { cwd: project })
      expect(loaded).toMatchObject({
        name,
        source: 'project-dsh',
        resourceBase: { kind: 'directory', path: resolve(project, `.dsh/skills/${name}`) },
      })
      expect(loaded?.content).toContain('## DSH compatibility preflight')
    }

    await ctx.fiber.dispose()
  })
})
