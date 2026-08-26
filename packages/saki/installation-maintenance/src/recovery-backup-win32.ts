/**
 * Protected Windows DACLs for immutable Recovery Backup paths. Each DACL
 * contains only the object's owner and LocalSystem so Windows maintenance can
 * still operate without inheriting ambient user or group access.
 */

import { toNamespacedPath } from 'node:path'

/** Filesystem object class whose exact Recovery Backup DACL is enforced. */
export type RecoveryBackupWindowsPathKind = 'directory' | 'file'

const ERROR_SUCCESS = 0
const SE_FILE_OBJECT = 1
const OWNER_SECURITY_INFORMATION = 0x00000001
const DACL_SECURITY_INFORMATION = 0x00000004
const PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000
const SE_DACL_PROTECTED = 0x1000
const ACL_REVISION = 2
const ACCESS_ALLOWED_ACE_TYPE = 0
const SUB_CONTAINERS_AND_OBJECTS_INHERIT = 0x03
const FILE_ALL_ACCESS = 0x001f01ff
const WIN_LOCAL_SYSTEM_SID = 22
const SECURITY_MAX_SID_SIZE = 68
const ACL_HEADER_BYTES = 8
const ACCESS_ALLOWED_ACE_PREFIX_BYTES = 8
const SID_HEADER_BYTES = 8
const SID_MAX_SUB_AUTHORITIES = 15

declare const nativePointerBrand: unique symbol
type NativePointer = bigint & { readonly [nativePointerBrand]: true }
type NativeMemory = NativePointer | Buffer

type GetNamedSecurityInfoW = (
  path: string,
  objectType: number,
  information: number,
  owner: NativePointer,
  group: NativePointer,
  dacl: NativePointer,
  sacl: NativePointer,
  descriptor: NativePointer,
) => number
type SetNamedSecurityInfoW = (
  path: string,
  objectType: number,
  information: number,
  owner: null,
  group: null,
  dacl: NativeMemory,
  sacl: null,
) => number
type CreateWellKnownSid = (
  type: number,
  domainSid: null,
  sid: Buffer,
  size: NativePointer,
) => number
type IsValidSid = (sid: NativeMemory) => number
type GetLengthSid = (sid: NativeMemory) => number
type InitializeAcl = (acl: Buffer, length: number, revision: number) => number
type AddAccessAllowedAceEx = (
  acl: Buffer,
  revision: number,
  flags: number,
  mask: number,
  sid: NativeMemory,
) => number
type GetSecurityDescriptorControl = (
  descriptor: NativePointer,
  control: NativePointer,
  revision: NativePointer,
) => number
type LocalFree = (memory: NativePointer) => NativePointer | null
type GetLastError = () => number

interface Win32AclBindings {
  readonly koffi: Koffi
  readonly pointerType: unknown
  readonly getNamedSecurityInfoW: GetNamedSecurityInfoW
  readonly setNamedSecurityInfoW: SetNamedSecurityInfoW
  readonly createWellKnownSid: CreateWellKnownSid
  readonly isValidSid: IsValidSid
  readonly getLengthSid: GetLengthSid
  readonly initializeAcl: InitializeAcl
  readonly addAccessAllowedAceEx: AddAccessAllowedAceEx
  readonly getSecurityDescriptorControl: GetSecurityDescriptorControl
  readonly localFree: LocalFree
  readonly getLastError: GetLastError
}

interface KoffiLibrary {
  func(convention: string, name: string, result: unknown, args: unknown[]): unknown
}

interface Koffi {
  pointer(type: unknown): unknown
  alloc(type: unknown, length: number): unknown
  encode(destination: unknown, type: unknown, value: unknown): void
  decode(source: unknown, type: unknown): unknown
  decode(source: unknown, offset: number, type: unknown): unknown
  load(path: string): KoffiLibrary
}

interface SecurityInfo {
  readonly owner: NativePointer
  readonly dacl: NativePointer | null
  readonly descriptor: NativePointer
}

