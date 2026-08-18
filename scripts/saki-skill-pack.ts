/**
 * Verify and update the repository-owned Saki Development Skill Pack.
 * @module scripts/saki-skill-pack
 */

import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { dirname, posix, resolve } from 'node:path'
import { load } from 'js-yaml'

/** Skill names frozen for the first Saki Development Skill Pack. */
export const EXPECTED_SAKI_SKILLS = [
  'ask-matt',
  'code-review',
  'domain-modeling',
  'grill-with-docs',
  'grilling',
  'handoff',
  'implement',
  'tdd',
  'to-spec',
  'to-tickets',
  'triage',
] as const

const MANIFEST_PATH = '.dsh/skill-pack/manifest.json'
const PREFLIGHT_HEADING = '## DSH compatibility preflight'
const FULL_COMMIT = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/
const GIT_BLOB = /^[0-9a-f]{40}$/

type MutationClass = 'none' | 'workspace' | 'tracker' | 'git'

/** Host and DSH requirements declared for one adapted skill. */
export interface SkillRequirements {
  dshCapabilities: string[]
  oneOfCapabilities: string[]
  optionalCapabilities: string[]
  hostCommands: string[]
  mutation: MutationClass
}

/** One pinned source or generated output file. */
export interface PinnedFile {
  path: string
  sha256: string
}

/** One selected upstream file and its repository target. */
export interface UpstreamFile {
  path: string
  blob: string
  target: string
}

/** One deliberately excluded upstream file. */
export interface IgnoredUpstreamFile {
  path: string
  blob: string
  reason: string
}

/** Provenance and compatibility declaration for one adapted skill. */
export interface SkillPackEntry {
  name: string
  category: string
  upstreamDirectory: string
  sourceFiles: UpstreamFile[]
  ignoredUpstreamFiles: IgnoredUpstreamFile[]
  patch: PinnedFile
  outputs: PinnedFile[]
  requirements: SkillRequirements
}

/** Complete machine-readable provenance for the repository skill pack. */
export interface SkillPackManifest {
  schemaVersion: 1
  upstream: {
    repository: string
    commit: string
    commitDate: string
  }
  license: {
    spdx: string
    sourcePath: string
    blob: string
    vendoredPath: string
    sha256: string
  }
  skills: SkillPackEntry[]
}

/** Parsed arguments for the explicit skill-pack update command. */
export interface SkillPackUpdateArgs {
  ref: string
  write: boolean
}

/**
 * Parse updater arguments without accepting a moving source ref.
 * @param args - CLI arguments after the script name.
 * @returns the pinned commit and whether reviewed files may be replaced.
 */
export function parseSkillPackUpdateArgs(args: readonly string[]): SkillPackUpdateArgs {
  let ref: string | undefined
  let write = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--write') {
      write = true
      continue
    }
    if (argument === '--ref') {
      ref = args[index + 1]
      index += 1
      continue
    }
    throw new Error(`update-saki-skill-pack: unknown argument ${JSON.stringify(argument)}`)
  }
  if (ref === undefined) throw new Error('update-saki-skill-pack: requires --ref <40-character commit>')
  if (!FULL_COMMIT.test(ref)) {
    throw new Error('update-saki-skill-pack: --ref must be a full 40-character commit')
  }
  return { ref, write }
}

function asRecord(value: unknown, location: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${location} must be an object`)
  }
  return value as Record<string, unknown>
}

function requiredString(record: Record<string, unknown>, key: string, location: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${location}.${key} must be a non-empty string`)
  return value
}

function stringArray(record: Record<string, unknown>, key: string, location: string): string[] {
  const value = record[key]
  if (!Array.isArray(value)) throw new Error(`${location}.${key} must be a string array`)
  const items: unknown[] = value
  const strings: string[] = []
  for (const item of items) {
    if (typeof item !== 'string') throw new Error(`${location}.${key} must be a string array`)
    strings.push(item)
  }
  return strings
}

function parsePinnedFile(value: unknown, location: string): PinnedFile {
  const record = asRecord(value, location)
  return {
    path: requiredString(record, 'path', location),
    sha256: requiredString(record, 'sha256', location),
  }
}

