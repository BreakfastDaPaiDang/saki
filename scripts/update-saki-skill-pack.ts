import { execFile as execFileCallback } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix, resolve } from 'node:path'
import { isDeepStrictEqual, promisify } from 'node:util'
import {
  parseSkillPackUpdateArgs,
  pinSkillMetadataCommit,
  publishSakiSkillPackCandidate,
  readSakiSkillPackManifest,
  skillPackGitBlobHash,
  skillPackSha256,
  verifySakiSkillPack,
  type SkillPackManifest,
} from './saki-skill-pack.ts'

const execFile = promisify(execFileCallback)
const repositoryRoot = resolve(import.meta.dirname, '..')
const trackedRoots = ['.dsh/skills', '.dsh/skill-pack'] as const

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  return result.stdout.trim()
}

async function filesBelow(root: string, relativeRoot: string): Promise<string[]> {
  const output: string[] = []
  const directory = resolve(root, ...relativeRoot.split('/'))
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = posix.join(relativeRoot, entry.name)
    if (entry.isDirectory()) output.push(...await filesBelow(root, relative))
    else if (entry.isFile()) output.push(relative)
    else throw new Error(`${relative}: upstream skill contains an unsupported file type`)
  }
  return output.sort()
}

async function assertCleanForWrite(): Promise<void> {
  const status = await git(repositoryRoot, ['status', '--porcelain', '--', ...trackedRoots])
  if (status.length > 0) {
    throw new Error('update-saki-skill-pack: --write requires clean .dsh/skills and .dsh/skill-pack trees')
  }
}

async function prepareUpstream(ref: string, temporaryRoot: string): Promise<string> {
  const checkout = join(temporaryRoot, 'upstream')
  await mkdir(checkout)
  await git(checkout, ['init', '--quiet'])
  await git(checkout, ['config', 'core.autocrlf', 'false'])
  await git(checkout, ['config', 'core.eol', 'lf'])
  await git(checkout, ['remote', 'add', 'origin', 'https://github.com/mattpocock/skills'])
  await git(checkout, ['fetch', '--quiet', '--depth', '1', 'origin', ref])
  await git(checkout, ['checkout', '--quiet', '--detach', 'FETCH_HEAD'])
  const resolved = await git(checkout, ['rev-parse', 'HEAD'])
  if (resolved !== ref) throw new Error(`update-saki-skill-pack: fetched ${resolved}, expected ${ref}`)
  return checkout
}

async function stageCandidate(
  upstream: string,
  candidate: string,
  manifest: SkillPackManifest,
): Promise<SkillPackManifest> {
  for (const skill of manifest.skills) {
    const actual = await filesBelow(upstream, skill.upstreamDirectory)
    const expected = [...skill.sourceFiles.map(file => file.path), ...skill.ignoredUpstreamFiles.map(file => file.path)].sort()
    if (actual.join('\n') !== expected.join('\n')) {
      throw new Error(`${skill.upstreamDirectory}: upstream file inventory changed; review the selection and ignored-file allowlist`)
    }
  }

  for (const skill of manifest.skills) {
    for (const source of skill.sourceFiles) {
      const from = resolve(upstream, ...source.path.split('/'))
      const to = resolve(candidate, ...source.target.split('/'))
      await mkdir(dirname(to), { recursive: true })
      await cp(from, to)
    }
  }

  await git(candidate, ['init', '--quiet'])
  await git(candidate, ['config', 'core.autocrlf', 'false'])
  await git(candidate, ['config', 'core.eol', 'lf'])
  for (const skill of manifest.skills) {
    const patch = resolve(repositoryRoot, ...skill.patch.path.split('/'))
    await git(candidate, ['apply', '--check', patch])
    await git(candidate, ['apply', patch])
  }

  const resolvedCommit = await git(upstream, ['rev-parse', 'HEAD'])
  for (const skill of manifest.skills) {
    const skillPath = `.dsh/skills/${skill.name}/SKILL.md`
    const absolutePath = resolve(candidate, ...skillPath.split('/'))
    const adapted = await readFile(absolutePath, 'utf8')
    await writeFile(absolutePath, pinSkillMetadataCommit(adapted, resolvedCommit, skillPath))
  }

  const license = await readFile(resolve(upstream, manifest.license.sourcePath))
  const reviewedLicense = await readFile(resolve(repositoryRoot, manifest.license.vendoredPath))
  if (!license.equals(reviewedLicense)) {
    throw new Error('update-saki-skill-pack: upstream license bytes changed; review the terms and update the pinned license policy before continuing')
  }
  const licenseTarget = resolve(candidate, manifest.license.vendoredPath)
  await mkdir(dirname(licenseTarget), { recursive: true })
  await writeFile(licenseTarget, license)
  const commitDate = await git(upstream, ['show', '-s', '--format=%cI', 'HEAD'])

  return {
    ...manifest,
    upstream: { ...manifest.upstream, commit: resolvedCommit, commitDate },
    license: {
      ...manifest.license,
      blob: skillPackGitBlobHash(license),
      sha256: skillPackSha256(license),
    },
    skills: await Promise.all(manifest.skills.map(async skill => ({
      ...skill,
      sourceFiles: await Promise.all(skill.sourceFiles.map(async (file) => {
        const content = await readFile(resolve(upstream, ...file.path.split('/')))
        return { ...file, blob: skillPackGitBlobHash(content) }
      })),
      ignoredUpstreamFiles: await Promise.all(skill.ignoredUpstreamFiles.map(async (file) => {
        const content = await readFile(resolve(upstream, ...file.path.split('/')))
        return { ...file, blob: skillPackGitBlobHash(content) }
      })),
      patch: {
        ...skill.patch,
        sha256: skillPackSha256(await readFile(resolve(repositoryRoot, ...skill.patch.path.split('/')))),
      },
      outputs: await Promise.all(skill.outputs.map(async file => ({
        ...file,
        sha256: skillPackSha256(await readFile(resolve(candidate, ...file.path.split('/')))),
      }))),
    }))),
  }
}