let bindings: Win32AclBindings | undefined

/**
 * Replace one Recovery Backup path's DACL with protected Full Control grants
 * for its current owner and LocalSystem, then verify the applied ACL exactly.
 * @param path - existing file or directory to protect.
 * @param kind - whether descendant inheritance belongs on the two explicit ACEs.
 * @param signal - cancellation checked before and after each native sequence.
 */
export async function protectRecoveryBackupPathWin32(
  path: string,
  kind: RecoveryBackupWindowsPathKind,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  const api = await loadBindings()
  signal.throwIfAborted()
  const security = readSecurityInfo(api, path)
  let operationFailure: unknown
  try {
    const system = createLocalSystemSid(api)
    const inheritance = kind === 'directory' ? SUB_CONTAINERS_AND_OBJECTS_INHERIT : 0
    const trustees = sameSid(api, security.owner, system)
      ? [security.owner]
      : [security.owner, system]
    const acl = buildAcl(api, trustees, inheritance)
    signal.throwIfAborted()
    const information = (DACL_SECURITY_INFORMATION
      | PROTECTED_DACL_SECURITY_INFORMATION) >>> 0
    const result = api.setNamedSecurityInfoW(
      toNamespacedPath(path),
      SE_FILE_OBJECT,
      information,
      null,
      null,
      acl,
      null,
    )
    if (result !== ERROR_SUCCESS) throw win32ResultError('SetNamedSecurityInfoW', result, path)
  } catch (error) {
    operationFailure = error
  }
  const cleanupFailure = releaseDescriptor(api, security.descriptor, path)
  throwCombined(operationFailure, cleanupFailure, `protecting Recovery Backup ACL '${path}' failed`)
  signal.throwIfAborted()
  await requireRecoveryBackupPathOwnerOnlyWin32(path, kind, signal)
}

/**
 * Require a protected DACL containing only exact Full Control ACEs for the
 * path's current owner and LocalSystem.
 * @param path - existing file or directory to inspect.
 * @param kind - whether the two explicit ACEs must inherit to descendants.
 * @param signal - cancellation checked before and after the native read.
 */
export async function requireRecoveryBackupPathOwnerOnlyWin32(
  path: string,
  kind: RecoveryBackupWindowsPathKind,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  const api = await loadBindings()
  signal.throwIfAborted()
  const security = readSecurityInfo(api, path)
  let operationFailure: unknown
  try {
    if (security.dacl === null) throw new Error('Recovery Backup path has a NULL DACL')
    requireProtectedDacl(api, security.descriptor, path)
    const system = createLocalSystemSid(api)
    requireExactAcl(api, security.dacl, security.owner, system, kind, path)
  } catch (error) {
    operationFailure = error
  }
  const cleanupFailure = releaseDescriptor(api, security.descriptor, path)
  throwCombined(operationFailure, cleanupFailure, `verifying Recovery Backup ACL '${path}' failed`)
  signal.throwIfAborted()
}

function readSecurityInfo(api: Win32AclBindings, path: string): SecurityInfo {
  const ownerSlot = allocate(api, api.pointerType)
  const groupSlot = allocate(api, api.pointerType)
  const daclSlot = allocate(api, api.pointerType)
  const saclSlot = allocate(api, api.pointerType)
  const descriptorSlot = allocate(api, api.pointerType)
  const result = api.getNamedSecurityInfoW(
    toNamespacedPath(path),
    SE_FILE_OBJECT,
    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    ownerSlot,
    groupSlot,
    daclSlot,
    saclSlot,
    descriptorSlot,
  )
  if (result !== ERROR_SUCCESS) throw win32ResultError('GetNamedSecurityInfoW', result, path)
  const owner = decodePointer(api, ownerSlot)
  const descriptor = decodePointer(api, descriptorSlot)
  if (descriptor === null) throw new Error(`GetNamedSecurityInfoW returned no descriptor for '${path}'`)
  if (owner === null) {
    const cleanupFailure = releaseDescriptor(api, descriptor, path)
    if (cleanupFailure !== undefined) {
      throw new AggregateError(
        [new Error(`Recovery Backup path '${path}' has no owner SID`), cleanupFailure],
        `reading Recovery Backup ACL '${path}' failed`,
      )
    }
    throw new Error(`Recovery Backup path '${path}' has no owner SID`)
  }
  return { owner, dacl: decodePointer(api, daclSlot), descriptor }
}

