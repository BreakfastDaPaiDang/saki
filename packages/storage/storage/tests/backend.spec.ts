import { describe, expect, it } from 'vitest'
import { ClosedUnitReservations } from '../src/index.ts'

describe('closed-unit reservations', () => {
  it('tracks one exclusive reservation until its idempotent release', async () => {
    const reservations = new ClosedUnitReservations()
    const release = reservations.reserve('control')
    const [settled] = reservations.settlements()

    expect(reservations.has('control')).toBe(true)
    expect(() => reservations.reserve('control')).toThrow(/already reserved/)

    release()
    release()
    await expect(settled).resolves.toBeUndefined()
    expect(reservations.has('control')).toBe(false)
    expect(reservations.settlements()).toEqual([])
  })

  it('does not let an old release clear a replacement reservation', async () => {
    const reservations = new ClosedUnitReservations()
    const releaseFirst = reservations.reserve('control')
    releaseFirst()
    const releaseSecond = reservations.reserve('control')
    const [secondSettled] = reservations.settlements()

    releaseFirst()
    expect(reservations.has('control')).toBe(true)

    releaseSecond()
    await expect(secondSettled).resolves.toBeUndefined()
  })
})
