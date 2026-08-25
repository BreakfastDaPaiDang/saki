import { afterEach, describe, expect, it, vi } from 'vitest'

const OWNER_SID = sid([21, 1_001, 2_002, 3_003, 4_004])
const SYSTEM_SID = sid([18])
const AMBIENT_SID = sid([11])
const FILE_ALL_ACCESS = 0x001f01ff
const DACL_PROTECTED = 0x1000
const PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000
const WIN_LOCAL_SYSTEM_SID = 22

interface PointerType {
  readonly kind: 'pointer'
  readonly target: unknown
}

interface FakePathSecurity {
  owner: Buffer | null
  dacl: Buffer | null
  protected: boolean
}

interface FakeFailures {
  getNamed?: number
  descriptorMissing?: boolean
  ownerMissing?: boolean
  createSystemSid?: boolean
  invalidSystemSid?: boolean
  getLengthSid?: boolean
  initializeAcl?: boolean
  addAceAt?: number
  setNamed?: number
  setNamedThrows?: boolean
  getControl?: boolean
  localFree?: boolean
}

class FakeWin32Acl {
  readonly failures: FakeFailures
  readonly loadedLibraries: string[] = []
  private readonly memory = new Map<bigint, Buffer>()
  private readonly descriptorPaths = new Map<bigint, FakePathSecurity>()
  private readonly paths = new Map<string, FakePathSecurity>()
  private nextPointer = 1n
  private addAceCalls = 0

  constructor(failures: FakeFailures = {}) {
    this.failures = failures
  }

  readonly koffi = {
    pointer: (target: unknown): PointerType => ({ kind: 'pointer', target }),
    alloc: (type: unknown, length: number): bigint => {
      const width = isPointerType(type)
        ? 8
        : type === 'uint16'
          ? 2
          : type === 'uint32'
            ? 4
            : 1
      return this.register(Buffer.alloc(width * length))
    },
    encode: (destination: unknown, type: unknown, value: unknown): void => {
      const buffer = this.buffer(destination)
      if (type === 'uint32' && typeof value === 'number') {
        buffer.writeUInt32LE(value)
        return
      }
      throw new Error(`unsupported fake koffi encode ${String(type)}`)
    },
    decode: (...args: unknown[]): unknown => {
      const source = args[0]
      const offset = args.length === 3 ? asNumber(args[1]) : 0
      const type = args.length === 3 ? args[2] : args[1]
      const buffer = this.buffer(source)
      if (isPointerType(type)) {
        const value = buffer.readBigUInt64LE(offset)
        return value === 0n ? null : value
      }
      switch (type) {
        case 'uint8': return buffer.readUInt8(offset)
        case 'uint16': return buffer.readUInt16LE(offset)
        case 'uint32': return buffer.readUInt32LE(offset)
        default: throw new Error(`unsupported fake koffi decode ${String(type)}`)
      }
    },
    load: (library: string) => {
      this.loadedLibraries.push(library)
      return {
        func: (
          convention: string,
          name: string,
          _result: unknown,
          _args: unknown[],
        ): unknown => {
          expect(convention).toBe('__stdcall')
          return this.nativeFunction(name)
        },
      }
    },
  }

  addPath(path: string, owner: Buffer | null = OWNER_SID): FakePathSecurity {
    const security: FakePathSecurity = { owner, dacl: null, protected: false }
    this.paths.set(normalizePath(path), security)
    return security
  }

  path(path: string): FakePathSecurity {
    const value = this.paths.get(normalizePath(path))
    if (value === undefined) throw new Error(`fake path is missing: ${path}`)
    return value
  }

  private nativeFunction(name: string): unknown {
    switch (name) {
      case 'GetNamedSecurityInfoW': return this.getNamedSecurityInfoW
      case 'SetNamedSecurityInfoW': return this.setNamedSecurityInfoW
      case 'CreateWellKnownSid': return this.createWellKnownSid
      case 'IsValidSid': return this.isValidSid
      case 'GetLengthSid': return this.getLengthSid
      case 'InitializeAcl': return this.initializeAcl
      case 'AddAccessAllowedAceEx': return this.addAccessAllowedAceEx
      case 'GetSecurityDescriptorControl': return this.getSecurityDescriptorControl
      case 'LocalFree': return this.localFree
      case 'GetLastError': return () => 87
      default: throw new Error(`unexpected Win32 binding: ${name}`)
    }
  }

