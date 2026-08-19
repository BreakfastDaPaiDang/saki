import { resolve } from 'node:path'
import { verifySakiSkillPack } from './saki-skill-pack.ts'

const repositoryRoot = resolve(import.meta.dirname, '..')
const violations = await verifySakiSkillPack(repositoryRoot)

if (violations.length > 0) {
  console.error('Saki Development Skill Pack verification failed:')
  for (const violation of violations) console.error(`- ${violation}`)
  process.exitCode = 1
}
else {
  console.log('Saki Development Skill Pack verification passed.')
}