function parseManifest(text: string): SkillPackManifest {
  const root = asRecord(JSON.parse(text) as unknown, 'manifest')
  if (root.schemaVersion !== 1) throw new Error('manifest.schemaVersion must be 1')
  const upstream = asRecord(root.upstream, 'manifest.upstream')
  const license = asRecord(root.license, 'manifest.license')
  if (!Array.isArray(root.skills)) throw new Error('manifest.skills must be an array')
  const skills = root.skills.map((value, index): SkillPackEntry => {
    const location = `manifest.skills[${String(index)}]`
    const record = asRecord(value, location)
    const requirementsRecord = asRecord(record.requirements, `${location}.requirements`)
    const mutation = requiredString(requirementsRecord, 'mutation', `${location}.requirements`)
    if (!['none', 'workspace', 'tracker', 'git'].includes(mutation)) {
      throw new Error(`${location}.requirements.mutation is invalid`)
    }
    if (!Array.isArray(record.sourceFiles) || !Array.isArray(record.ignoredUpstreamFiles) || !Array.isArray(record.outputs)) {
      throw new Error(`${location} file lists must be arrays`)
    }
    return {
      name: requiredString(record, 'name', location),
      category: requiredString(record, 'category', location),
      upstreamDirectory: requiredString(record, 'upstreamDirectory', location),
      sourceFiles: record.sourceFiles.map((file, fileIndex) => {
        const fileLocation = `${location}.sourceFiles[${String(fileIndex)}]`
        const source = asRecord(file, fileLocation)
        return {
          path: requiredString(source, 'path', fileLocation),
          blob: requiredString(source, 'blob', fileLocation),
          target: requiredString(source, 'target', fileLocation),
        }
      }),
      ignoredUpstreamFiles: record.ignoredUpstreamFiles.map((file, fileIndex) => {
        const fileLocation = `${location}.ignoredUpstreamFiles[${String(fileIndex)}]`
        const ignored = asRecord(file, fileLocation)
        return {
          path: requiredString(ignored, 'path', fileLocation),
          blob: requiredString(ignored, 'blob', fileLocation),
          reason: requiredString(ignored, 'reason', fileLocation),
        }
      }),
      patch: parsePinnedFile(record.patch, `${location}.patch`),
      outputs: record.outputs.map((file, fileIndex) => parsePinnedFile(file, `${location}.outputs[${String(fileIndex)}]`)),
      requirements: {
        dshCapabilities: stringArray(requirementsRecord, 'dshCapabilities', `${location}.requirements`),
        oneOfCapabilities: stringArray(requirementsRecord, 'oneOfCapabilities', `${location}.requirements`),
        optionalCapabilities: stringArray(requirementsRecord, 'optionalCapabilities', `${location}.requirements`),
        hostCommands: stringArray(requirementsRecord, 'hostCommands', `${location}.requirements`),
        mutation: mutation as MutationClass,
      },
    }
  })
  return {
    schemaVersion: 1,
    upstream: {
      repository: requiredString(upstream, 'repository', 'manifest.upstream'),
      commit: requiredString(upstream, 'commit', 'manifest.upstream'),
      commitDate: requiredString(upstream, 'commitDate', 'manifest.upstream'),
    },
    license: {
      spdx: requiredString(license, 'spdx', 'manifest.license'),
      sourcePath: requiredString(license, 'sourcePath', 'manifest.license'),
      blob: requiredString(license, 'blob', 'manifest.license'),
      vendoredPath: requiredString(license, 'vendoredPath', 'manifest.license'),
      sha256: requiredString(license, 'sha256', 'manifest.license'),
    },
    skills,
  }
}

/**
 * Read and validate the repository-owned skill-pack manifest.
 * @param root - repository root containing `.dsh/skill-pack/manifest.json`.
 * @returns the validated manifest.
 */
export async function readSakiSkillPackManifest(root: string): Promise<SkillPackManifest> {
  return parseManifest(await readFile(repositoryPath(root, MANIFEST_PATH), 'utf8'))
}

/**
 * Compute a SHA-256 digest for a pinned skill-pack file.
 * @param content - file bytes.
 * @returns lowercase hexadecimal digest.
 */
export function skillPackSha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Compute the Git blob id for pinned source bytes.
 * @param content - source bytes.
 * @returns lowercase hexadecimal Git object id.
 */
export function skillPackGitBlobHash(content: Buffer): string {
  return createHash('sha1').update(`blob ${String(content.byteLength)}\0`).update(content).digest('hex')
}

function repositoryPath(root: string, relativePath: string): string {
  const normalized = posix.normalize(relativePath.replaceAll('\\', '/'))
  if (normalized.startsWith('../') || normalized.startsWith('/') || normalized === '..') {
    throw new Error(`${relativePath}: path escapes repository`)
  }
  return resolve(root, ...normalized.split('/'))
}

