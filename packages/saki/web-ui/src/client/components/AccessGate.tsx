/**
 * Access gate for the Saki surface: reads the display-safe Access Projection
 * and renders bootstrap / session / unavailable states with text-first
 * semantics. The secret input clears itself from state on submit; the page
 * never renders Projection content before authentication resolves.
 */
import { useState } from 'react'
import type { SakiWireAccessExchangeResult, SakiWireAccessProjection } from '@breakfastdapaidang/saki-host-api/wire'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from '../locales.ts'
import css from './AccessGate.module.css'

/** Props for the access gate. */
export interface AccessGateProps {
  /** Current access state (null while the first read is in flight). */
  access: SakiWireAccessProjection | null
  /** Submit the launcher secret; resolves to the exchange outcome. */
  exchange: (secret: string) => Promise<SakiWireAccessExchangeResult>
  /** Re-read the access projection. */
  reload: () => void
  t: TranslateNS<typeof NS>
}

/**
 * Render the access gate for the current access state.
 * @param props - access state and callbacks.
 * @returns the gate element, or nothing when authenticated.
 */
export function AccessGate(props: AccessGateProps) {
  const { t } = props
  const [secret, setSecret] = useState('')
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)

  const submit = async () => {
    setPending(true)
    setFailed(false)
    // The secret clears from component state on submit, whatever the outcome.
    const value = secret
    setSecret('')
    try {
      const result = await props.exchange(value)
      if (!result.ok) setFailed(true)
    } catch {
      setFailed(true)
    } finally {
      setPending(false)
    }
  }

  if (props.access === null) {
    return <p className={css.hint}>{t('workspace.loading')}</p>
  }
  if (props.access.kind === 'authenticated') return null

  const bootstrap = props.access.kind === 'bootstrap-required'
  const unavailable = props.access.kind === 'unavailable'
  return (
    <div className={css.gate} role="region" aria-label={t('access.bootstrap.title')}>
      <h2 className={css.title}>{unavailable ? t('access.unavailable.title') : bootstrap ? t('access.bootstrap.title') : t('access.session.title')}</h2>
      <p className={css.hint}>{unavailable ? t('access.unavailable.hint') : bootstrap ? t('access.bootstrap.hint') : t('access.session.hint')}</p>
      {unavailable ? (
        <button type="button" className={css.submit} onClick={props.reload}>{t('common.retry')}</button>
      ) : (
        <form
          className={css.form}
          onSubmit={(event) => {
            event.preventDefault()
            if (secret.trim() && !pending) void submit()
          }}
        >
          <input
            className={css.input}
            value={secret}
            onChange={(event) => { setSecret(event.target.value) }}
            placeholder={t('access.bootstrap.placeholder')}
            aria-label={t('access.bootstrap.placeholder')}
            autoComplete="off"
          />
          <button type="submit" className={css.submit} disabled={!secret.trim() || pending}>
            {bootstrap ? t('access.bootstrap.submit') : t('access.session.submit')}
          </button>
        </form>
      )}
      {failed ? <p className={css.error} role="alert">{t('access.exchange.failed')}</p> : null}
    </div>
  )
}