function createLocalSystemSid(api: Win32AclBindings): Buffer {
  const sid = Buffer.alloc(SECURITY_MAX_SID_SIZE)
  const size = allocate(api, 'uint32')
  api.koffi.encode(size, 'uint32', SECURITY_MAX_SID_SIZE)
  if (api.createWellKnownSid(WIN_LOCAL_SYSTEM_SID, null, sid, size) === 0) {
    throw lastError(api, 'CreateWellKnownSid', 'LocalSystem')
  }
  if (api.isValidSid(sid) === 0) throw lastError(api, 'IsValidSid', 'LocalSystem')
  return sid
}

function buildAcl(
  api: Win32AclBindings,
  trustees: readonly NativeMemory[],
  inheritance: number,
): Buffer {
  const lengths = trustees.map((trustee) => {
    const length = api.getLengthSid(trustee)
    if (length < SID_HEADER_BYTES) throw lastError(api, 'GetLengthSid', 'Recovery Backup trustee')
    return length
  })
  const byteLength = ACL_HEADER_BYTES + lengths.reduce(
    (total, length) => total + ACCESS_ALLOWED_ACE_PREFIX_BYTES + length,
    0,
  )
  const acl = Buffer.alloc(byteLength)
  if (api.initializeAcl(acl, acl.byteLength, ACL_REVISION) === 0) {
    throw lastError(api, 'InitializeAcl', 'Recovery Backup DACL')
  }
  for (const trustee of trustees) {
    if (api.addAccessAllowedAceEx(
      acl,
      ACL_REVISION,
      inheritance,
      FILE_ALL_ACCESS,
      trustee,
    ) === 0) {
      throw lastError(api, 'AddAccessAllowedAceEx', 'Recovery Backup DACL')
    }
  }
  return acl
}

function requireProtectedDacl(
  api: Win32AclBindings,
  descriptor: NativePointer,
  path: string,
): void {
  const control = allocate(api, 'uint16')
  const revision = allocate(api, 'uint32')
  if (api.getSecurityDescriptorControl(descriptor, control, revision) === 0) {
    throw lastError(api, 'GetSecurityDescriptorControl', path)
  }
  const value = decodeNumber(api, control, 'uint16')
  if ((value & SE_DACL_PROTECTED) === 0) {
    throw new Error(`Recovery Backup path '${path}' DACL is not protected`)
  }
}