async function inventory(root: string, relativeRoot: string, violations: string[]): Promise<string[]> {
  const absoluteRoot = repositoryPath(root, relativeRoot)
  const files: string[] = []
  let entries
  try {
    entries = await readdir(absoluteRoot, { withFileTypes: true })
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return files
    throw error
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = `${relativeRoot}/${entry.name}`
    const stat = await lstat(repositoryPath(root, relative))
    if (stat.isSymbolicLink()) {
      violations.push(`${relative}: symbolic links are forbidden`)
      files.push(relative)
      continue
    }
    if (entry.isDirectory()) files.push(...await inventory(root, relative, violations))
    else if (entry.isFile()) files.push(relative)
  }
  return files
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function skillFrontmatter(text: string, path: string): Record<string, unknown> {
  const lines = text.split(/\r?\n/)
  if (lines[0] !== '---') throw new Error(`${path}: SKILL.md must start with YAML frontmatter`)
  const end = lines.indexOf('---', 1)
  if (end < 0) throw new Error(`${path}: SKILL.md frontmatter is not closed`)
  return asRecord(load(lines.slice(1, end).join('\n')), `${path} frontmatter`)
}

function compareSkillMetadata(
  frontmatter: Record<string, unknown>,
  entry: SkillPackEntry,
  commit: string,
  path: string,
  violations: string[],
): void {
  try {
    const metadata = asRecord(frontmatter.metadata, `${path} metadata`)
    const saki = asRecord(metadata.saki, `${path} metadata.saki`)
    if (saki.upstream !== 'https://github.com/mattpocock/skills') violations.push(`${path}: metadata upstream does not match manifest`)
    if (saki.commit !== commit) violations.push(`${path}: metadata commit does not match manifest`)
    const comparisons: Array<[string, readonly string[]]> = [
      ['dsh-capabilities', entry.requirements.dshCapabilities],
      ['one-of-capabilities', entry.requirements.oneOfCapabilities],
      ['optional-capabilities', entry.requirements.optionalCapabilities],
      ['host-commands', entry.requirements.hostCommands],
    ]
    for (const [key, expected] of comparisons) {
      if (!arraysEqual(stringArray(saki, key, `${path} metadata.saki`), expected)) {
        violations.push(`${path}: metadata ${key} does not match manifest`)
      }
    }
    if (saki.mutation !== entry.requirements.mutation) violations.push(`${path}: metadata mutation does not match manifest`)
  }
  catch (error) {
    violations.push(error instanceof Error ? error.message : String(error))
  }
}

async function verifyResourceLinks(root: string, entry: SkillPackEntry, skillText: string, violations: string[]): Promise<void> {
  const skillPath = `.dsh/skills/${entry.name}/SKILL.md`
  const linkPattern = /\]\((?!https?:|#)([^)\s]+\.md)(?:#[^)]+)?\)/g
  for (const match of skillText.matchAll(linkPattern)) {
    const resource = match[1]
    if (resource === undefined) continue
    const target = posix.normalize(posix.join(dirname(skillPath), resource))
    try {
      const stat = await lstat(repositoryPath(root, target))
      if (!stat.isFile()) violations.push(`${skillPath}: resource link ${resource} is not a file`)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') violations.push(`${skillPath}: resource link ${resource} is missing`)
      else throw error
    }
  }
}

async function verifyFileHash(root: string, file: PinnedFile, violations: string[]): Promise<Buffer | undefined> {
  let content
  try {
    content = await readFile(repositoryPath(root, file.path))
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      violations.push(`${file.path}: missing file`)
      return undefined
    }
    throw error
  }
  if (!SHA256.test(file.sha256)) violations.push(`${file.path}: manifest SHA-256 is invalid`)
  else if (skillPackSha256(content) !== file.sha256) violations.push(`${file.path}: SHA-256 does not match manifest`)
  return content
}

/**
 * Verify the tracked pack without network access or global skill state.
 * @param root - repository root containing `.dsh/skill-pack` and `.dsh/skills`.
 * @returns stable, repository-relative diagnostics; an empty list means valid.
 */
export async function verifySakiSkillPack(root: string): Promise<string[]> {
  const violations: string[] = []
  let manifest: SkillPackManifest
  try {
    manifest = await readSakiSkillPackManifest(root)
  }
  catch (error) {
    return [`${MANIFEST_PATH}: ${error instanceof Error ? error.message : String(error)}`]
  }

  if (manifest.upstream.repository !== 'https://github.com/mattpocock/skills') violations.push('manifest.upstream.repository: unexpected source')
  if (!FULL_COMMIT.test(manifest.upstream.commit)) violations.push('manifest.upstream.commit: must be a full 40-character commit')
  if (Number.isNaN(Date.parse(manifest.upstream.commitDate))) violations.push('manifest.upstream.commitDate: invalid timestamp')
  if (manifest.license.spdx !== 'MIT') violations.push('manifest.license.spdx: expected MIT')
  if (manifest.license.sourcePath !== 'LICENSE') violations.push('manifest.license.sourcePath: expected LICENSE')
  if (!GIT_BLOB.test(manifest.license.blob)) violations.push('manifest.license.blob: invalid Git blob')

  const names = manifest.skills.map(skill => skill.name).sort()
  if (!arraysEqual(names, EXPECTED_SAKI_SKILLS)) violations.push('manifest.skills: expected the frozen 11-skill set')
  if (new Set(names).size !== names.length) violations.push('manifest.skills: duplicate skill name')

  const expectedFiles = new Set<string>([MANIFEST_PATH, manifest.license.vendoredPath])
  const pinnedFiles: PinnedFile[] = [{ path: manifest.license.vendoredPath, sha256: manifest.license.sha256 }]
  for (const entry of manifest.skills) {
    expectedFiles.add(entry.patch.path)
    pinnedFiles.push(entry.patch)
    if (entry.patch.path !== `.dsh/skill-pack/patches/${entry.name}.patch`) violations.push(`${entry.name}: unexpected patch path`)
    if (entry.outputs.length !== entry.sourceFiles.length) violations.push(`${entry.name}: each selected source file must have one output`)
    const sourceTargets = entry.sourceFiles.map(file => file.target).sort()
    const outputs = entry.outputs.map(file => file.path).sort()
    if (!arraysEqual(sourceTargets, outputs)) violations.push(`${entry.name}: source targets and outputs differ`)
    for (const source of [...entry.sourceFiles, ...entry.ignoredUpstreamFiles]) {
      if (!GIT_BLOB.test(source.blob)) violations.push(`${source.path}: invalid upstream Git blob`)
      if (!source.path.startsWith(`${entry.upstreamDirectory}/`)) violations.push(`${source.path}: outside declared upstream directory`)
    }
    for (const output of entry.outputs) {
      expectedFiles.add(output.path)
      pinnedFiles.push(output)
      if (!output.path.startsWith(`.dsh/skills/${entry.name}/`)) violations.push(`${output.path}: outside skill directory`)
    }
  }

  const actualFiles = [
    ...await inventory(root, '.dsh/skills', violations),
    ...await inventory(root, '.dsh/skill-pack', violations),
  ]
  for (const file of actualFiles) {
    if (!expectedFiles.has(file)) violations.push(`${file}: unexpected file`)
  }
  for (const expected of expectedFiles) {
    if (!actualFiles.includes(expected)) violations.push(`${expected}: missing file`)
  }

  const contents = new Map<string, Buffer>()
  for (const file of pinnedFiles) {
    const content = await verifyFileHash(root, file, violations)
    if (content !== undefined) contents.set(file.path, content)
  }
  const license = contents.get(manifest.license.vendoredPath)
  if (license !== undefined && skillPackGitBlobHash(license) !== manifest.license.blob) {
    violations.push(`${manifest.license.vendoredPath}: Git blob does not match manifest`)
  }

  for (const entry of manifest.skills) {
    const skillPath = `.dsh/skills/${entry.name}/SKILL.md`
    const content = contents.get(skillPath)
    if (content === undefined) continue
    const text = content.toString('utf8')
    if (!text.includes(PREFLIGHT_HEADING)) violations.push(`${skillPath}: missing DSH compatibility preflight`)
    try {
      const frontmatter = skillFrontmatter(text, skillPath)
      if (frontmatter.name !== entry.name) violations.push(`${skillPath}: frontmatter name does not match directory`)
      if (typeof frontmatter.description !== 'string' || frontmatter.description.length === 0) violations.push(`${skillPath}: missing description`)
      compareSkillMetadata(frontmatter, entry, manifest.upstream.commit, skillPath, violations)
    }
    catch (error) {
      violations.push(error instanceof Error ? error.message : String(error))
    }
    await verifyResourceLinks(root, entry, text, violations)

    const patchContent = contents.get(entry.patch.path)?.toString('utf8')
    if (patchContent !== undefined) {
      const expectedPrefix = `diff --git a/.dsh/skills/${entry.name}/`
      const diffHeaders = patchContent.split('\n').filter(line => line.startsWith('diff --git '))
      if (diffHeaders.length === 0 || diffHeaders.some(line => !line.startsWith(expectedPrefix))) {
        violations.push(`${entry.patch.path}: patch changes files outside its skill`)
      }
    }
  }

  return [...new Set(violations)].sort()
}
