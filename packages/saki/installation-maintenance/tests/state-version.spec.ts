import { describe, expect, it } from 'vitest'
import {
  sakiHostExecutionDomainSpec,
  sakiHostExecutionV1DomainSpec,
  sakiHostExecutionV2DomainSpec,
  sakiHostExecutionV3DomainSpec,
} from '@breakfastdapaidang/saki-execution-local'
import {
  sakiControlPlaneDomainSpec,
  sakiControlPlaneV8DomainSpec,
  sakiStorageGenerationDomainSpec,
  sakiStorageGenerationV3DomainSpec,
  sakiStorageGenerationV4DomainSpec,
  sakiStorageGenerationV6DomainSpec,
} from '@breakfastdapaidang/saki-control-plane'
import { sakiStateCapability } from '../src/state-version.ts'

describe('Saki product state capability', () => {
  it('retains exact v2-v8 readers and makes only complete v9 writable', () => {
    expect(sakiStateCapability.readable.map(spec => spec.version)).toEqual([2, 3, 4, 5, 6, 7, 8, 9])
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
    expect(v5.hostExecution).toBe(sakiHostExecutionV1DomainSpec)
    expect(v5.storageGeneration).toBe(sakiStorageGenerationV3DomainSpec)
    expect(sakiStateCapability.resolveReadable(6)?.domains.map(domain => [domain.name, domain.version])).toEqual([
      ['saki_control_plane', 6],
      ['saki_host_execution', 1],
      ['saki_storage_generation', 4],
    ])
    const v6 = sakiStateCapability.resolveReadable(6)
    if (v6?.version !== 6) throw new Error('state version 6 capability is missing')
    expect(v6.hostExecution).toBe(sakiHostExecutionV1DomainSpec)
    expect(v6.storageGeneration).toBe(sakiStorageGenerationV4DomainSpec)
    expect(sakiStateCapability.resolveReadable(7)?.domains.map(domain => [domain.name, domain.version])).toEqual([
      ['saki_control_plane', 7],
      ['saki_host_execution', 2],
      ['saki_storage_generation', 5],
    ])
    const v7 = sakiStateCapability.resolveReadable(7)
    if (v7?.version !== 7) throw new Error('state version 7 capability is missing')
    expect(v7.hostExecution).toBe(sakiHostExecutionV2DomainSpec)
    expect(sakiStateCapability.resolveReadable(8)?.domains.map(domain => [domain.name, domain.version])).toEqual([
      ['saki_control_plane', 8],
      ['saki_host_execution', 3],
      ['saki_storage_generation', 6],
    ])
    const v8 = sakiStateCapability.resolveReadable(8)
    if (v8?.version !== 8) throw new Error('state version 8 capability is missing')
    expect(v8.controlPlane).toBe(sakiControlPlaneV8DomainSpec)
    expect(v8.hostExecution).toBe(sakiHostExecutionV3DomainSpec)
    expect(v8.storageGeneration).toBe(sakiStorageGenerationV6DomainSpec)
    expect(sakiStateCapability.resolveReadable(9)?.domains.map(domain => [domain.name, domain.version])).toEqual([
      ['saki_control_plane', 9],
      ['saki_host_execution', 4],
      ['saki_storage_generation', 7],
    ])
    expect(sakiStateCapability.writable.version).toBe(9)
    expect(sakiStateCapability.writable.controlPlane).toBe(sakiControlPlaneDomainSpec)
    expect(sakiStateCapability.writable.hostExecution).toBe(sakiHostExecutionDomainSpec)
    expect(sakiStateCapability.writable.storageGeneration).toBe(sakiStorageGenerationDomainSpec)
    expect('buildId' in sakiStateCapability).toBe(false)
  })
})
