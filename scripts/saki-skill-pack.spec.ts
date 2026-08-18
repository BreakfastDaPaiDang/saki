import { execFile as execFileCallback } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
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

  it.skipIf(process.platform === 'win32')('rejects symbolic links inside the tracked pack', async () => {
    const root = await copyPack()
    const target = resolve(root, '.dsh/skills/handoff/linked.md')
    await symlink(resolve(root, '.dsh/skills/handoff/SKILL.md'), target)

    expect(await verifySakiSkillPack(root)).toContain('.dsh/skills/handoff/linked.md: symbolic links are forbidden')
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
