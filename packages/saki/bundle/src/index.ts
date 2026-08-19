/**
 * Empty Saki application readiness provider and post-boot announcer.
 * @module @breakfastdapaidang/saki-bundle
 */

import type { Context } from '@deepseek-ai/cordis'

/** Stable Cordis plugin name. */
export const name = 'saki-readiness'
/** The readiness provider has no service prerequisites. */
export const inject: readonly string[] = []

/** Deterministic repository-launch readiness record. */
export const SAKI_READY_RECORD = Object.freeze({ product: 'saki', status: 'ready' } as const)

/** Process effects used only after the complete plugin tree passes activation audit. */
export interface SakiReadinessIo {
  /** Destination for the one-line readiness record. */
  stdout: { write(chunk: string): unknown }
  /** Launcher-owned clean-exit request. */
  exit(code: number): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Record contributed by the activated Saki composition. */
    sakiReadiness: typeof SAKI_READY_RECORD
  }
}

/**
 * Publish the readiness record while this plugin fiber remains active.
 * @param ctx - plugin context that owns the provided record.
 */
export function apply(ctx: Context): void {
  ctx.provide('sakiReadiness', SAKI_READY_RECORD)
}

/**
 * Announce readiness only after boot and its final entry-activation audit succeed.
 * A reporting failure disposes the booted tree before it is returned to the launcher.
 * @param startup - complete application boot, including the activation audit.
 * @param io - launcher-owned stdout and clean-exit request.
 * @param options - readiness-process behavior after the record is written.
 * @returns the audited application context after readiness is requested.
 */
export async function announceSakiReadiness(
  startup: Promise<Context>,
  io: SakiReadinessIo,
  options: { readonly exitAfterAnnounce?: boolean } = {},
): Promise<Context> {
  const ctx = await startup
  try {
    const record = ctx.get('sakiReadiness')
    if (record === undefined) throw new Error('saki: activated bundle did not provide sakiReadiness')
    io.stdout.write(`${JSON.stringify(record)}\n`)
    if (options.exitAfterAnnounce !== false) io.exit(0)
    return ctx
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}