function requireExactAcl(
  api: Win32AclBindings,
  dacl: NativePointer,
  owner: NativePointer,
  system: Buffer,
  kind: RecoveryBackupWindowsPathKind,
  path: string,
): void {
  const aclSize = decodeNumberAt(api, dacl, 2, 'uint16')
  const aceCount = decodeNumberAt(api, dacl, 4, 'uint16')
  const sameTrustee = sameSid(api, owner, system)
  const expectedCount = sameTrustee ? 1 : 2
  if (aclSize < ACL_HEADER_BYTES || aceCount !== expectedCount) {
    throw new Error(`Recovery Backup path '${path}' DACL has ambient or missing trustees`)
  }
  const expectedFlags = kind === 'directory' ? SUB_CONTAINERS_AND_OBJECTS_INHERIT : 0
  let ownerMatches = 0
  let systemMatches = 0
  let offset = ACL_HEADER_BYTES
  for (let index = 0; index < aceCount; index++) {
    if (offset + ACCESS_ALLOWED_ACE_PREFIX_BYTES > aclSize) {
      throw new Error(`Recovery Backup path '${path}' DACL has a malformed ACE header`)
    }
    const aceType = decodeNumberAt(api, dacl, offset, 'uint8')
    const aceFlags = decodeNumberAt(api, dacl, offset + 1, 'uint8')
    const aceSize = decodeNumberAt(api, dacl, offset + 2, 'uint16')
    const mask = decodeNumberAt(api, dacl, offset + 4, 'uint32')
    if (aceSize < ACCESS_ALLOWED_ACE_PREFIX_BYTES + SID_HEADER_BYTES
      || offset + aceSize > aclSize) {
      throw new Error(`Recovery Backup path '${path}' DACL has a malformed ACE`)
    }
    const subAuthorityCount = decodeNumberAt(api, dacl, offset + 9, 'uint8')
    const sidLength = SID_HEADER_BYTES + (subAuthorityCount * 4)
    if (subAuthorityCount > SID_MAX_SUB_AUTHORITIES
      || aceSize !== ACCESS_ALLOWED_ACE_PREFIX_BYTES + sidLength
      || aceType !== ACCESS_ALLOWED_ACE_TYPE
      || aceFlags !== expectedFlags
      || mask !== FILE_ALL_ACCESS) {
      throw new Error(`Recovery Backup path '${path}' DACL has a non-owner-only ACE`)
    }
    if (sameSidAt(api, dacl, offset + ACCESS_ALLOWED_ACE_PREFIX_BYTES, owner, 0)) {
      ownerMatches++
    } else if (sameSidAt(api, dacl, offset + ACCESS_ALLOWED_ACE_PREFIX_BYTES, system, 0)) {
      systemMatches++
    } else {
      throw new Error(`Recovery Backup path '${path}' DACL names an ambient trustee`)
    }
    offset += aceSize
  }
  if (ownerMatches !== 1 || (!sameTrustee && systemMatches !== 1)) {
    throw new Error(`Recovery Backup path '${path}' DACL does not name each required trustee once`)
  }
}

function sameSid(
  api: Win32AclBindings,
  left: NativeMemory,
  right: NativeMemory,
): boolean {
  return sameSidAt(api, left, 0, right, 0)
}

function sameSidAt(
  api: Win32AclBindings,
  left: NativeMemory,
  leftOffset: number,
  right: NativeMemory,
  rightOffset: number,
): boolean {
  const leftRevision = decodeNumberAt(api, left, leftOffset, 'uint8')
  const rightRevision = decodeNumberAt(api, right, rightOffset, 'uint8')
  if (leftRevision !== rightRevision) return false
  const leftCount = decodeNumberAt(api, left, leftOffset + 1, 'uint8')
  const rightCount = decodeNumberAt(api, right, rightOffset + 1, 'uint8')
  if (leftCount !== rightCount || leftCount > SID_MAX_SUB_AUTHORITIES) return false
  for (let index = 0; index < 6; index++) {
    if (decodeNumberAt(api, left, leftOffset + 2 + index, 'uint8')
      !== decodeNumberAt(api, right, rightOffset + 2 + index, 'uint8')) return false
  }
  for (let index = 0; index < leftCount; index++) {
    if (decodeNumberAt(api, left, leftOffset + 8 + (index * 4), 'uint32')
      !== decodeNumberAt(api, right, rightOffset + 8 + (index * 4), 'uint32')) return false
  }
  return true
}

function releaseDescriptor(
  api: Win32AclBindings,
  descriptor: NativePointer,
  path: string,
): Error | undefined {
  const result = api.localFree(descriptor)
  return isNullPointer(result)
    ? undefined
    : new Error(`LocalFree failed while releasing Recovery Backup ACL '${path}'`)
}