  private readonly getNamedSecurityInfoW = (
    path: string,
    _objectType: number,
    _information: number,
    ownerSlot: bigint,
    _groupSlot: bigint,
    daclSlot: bigint,
    _saclSlot: bigint,
    descriptorSlot: bigint,
  ): number => {
    if (this.failures.getNamed !== undefined) return this.failures.getNamed
    const security = this.path(path)
    const owner = this.failures.ownerMissing ? null : security.owner
    this.writePointer(ownerSlot, owner === null ? null : this.register(owner))
    this.writePointer(daclSlot, security.dacl === null ? null : this.register(security.dacl))
    if (this.failures.descriptorMissing === true) {
      this.writePointer(descriptorSlot, null)
    } else {
      const descriptor = this.register(Buffer.alloc(1))
      this.descriptorPaths.set(descriptor, security)
      this.writePointer(descriptorSlot, descriptor)
    }
    return 0
  }

  private readonly setNamedSecurityInfoW = (
    path: string,
    _objectType: number,
    information: number,
    _owner: null,
    _group: null,
    dacl: Buffer,
    _sacl: null,
  ): number => {
    if (this.failures.setNamedThrows === true) throw 'non-Error native binding failure'
    if (this.failures.setNamed !== undefined) return this.failures.setNamed
    const security = this.path(path)
    security.dacl = Buffer.from(dacl)
    security.protected = (information & PROTECTED_DACL_SECURITY_INFORMATION) !== 0
    return 0
  }

  private readonly createWellKnownSid = (
    type: number,
    _domain: null,
    destination: Buffer,
    size: bigint,
  ): number => {
    expect(type).toBe(WIN_LOCAL_SYSTEM_SID)
    if (this.failures.createSystemSid === true) return 0
    SYSTEM_SID.copy(destination)
    this.buffer(size).writeUInt32LE(SYSTEM_SID.byteLength)
    return 1
  }

  private readonly isValidSid = (): number => this.failures.invalidSystemSid === true ? 0 : 1

  private readonly getLengthSid = (value: Buffer | bigint): number => {
    if (this.failures.getLengthSid === true) return 0
    const valueBuffer = this.buffer(value)
    return 8 + (valueBuffer.readUInt8(1) * 4)
  }

  private readonly initializeAcl = (acl: Buffer, length: number, revision: number): number => {
    if (this.failures.initializeAcl === true) return 0
    acl.writeUInt8(revision)
    acl.writeUInt16LE(length, 2)
    acl.writeUInt16LE(0, 4)
    return 1
  }

  private readonly addAccessAllowedAceEx = (
    acl: Buffer,
    _revision: number,
    flags: number,
    mask: number,
    trustee: Buffer | bigint,
  ): number => {
    this.addAceCalls++
    if (this.failures.addAceAt === this.addAceCalls) return 0
    const trusteeBuffer = this.buffer(trustee)
    const sidLength = 8 + (trusteeBuffer.readUInt8(1) * 4)
    const aceSize = 8 + sidLength
    let offset = 8
    const count = acl.readUInt16LE(4)
    for (let index = 0; index < count; index++) {
      offset += acl.readUInt16LE(offset + 2)
    }
    acl.writeUInt8(0, offset)
    acl.writeUInt8(flags, offset + 1)
    acl.writeUInt16LE(aceSize, offset + 2)
    acl.writeUInt32LE(mask, offset + 4)
    trusteeBuffer.copy(acl, offset + 8, 0, sidLength)
    acl.writeUInt16LE(count + 1, 4)
    return 1
  }

  private readonly getSecurityDescriptorControl = (
    descriptor: bigint,
    control: bigint,
    revision: bigint,
  ): number => {
    if (this.failures.getControl === true) return 0
    const security = this.descriptorPaths.get(descriptor)
    if (security === undefined) throw new Error('fake descriptor is missing')
    this.buffer(control).writeUInt16LE(security.protected ? DACL_PROTECTED : 0)
    this.buffer(revision).writeUInt32LE(1)
    return 1
  }

  private readonly localFree = (descriptor: bigint): bigint | null => {
    if (this.failures.localFree === true) return descriptor
    this.memory.delete(descriptor)
    this.descriptorPaths.delete(descriptor)
    return null
  }

  private register(buffer: Buffer): bigint {
    const pointer = this.nextPointer++
    this.memory.set(pointer, buffer)
    return pointer
  }

  private buffer(value: unknown): Buffer {
    if (Buffer.isBuffer(value)) return value
    if (typeof value === 'bigint') {
      const buffer = this.memory.get(value)
      if (buffer !== undefined) return buffer
    }
    throw new Error('fake native pointer is invalid')
  }

  private writePointer(slot: bigint, value: bigint | null): void {
    this.buffer(slot).writeBigUInt64LE(value ?? 0n)
  }
}

afterEach(() => {
  vi.doUnmock('koffi')
  vi.resetModules()
})