async function changedCandidatePaths(candidate: string, manifest: SkillPackManifest): Promise<string[]> {
  const paths = [
    manifest.license.vendoredPath,
    ...manifest.skills.flatMap(skill => skill.outputs.map(output => output.path)),
    '.dsh/skill-pack/manifest.json',
  ]
  const changed: string[] = []
  for (const path of paths.sort()) {
    const candidateContent = await readFile(resolve(candidate, ...path.split('/')))
    let currentContent: Buffer | undefined
    try {
      currentContent = await readFile(resolve(repositoryRoot, ...path.split('/')))
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const unchanged = currentContent !== undefined && (
      path.endsWith('.json')
        ? isDeepStrictEqual(JSON.parse(currentContent.toString('utf8')), JSON.parse(candidateContent.toString('utf8')))
        : currentContent.equals(candidateContent)
    )
    if (!unchanged) changed.push(path)
  }
  return changed
}

async function main(): Promise<void> {
  const args = parseSkillPackUpdateArgs(process.argv.slice(2))
  const violations = await verifySakiSkillPack(repositoryRoot)
  if (violations.length > 0) throw new Error(`current skill pack is invalid:\n${violations.map(item => `- ${item}`).join('\n')}`)
  if (args.write) await assertCleanForWrite()

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'saki-skill-pack-update-'))
  try {
    const current = await readSakiSkillPackManifest(repositoryRoot)
    const upstream = await prepareUpstream(args.ref, temporaryRoot)
    const candidate = join(temporaryRoot, 'candidate')
    await mkdir(candidate)
    await cp(
      resolve(repositoryRoot, '.dsh/skill-pack'),
      resolve(candidate, '.dsh/skill-pack'),
      { recursive: true },
    )
    const next = await stageCandidate(upstream, candidate, current)
    await writeFile(resolve(candidate, '.dsh/skill-pack/manifest.json'), `${JSON.stringify(next, null, 2)}\n`)
    const candidateViolations = await verifySakiSkillPack(candidate)
    if (candidateViolations.length > 0) {
      throw new Error(`candidate skill pack is invalid:\n${candidateViolations.map(item => `- ${item}`).join('\n')}`)
    }
    const changed = await changedCandidatePaths(candidate, next)
    if (!args.write) {
      console.log(changed.length === 0 ? 'Dry run: the pinned pack is unchanged.' : `Dry run; changed files:\n${changed.map(path => `- ${path}`).join('\n')}`)
      return
    }
    await publishSakiSkillPackCandidate(repositoryRoot, candidate)
    console.log(`Updated ${changed.length} file(s) from mattpocock/skills@${args.ref}.`)
  }
  finally {
    await rm(temporaryRoot, { force: true, recursive: true })
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