function throwCombined(operation: unknown, cleanup: Error | undefined, message: string): void {
  if (operation !== undefined && cleanup !== undefined) {
    throw new AggregateError([asError(operation, message), cleanup], message)
  }
  if (operation !== undefined) throw asError(operation, message)
  if (cleanup !== undefined) throw cleanup
}

function asError(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message, { cause: value })
}

function allocate(api: Win32AclBindings, type: unknown): NativePointer {
  return api.koffi.alloc(type, 1) as NativePointer
}

function decodePointer(api: Win32AclBindings, slot: NativePointer): NativePointer | null {
  const value = api.koffi.decode(slot, api.pointerType) as NativePointer | null | undefined
  return isNullPointer(value) ? null : value
}

function decodeNumber(
  api: Win32AclBindings,
  source: NativeMemory,
  type: 'uint16' | 'uint32',
): number {
  return api.koffi.decode(source, type) as number
}

function decodeNumberAt(
  api: Win32AclBindings,
  source: NativeMemory,
  offset: number,
  type: 'uint8' | 'uint16' | 'uint32',
): number {
  return api.koffi.decode(source, offset, type) as number
}

function isNullPointer(value: NativePointer | null | undefined): value is null | undefined {
  return value === null || value === undefined || (value as bigint) === 0n
}

function lastError(api: Win32AclBindings, syscall: string, detail: string): Error {
  return win32ResultError(syscall, api.getLastError(), detail)
}

function win32ResultError(syscall: string, win32Code: number, detail: string): Error {
  return new Error(`${syscall} failed (Win32 ${win32Code}): ${detail}`)
}

async function loadBindings(): Promise<Win32AclBindings> {
  if (bindings !== undefined) return bindings
  const koffi = (await import('koffi')).default as unknown as Koffi
  const pointerType = koffi.pointer('void')
  const pointerToPointer = koffi.pointer(pointerType)
  const advapi32 = koffi.load('advapi32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  const bind = (
    library: KoffiLibrary,
    name: string,
    result: unknown,
    args: unknown[],
  ): unknown => library.func('__stdcall', name, result, args)
  bindings = {
    koffi,
    pointerType,
    getNamedSecurityInfoW: bind(advapi32, 'GetNamedSecurityInfoW', 'uint32', [
      'str16', 'int', 'uint32', pointerToPointer, pointerToPointer,
      pointerToPointer, pointerToPointer, pointerToPointer,
    ]) as GetNamedSecurityInfoW,
    setNamedSecurityInfoW: bind(advapi32, 'SetNamedSecurityInfoW', 'uint32', [
      'str16', 'int', 'uint32', pointerType, pointerType, pointerType, pointerType,
    ]) as SetNamedSecurityInfoW,
    createWellKnownSid: bind(advapi32, 'CreateWellKnownSid', 'int', [
      'int', pointerType, pointerType, koffi.pointer('uint32'),
    ]) as CreateWellKnownSid,
    isValidSid: bind(advapi32, 'IsValidSid', 'int', [pointerType]) as IsValidSid,
    getLengthSid: bind(advapi32, 'GetLengthSid', 'uint32', [pointerType]) as GetLengthSid,
    initializeAcl: bind(advapi32, 'InitializeAcl', 'int', [
      pointerType, 'uint32', 'uint32',
    ]) as InitializeAcl,
    addAccessAllowedAceEx: bind(advapi32, 'AddAccessAllowedAceEx', 'int', [
      pointerType, 'uint32', 'uint32', 'uint32', pointerType,
    ]) as AddAccessAllowedAceEx,
    getSecurityDescriptorControl: bind(advapi32, 'GetSecurityDescriptorControl', 'int', [
      pointerType, koffi.pointer('uint16'), koffi.pointer('uint32'),
    ]) as GetSecurityDescriptorControl,
    localFree: bind(kernel32, 'LocalFree', pointerType, [pointerType]) as LocalFree,
    getLastError: bind(kernel32, 'GetLastError', 'uint32', []) as GetLastError,
  }
  return bindings
}
