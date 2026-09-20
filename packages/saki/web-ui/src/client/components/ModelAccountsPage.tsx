/** Account authorization, observed usage and explicit activation controls. */
import { useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from '../locales.ts'
import type { ModelAccountsActions, ModelAccountsSnapshot } from '../model-accounts-controller.ts'
import css from './ModelAccountsPage.module.css'

/**
 * Render credential-free account facts and deliberate account gestures.
 * @param props - Host-backed inventory, actions and localized copy.
 * @returns account management page.
 */
export function ModelAccountsPage(props: { state: ModelAccountsSnapshot; actions: ModelAccountsActions; t: TranslateNS<typeof NS> }) {
  const { state, actions, t } = props
  const [name, setName] = useState('')
  const [names, setNames] = useState<Record<string, string>>({})
  return <section className={css.page}>
    <header className={css.header}><div><h1>{t('accounts.title')}</h1><p>{t('accounts.help')}</p></div>
      <button type="button" disabled={state.loading} onClick={() => { void actions.refresh() }}>{t('accounts.refresh')}</button></header>
    {state.failure !== null ? <p role="alert">{t(`accounts.failure.${state.failure}`)}</p> : null}
    <section className={css.card}>
      <h2>{t('accounts.connect')}</h2>
      <p>{t('accounts.importHelp')}</p>
      <label>{t('accounts.name')}<input value={name} onChange={(event) => { setName(event.target.value) }} maxLength={200} /></label>
      <div className={css.actions}>{state.supply?.providers.map(provider => provider.methods.map(method =>
        <button type="button" key={`${provider.id}:${method.id}`} disabled={name.trim() === '' || state.pending.length > 0}
          onClick={() => { void actions.submit({ type: 'authorize-model-account', providerId: provider.id,
            name, method: method.id, configuration: method.kind === 'stored-credential' ? { connection: method.id } : {} }) }}>
          {provider.id} · {t(method.kind === 'stored-credential' ? 'accounts.import' : method.kind === 'browser' ? 'accounts.browser' : 'accounts.device')}
          {method.name === undefined ? null : ` · ${method.name}`}
        </button>))}</div>
    </section>
    {state.pending.map(intent => <div className={css.card} key={intent.intentId}>
      <p>{t('accounts.unacknowledged')}</p><button type="button" onClick={() => { void actions.retry(intent) }}>{t('accounts.retry')}</button>
    </div>)}
    {state.supply?.authorizations.map(authorization => <section className={css.card} key={authorization.intentId}>
      <h2>{t('accounts.authorization')}</h2><p>{t(`accounts.authorization.${authorization.state}`)}</p>
      {authorization.progress?.kind === 'browser' || authorization.progress?.kind === 'device-code' ?
        <a href={authorization.progress.verificationUri} target="_blank" rel="noreferrer">{t('accounts.openAuthorization')}</a> : null}
      {authorization.progress?.kind === 'device-code' ? <>
        <p className={css.code}>{authorization.progress.userCode}</p>
        <p>{t('accounts.expires')} <time dateTime={new Date(authorization.progress.expiresAt).toISOString()}>{new Date(authorization.progress.expiresAt).toLocaleString()}</time></p>
      </> : null}
      {authorization.state === 'accepted' || authorization.state === 'authorizing' ?
        <button type="button" onClick={() => { void actions.submit({ type: 'cancel-model-authorization', authorizationIntentId: authorization.intentId }) }}>{t('accounts.cancel')}</button> : null}
    </section>)}
    {state.supply?.profiles.map(profile => <section className={css.card} key={profile.id}>
      <header className={css.header}><h2>{profile.name}</h2><span>{t(profile.effectiveActive ? 'accounts.active' : profile.desiredActive ? 'accounts.waiting' : 'accounts.inactive')}</span></header>
      <p>{profile.providerId} · {profile.snapshot === null ? t('accounts.unknown') : t(`accounts.auth.${profile.snapshot.authentication}`)}</p>
      <label>{t('accounts.name')}<input value={names[profile.id] ?? profile.name} maxLength={200}
        onChange={(event) => { setNames(current => ({ ...current, [profile.id]: event.target.value })) }} /></label>
      <div className={css.actions}>
        {state.supply?.providers.find(provider => provider.id === profile.providerId)?.methods.map(method =>
          <button type="button" key={method.id} onClick={() => { void actions.submit({ type: 'authorize-model-account',
            providerId: profile.providerId, name: profile.name, method: method.id,
            ...method.kind === 'stored-credential' ? { configuration: { connection: method.id } } : {},
            existing: { profileId: profile.id, expectedRevision: profile.revision } }) }}>{t('accounts.reauthorize')} · {t(method.kind === 'stored-credential' ? 'accounts.import' : method.kind === 'browser' ? 'accounts.browser' : 'accounts.device')}{method.name === undefined ? null : ` · ${method.name}`}</button>)}
        <button type="button" disabled={(names[profile.id] ?? profile.name).trim() === ''} onClick={() => {
          void actions.submit({ type: 'rename-model-account', profileId: profile.id, expectedRevision: profile.revision, name: names[profile.id] ?? profile.name })
        }}>{t('accounts.rename')}</button>
        <button type="button" onClick={() => { void actions.submit({ type: 'refresh-model-account', profileId: profile.id, expectedRevision: profile.revision }) }}>{t('accounts.refreshUsage')}</button>
        <button type="button" disabled={!profile.connected} onClick={() => { void actions.submit({ type: 'set-model-account-active', profileId: profile.id, expectedRevision: profile.revision, active: !profile.desiredActive }) }}>{t(profile.desiredActive ? 'accounts.deactivate' : 'accounts.activate')}</button>
        <button type="button" disabled={!profile.connected} onClick={() => { void actions.submit({ type: 'disconnect-model-account', profileId: profile.id, expectedRevision: profile.revision }) }}>{t('accounts.disconnect')}</button>
      </div>
      <h3>{t('accounts.usage')}</h3>
      {profile.snapshot?.usage.state !== 'available' ? <p>{t(profile.snapshot?.usage.state === 'unsupported' ? 'accounts.usage.unsupported' : 'accounts.usage.unavailable')}</p> : null}
      {profile.lastConfirmedUsage !== null ? <>
        <p>{t('accounts.observed')} {new Date(profile.lastConfirmedUsage.observedAt).toLocaleString()}</p>
        <ul>{profile.lastConfirmedUsage.windows.map(window => <li key={window.id}>
          {window.id}: {window.remaining}{window.unit === 'percent' ? '%' : ` ${t(`accounts.unit.${window.unit}`)}`}
          {window.resetsAt === null ? null : <> · {t('accounts.resets')} {new Date(window.resetsAt).toLocaleString()}</>}
        </li>)}</ul>
      </> : null}
      <details><summary>{t('accounts.models')}</summary><ul>{profile.snapshot?.models.map(model => <li key={model.id}>{model.name}</li>)}</ul></details>
    </section>)}
    {state.supply?.profiles.length === 0 ? <p>{t('accounts.empty')}</p> : null}
  </section>
}
