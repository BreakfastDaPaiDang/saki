import { describe, expect, it } from 'vitest'
import { sakiHostExecutionDomainSpec } from '@breakfastdapaidang/saki-execution-local'
import { sakiStorageGenerationDomainSpec } from '@breakfastdapaidang/saki-control-plane'
import { sakiStateCapability } from '../src/state-version.ts'

describe('Saki product state capability', () => {
  it('retains exact v2-v4 readers and makes only complete v5 writable', () => {
    expect(sakiStateCapability.readable.map(spec => spec.version)).toEqual([2, 3, 4, 5])
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
    expect(sakiStateCapability.resolveReadable(5)?.domains.map(domain => [domain.name, domain.version])).toEqual([
      ['saki_control_plane', 5],
      ['saki_host_execution', 1],
      ['saki_storage_generation', 3],
    ])
    expect(sakiStateCapability.writable.version).toBe(5)
    expect(sakiStateCapability.writable.hostExecution).toBe(sakiHostExecutionDomainSpec)
    expect(sakiStateCapability.writable.storageGeneration).toBe(sakiStorageGenerationDomainSpec)
    expect('buildId' in sakiStateCapability).toBe(false)
  })
})
