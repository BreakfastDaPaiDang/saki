import { describe, expect, it } from 'vitest'
import { sakiHostExecutionDomainSpec } from '@breakfastdapaidang/saki-execution-local'
import {
  sakiStorageGenerationDomainSpec,
  sakiStorageGenerationV3DomainSpec,
} from '@breakfastdapaidang/saki-control-plane'
import { sakiStateCapability } from '../src/state-version.ts'

describe('Saki product state capability', () => {
  it('retains exact v2-v5 readers and makes only complete v6 writable', () => {
    expect(sakiStateCapability.readable.map(spec => spec.version)).toEqual([2, 3, 4, 5, 6])
    expect(sakiStateCapability.resolveReadable(1)).toBeUndefined()
    expect(sakiStateCapability.resolveReadable(2)?.domains.map(domain => [domain.name, domain.version])).toEqual([
      ['saki_control_plane', 2],
    ])
    expect(sakiStateCapability.resolveReadable(3)?.domains.map(domain => [domain.name, domain.version])).toEqual([
      ['saki_control_plane', 3],
      ['saki_storage_generation', 1],
    ])
    expect(sakiStateCapability.resolveReadable(4)?.domains.map(domain => [domain.name, domain.version])).toEqual([
      ['saki_control_plane', 4],
      ['saki_storage_generation', 2],
    ])
    const v5 = sakiStateCapability.resolveReadable(5)
    expect(v5?.domains.map(domain => [domain.name, domain.version])).toEqual([
      ['saki_control_plane', 5],
      ['saki_host_execution', 1],
      ['saki_storage_generation', 3],
    ])
    if (v5?.version !== 5) throw new Error('state version 5 capability is missing')
    expect(v5.storageGeneration).toBe(sakiStorageGenerationV3DomainSpec)
    expect(sakiStateCapability.resolveReadable(6)?.domains.map(domain => [domain.name, domain.version])).toEqual([
      ['saki_control_plane', 6],
      ['saki_host_execution', 1],
      ['saki_storage_generation', 4],
    ])
    expect(sakiStateCapability.writable.version).toBe(6)
    expect(sakiStateCapability.writable.hostExecution).toBe(sakiHostExecutionDomainSpec)
    expect(sakiStateCapability.writable.storageGeneration).toBe(sakiStorageGenerationDomainSpec)
    expect('buildId' in sakiStateCapability).toBe(false)
  })
})