async function moduleWith(fake: FakeWin32Acl): Promise<typeof import('../src/recovery-backup-win32.ts')> {
  vi.resetModules()
  vi.doMock('koffi', () => ({ default: fake.koffi }))
  return await import('../src/recovery-backup-win32.ts')
}

describe('Recovery Backup Win32 ACL', () => {
  it('builds and verifies exact directory, file, and LocalSystem-owner DACLs', async () => {
    const fake = new FakeWin32Acl()
    fake.addPath('C:\\backup')
    fake.addPath('C:\\backup\\state.sqlite')
    fake.addPath('C:\\system-owner', SYSTEM_SID)
    const module = await moduleWith(fake)

    await module.protectRecoveryBackupPathWin32(
      'C:\\backup',
      'directory',
      AbortSignal.timeout(2_000),
    )
    await module.protectRecoveryBackupPathWin32(
      'C:\\backup\\state.sqlite',
      'file',
      AbortSignal.timeout(2_000),
    )
    await module.protectRecoveryBackupPathWin32(
      'C:\\system-owner',
      'directory',
      AbortSignal.timeout(2_000),
    )

    expect(fake.path('C:\\backup')).toMatchObject({ protected: true })
    expect(fake.path('C:\\backup').dacl?.readUInt16LE(4)).toBe(2)
    expect(fake.path('C:\\backup').dacl?.readUInt8(9)).toBe(0x03)
    expect(fake.path('C:\\backup').dacl?.readUInt32LE(12)).toBe(FILE_ALL_ACCESS)
    expect(fake.path('C:\\backup\\state.sqlite').dacl?.readUInt8(9)).toBe(0)
    expect(fake.path('C:\\system-owner').dacl?.readUInt16LE(4)).toBe(1)
    expect(fake.loadedLibraries).toEqual(['advapi32.dll', 'kernel32.dll'])
  })

  it.each([
    ['NULL DACL', (security: FakePathSecurity) => { security.dacl = null }],
    ['unprotected DACL', (security: FakePathSecurity) => { security.protected = false }],
    ['extra trustee', (security: FakePathSecurity) => { requireDacl(security).writeUInt16LE(3, 4) }],
    ['truncated ACE header', (security: FakePathSecurity) => { requireDacl(security).writeUInt16LE(8, 2) }],
    ['truncated ACE', (security: FakePathSecurity) => { requireDacl(security).writeUInt16LE(8, 10) }],
    ['deny ACE', (security: FakePathSecurity) => { requireDacl(security).writeUInt8(1, 8) }],
    ['wrong inheritance', (security: FakePathSecurity) => { requireDacl(security).writeUInt8(0, 9) }],
    ['partial rights', (security: FakePathSecurity) => { requireDacl(security).writeUInt32LE(1, 12) }],
    ['ambient trustee', (security: FakePathSecurity) => {
      const dacl = requireDacl(security)
      AMBIENT_SID.copy(dacl, 16)
      dacl.writeUInt8(AMBIENT_SID.readUInt8(1), 17)
      dacl.writeUInt16LE(8 + AMBIENT_SID.byteLength, 10)
    }],
    ['revision-mismatched trustee', (security: FakePathSecurity) => {
      requireDacl(security).writeUInt8(2, 16)
    }],
    ['authority-mismatched trustee', (security: FakePathSecurity) => {
      const dacl = requireDacl(security)
      const second = 8 + dacl.readUInt16LE(10)
      dacl.writeUInt8(6, second + 15)
    }],
  ] as const)('rejects a %s', async (_label, corrupt) => {
    const fake = new FakeWin32Acl()
    const security = fake.addPath('C:\\backup')
    const module = await moduleWith(fake)
    await module.protectRecoveryBackupPathWin32(
      'C:\\backup',
      'directory',
      AbortSignal.timeout(2_000),
    )
    corrupt(security)

    await expect(module.requireRecoveryBackupPathOwnerOnlyWin32(
      'C:\\backup',
      'directory',
      AbortSignal.timeout(2_000),
    )).rejects.toThrow(/DACL|trustee|ACE/u)
  })

  it('rejects duplicated required trustees after structurally valid parsing', async () => {
    const shortOwner = sid([42])
    const fake = new FakeWin32Acl()
    const security = fake.addPath('C:\\duplicate', shortOwner)
    const module = await moduleWith(fake)
    await module.protectRecoveryBackupPathWin32(
      'C:\\duplicate',
      'directory',
      AbortSignal.timeout(2_000),
    )
    const dacl = requireDacl(security)
    const second = 8 + dacl.readUInt16LE(10)
    shortOwner.copy(dacl, second + 8)

    await expect(module.requireRecoveryBackupPathOwnerOnlyWin32(
      'C:\\duplicate',
      'directory',
      AbortSignal.timeout(2_000),
    )).rejects.toThrow(/required trustee/u)
  })

  it.each([
    ['GetNamedSecurityInfoW', { getNamed: 5 }],
    ['descriptor readback', { descriptorMissing: true }],
    ['owner readback', { ownerMissing: true }],
    ['owner readback and descriptor cleanup', { ownerMissing: true, localFree: true }],
    ['CreateWellKnownSid', { createSystemSid: true }],
    ['IsValidSid', { invalidSystemSid: true }],
    ['GetLengthSid', { getLengthSid: true }],
    ['InitializeAcl', { initializeAcl: true }],
    ['AddAccessAllowedAceEx', { addAceAt: 1 }],
    ['SetNamedSecurityInfoW', { setNamed: 5 }],
    ['a non-Error native binding throw', { setNamedThrows: true }],
  ] as const)('fails closed when %s fails', async (_label, failures) => {
    const fake = new FakeWin32Acl(failures)
    fake.addPath('C:\\backup')
    const module = await moduleWith(fake)

    await expect(module.protectRecoveryBackupPathWin32(
      'C:\\backup',
      'directory',
      AbortSignal.timeout(2_000),
    )).rejects.toThrow()
  })

  it('reports security-control and descriptor-release failures without masking apply failures', async () => {
    const controlFake = new FakeWin32Acl()
    controlFake.addPath('C:\\control')
    const controlModule = await moduleWith(controlFake)
    await controlModule.protectRecoveryBackupPathWin32(
      'C:\\control',
      'directory',
      AbortSignal.timeout(2_000),
    )
    controlFake.failures.getControl = true
    await expect(controlModule.requireRecoveryBackupPathOwnerOnlyWin32(
      'C:\\control',
      'directory',
      AbortSignal.timeout(2_000),
    )).rejects.toThrow(/GetSecurityDescriptorControl/u)

    const cleanupFake = new FakeWin32Acl({ setNamed: 5, localFree: true })
    cleanupFake.addPath('C:\\cleanup')
    const cleanupModule = await moduleWith(cleanupFake)
    const failure = await cleanupModule.protectRecoveryBackupPathWin32(
      'C:\\cleanup',
      'file',
      AbortSignal.timeout(2_000),
    ).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toHaveLength(2)

    const cleanupOnlyFake = new FakeWin32Acl()
    cleanupOnlyFake.addPath('C:\\cleanup-only')
    const cleanupOnlyModule = await moduleWith(cleanupOnlyFake)
    await cleanupOnlyModule.protectRecoveryBackupPathWin32(
      'C:\\cleanup-only',
      'file',
      AbortSignal.timeout(2_000),
    )
    cleanupOnlyFake.failures.localFree = true
    await expect(cleanupOnlyModule.requireRecoveryBackupPathOwnerOnlyWin32(
      'C:\\cleanup-only',
      'file',
      AbortSignal.timeout(2_000),
    )).rejects.toThrow(/LocalFree/u)
  })

  it('preserves AbortSignal reasons before native work', async () => {
    const fake = new FakeWin32Acl()
    fake.addPath('C:\\backup')
    const module = await moduleWith(fake)
    const controller = new AbortController()
    const reason = new Error('cancel ACL work')
    controller.abort(reason)

    await expect(module.protectRecoveryBackupPathWin32(
      'C:\\backup',
      'directory',
      controller.signal,
    )).rejects.toBe(reason)
  })
})

function sid(subAuthorities: readonly number[]): Buffer {
  const value = Buffer.alloc(8 + (subAuthorities.length * 4))
  value.writeUInt8(1, 0)
  value.writeUInt8(subAuthorities.length, 1)
  value.writeUInt8(5, 7)
  for (const [index, subAuthority] of subAuthorities.entries()) {
    value.writeUInt32LE(subAuthority, 8 + (index * 4))
  }
  return value
}

function normalizePath(path: string): string {
  if (path.startsWith('\\\\?\\UNC\\')) return `\\\\${path.slice('\\\\?\\UNC\\'.length)}`
  return path.startsWith('\\\\?\\') ? path.slice('\\\\?\\'.length) : path
}

function isPointerType(value: unknown): value is PointerType {
  return value !== null
    && typeof value === 'object'
    && 'kind' in value
    && value.kind === 'pointer'
}

function asNumber(value: unknown): number {
  if (typeof value !== 'number') throw new Error('fake koffi offset is not numeric')
  return value
}

function requireDacl(security: FakePathSecurity): Buffer {
  if (security.dacl === null) throw new Error('test requires a DACL')
  return security.dacl
}
