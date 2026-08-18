import { describe, expect, it } from 'vitest'
import {
  classifyProductPackage,
  isPrivateSakiPackage,
  privateSakiPackageViolations,
} from './repository-package-policy.ts'

describe('repository product package policy', () => {
  it('classifies the published DSH family without changing its short names', () => {
    expect(classifyProductPackage('@deepseek-ai/dsh-agent')).toEqual({
      family: 'dsh',
      short: 'agent',
    })
    expect(classifyProductPackage('@deepseek-ai/dsh')).toEqual({
      family: 'dsh',
      short: 'dsh',
    })
  })

  it('classifies private Saki packages under a collision-free graph name', () => {
    expect(classifyProductPackage('@breakfastdapaidang/saki-bundle')).toEqual({
      family: 'saki',
      short: 'saki/bundle',
    })
  })

  it('does not admit adjacent scopes or bare Saki names', () => {
    expect(classifyProductPackage('@deepseek-ai/cordis')).toBeUndefined()
    expect(classifyProductPackage('@breakfastdapaidang/saki')).toBeUndefined()
    expect(classifyProductPackage('@breakfastdapaidang/other')).toBeUndefined()
    expect(isPrivateSakiPackage('@breakfastdapaidang/saki-bundle')).toBe(true)
    expect(isPrivateSakiPackage('@deepseek-ai/dsh-bundle')).toBe(false)
  })

  it('accepts only private, non-publishable Saki manifests in the Saki group', () => {
    const valid = {
      name: '@breakfastdapaidang/saki-bundle',
      version: '0.1.0',
      private: true,
    }
    expect(privateSakiPackageViolations('packages/saki/bundle', valid)).toEqual([])
    expect(privateSakiPackageViolations('packages/other/bundle', valid)).toEqual([
      '@breakfastdapaidang/saki-* packages must live under packages/saki/',
    ])
    expect(privateSakiPackageViolations('packages/saki/bundle', {
      name: '@deepseek-ai/dsh-bundle',
      version: '0.1.0',
      private: true,
    })).toEqual([
      'packages/saki packages must use the @breakfastdapaidang/saki-* namespace',
    ])
    expect(privateSakiPackageViolations('packages/saki/bundle', {
      name: '@breakfastdapaidang/saki-control-plane',
      version: '0.1.0',
      private: true,
    })).toEqual([
      'Saki package directory leaf must match its npm name suffix',
    ])
    expect(privateSakiPackageViolations('packages/saki/bundle', {
      ...valid,
      version: 'next',
      private: false,
      publishConfig: { access: 'public' },
      repository: { type: 'git' },
    })).toEqual([
      'Saki package must set "private": true',
      'private Saki package must not declare publishConfig',
      'private Saki package must not declare npm repository metadata',
      'private Saki package version must be valid SemVer',
    ])
  })

  it('accepts complete SemVer and rejects versions that only resemble it', () => {
    const manifest = {
      name: '@breakfastdapaidang/saki-bundle',
      private: true,
    }
    for (const version of ['1.2.3+build.7', '1.2.3-rc.1+sha.abc']) {
      expect(privateSakiPackageViolations('packages/saki/bundle', { ...manifest, version })).toEqual([])
    }
    for (const version of ['01.2.3', '1.2.3-rc..1', '1.2.3-01']) {
      expect(privateSakiPackageViolations('packages/saki/bundle', { ...manifest, version })).toContain(
        'private Saki package version must be valid SemVer',
      )
    }
  })
})
