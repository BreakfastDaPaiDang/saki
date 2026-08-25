import { useState } from 'react'
import { useControlPlane, useProjection, useSubmitIntent } from '../../client/controlPlane'
import { navigate } from '../../client/navigation'
import type { AutomationProjection, ProjectConfigProjection, ProjectIndexEntry, WorkspaceProjection } from '../../contract/types'
import { advanceSyncActivation } from '../../fixtures/shared'
import { Button, Chip, Spinner } from '../../components/primitives'
import { Dialog } from '../../components/Dialog'
import { StateBadge } from '../../components/StateBadge'
import styles from './ProjectSettingsSection.module.css'

/**
 * 「项目」项目设置区段: the K7 owner flows. 默认 Agent Profile、Automation
 * Policy 与同步配置 are editable through field-scoped Intents carrying the
 * expected Projection revision; Resource Binding 与 GitHub 映射 stay read-only
 * here and route repair to their owning flows. A stale revision surfaces as a
 * conflict message and refreshes the affected Projection.
 */
export function ProjectSettingsSection(props: { projectId: string }) {
  const { projectId } = props
  const workspace = useProjection<WorkspaceProjection>(`workspace:${projectId}`)
  const automation = useProjection<AutomationProjection>(`automation:${projectId}`)
  const config = useProjection<ProjectConfigProjection>(`project-config:${projectId}`)
  const projects = useProjection<ProjectIndexEntry[]>('projects')

  const error = workspace.error ?? automation.error ?? config.error ?? projects.error
  if (error) {
    return (
      <p role="alert" className={styles.error}>
        加载失败：{error}{' '}
        <Button
          onClick={() => {
            workspace.refresh()
            automation.refresh()
            config.refresh()
            projects.refresh()
          }}
        >
          重试
        </Button>
      </p>
    )
  }

  if (!workspace.envelope || !automation.envelope || !config.envelope || !projects.envelope) {
    return (
      <p className={styles.loading}>
        <Spinner /> 正在读取项目设置 Projection…
      </p>
    )
  }

  const entry = projects.envelope.data.find((p) => p.projectId === projectId)
  const projectName = entry?.name ?? projectId

  return (
    <div className={styles.stack}>
      <BindingCard ws={workspace.envelope.data} />
      <MappingCard entry={entry} projectId={projectId} />
      <AgentProfileCard
        projectId={projectId}
        config={config.envelope.data}
        revision={config.envelope.revision}
        refresh={config.refresh}
      />
      <AutomationPolicyCard
        projectId={projectId}
        projectName={projectName}
        policy={automation.envelope.data}
        expectedRevision={automation.envelope.revision}
        refresh={automation.refresh}
      />
      <SyncConfigCard
        projectId={projectId}
        config={config.envelope.data}
        revision={config.envelope.revision}
        refresh={config.refresh}
      />
      <SyncStatusCard entry={entry} />
      <section className={styles.card} aria-label="退役项目">
        <h3 className={styles.cardTitle}>退役 Development Project</h3>
        <p className={styles.note}>退役会把项目从历史中归档，Resource Binding 与 GitHub 映射一并解除。</p>
        <div className={styles.cardActions}>
          <Button variant="danger" disabled aria-label={`退役项目 ${projectName}（prototype 未覆盖）`}>
            退役项目
          </Button>
          <span className={styles.note}>prototype 未覆盖</span>
        </div>
      </section>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Resource Binding (read-only; repair belongs to the K1 owner flow)
// ---------------------------------------------------------------------------

function BindingCard(props: { ws: WorkspaceProjection }) {
  const { ws } = props
  return (
    <section className={styles.card} aria-label="Resource Binding">
      <h3 className={styles.cardTitle}>Resource Binding</h3>
      <dl className={styles.facts}>
        <div>
          <dt>目录</dt>
          <dd>
            <code className={styles.mono}>{ws.displayPath}</code>
          </dd>
        </div>
        <div>
          <dt>Binding revision</dt>
          <dd>{ws.bindingRevision}</dd>
        </div>
        <div>
          <dt>状态</dt>
          <dd>
            {ws.bindingHealth === 'active' ? (
              <StateBadge condition={{ kind: 'confirmed', confirmedAt: `binding revision ${ws.bindingRevision}` }} compact />
            ) : (
              <StateBadge
                condition={{ kind: 'repair-required', detail: '目录不存在或不再匹配 worktree 观察；项目保持只读，历史可读' }}
              />
            )}
          </dd>
        </div>
        <div>
          <dt>分支 / HEAD</dt>
          <dd>
            <code className={styles.mono}>{ws.branch}</code> · <code className={styles.mono}>{ws.head}</code>
          </dd>
        </div>
      </dl>
      <p className={styles.note}>修复由各自的 owner 流程承担（K1 登记/rebind、K3 mapping repair）。</p>
      {ws.bindingHealth !== 'active' ? (
        <div className={styles.cardActions}>
          <Button variant="ghost" className={styles.ownerLink} onClick={() => navigate({ kind: 'projects' })}>
            前往项目页修复
          </Button>
        </div>
      ) : null}
    </section>
  )
}

// ---------------------------------------------------------------------------
// GitHub 映射 (read-only; repair belongs to the K3 owner flow on the board)
// ---------------------------------------------------------------------------

function MappingCard(props: { entry: ProjectIndexEntry | undefined; projectId: string }) {
  const { entry } = props
  return (
    <section className={styles.card} aria-label="GitHub 映射">
      <h3 className={styles.cardTitle}>GitHub 映射</h3>
      {entry ? (
        <p className={styles.mappingLine}>
          {entry.mappingHealth === 'ok' ? <Chip tone="ok">字段映射正常</Chip> : <Chip tone="danger">需要修复</Chip>}
        </p>
      ) : (
        <p className={styles.note}>项目索引中找不到该项目。</p>
      )}
      <p className={styles.note}>GitHub Projects v2 Status 与 item position 是远端权威；映射修复由 K3 mapping repair 流程承担。</p>
      {entry && entry.mappingHealth === 'repair-required' ? (
        <div className={styles.cardActions}>
          <Button variant="ghost" className={styles.ownerLink} onClick={() => navigate({ kind: 'work', projectId: props.projectId })}>
            前往看板修复
          </Button>
        </div>
      ) : null}
    </section>
  )
}

// ---------------------------------------------------------------------------
// 默认 Agent Profile (editable, field-scoped to project-config)
// ---------------------------------------------------------------------------

function AgentProfileCard(props: { projectId: string; config: ProjectConfigProjection; revision: number; refresh: () => void }) {
  const { config } = props
  const { submit } = useSubmitIntent()
  const [selected, setSelected] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [conflict, setConflict] = useState<string | null>(null)

  const current = config.availableProfiles.find((p) => p.profileId === config.defaultAgentProfileId)
  const value = selected ?? config.defaultAgentProfileId

  const doSave = async () => {
    setPending(true)
    setConflict(null)
    const receipt = await submit(
      { kind: 'set-default-agent-profile', projectId: props.projectId, profileId: value },
      { expectedRevision: props.revision, subject: `project-config:${props.projectId}` },
    )
    setPending(false)
    const outcome = receipt.outcome
    if (!outcome) return
    if (outcome.type === 'confirmed') {
      setSelected(null)
      return
    }
    setConflict(outcome.message)
    if (outcome.type === 'conflict') props.refresh()
  }

  return (
    <section className={styles.card} aria-label="默认 Agent Profile">
      <h3 className={styles.cardTitle}>默认 Agent Profile</h3>
      <dl className={styles.facts}>
        <div>
          <dt>当前 Profile</dt>
          <dd>{current?.label ?? config.defaultAgentProfileId}</dd>
        </div>
        <div>
          <dt>Route</dt>
          <dd>{current?.route ?? '—'}</dd>
        </div>
        <div>
          <dt>配置 revision</dt>
          <dd>{config.configRevision}</dd>
        </div>
      </dl>
      <label className={styles.field}>
        默认 Profile
        <select className={styles.select} value={value} disabled={pending} onChange={(e) => setSelected(e.target.value)} aria-label="选择默认 Agent Profile">
          {config.availableProfiles.map((p) => (
            <option key={p.profileId} value={p.profileId}>
              {p.label} · {p.route}
            </option>
          ))}
        </select>
      </label>
      <div className={styles.cardActions}>
        <Button variant="primary" disabled={pending || value === config.defaultAgentProfileId} onClick={doSave}>
          {pending ? '保存中…' : '保存'}
        </Button>
      </div>
      {conflict ? (
        <p role="alert" className={styles.conflictText}>
          {conflict}
        </p>
      ) : null}
      <p className={styles.note}>持久化关系使用稳定 Profile 标识，不使用显示名。</p>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Automation Policy (editable: triggerMode / actions / typed budgets)
// ---------------------------------------------------------------------------

function AutomationPolicyCard(props: {
  projectId: string
  projectName: string
  policy: AutomationProjection
  expectedRevision: number
  refresh: () => void
}) {
  const { policy } = props
  const { submit } = useSubmitIntent()
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const [conflict, setConflict] = useState<string | null>(null)
  const [limitDrafts, setLimitDrafts] = useState<Record<string, string>>({})
  const [confirmResume, setConfirmResume] = useState(false)
  const [confirmException, setConfirmException] = useState(false)
  const [exceptionNote, setExceptionNote] = useState('')
  const [dialogError, setDialogError] = useState<string | null>(null)

  /** Every policy edit is one field-scoped Intent against the automation Projection. */
  const submitField = async (key: string, field: string, value: string | boolean) => {
    setPendingKey(key)
    setConflict(null)
    const receipt = await submit(
      { kind: 'update-automation-policy', projectId: props.projectId, field, value },
      { expectedRevision: props.expectedRevision, subject: `automation:${props.projectId}` },
    )
    setPendingKey(null)
    const outcome = receipt.outcome
    if (!outcome) return
    if (outcome.type === 'confirmed') {
      if (key.startsWith('limit:')) {
        const dimension = key.slice('limit:'.length)
        setLimitDrafts((drafts) => {
          const next = { ...drafts }
          delete next[dimension]
          return next
        })
      }
      return
    }
    setConflict(outcome.message)
    if (outcome.type === 'conflict') props.refresh()
  }

  const doResume = async () => {
    setPendingKey('resume')
    setDialogError(null)
    const receipt = await submit(
      { kind: 'resume-automation', projectId: props.projectId },
      { expectedRevision: props.expectedRevision, subject: `automation:${props.projectId}` },
    )
    setPendingKey(null)
    const outcome = receipt.outcome
    if (!outcome) return
    if (outcome.type === 'confirmed') {
      setConfirmResume(false)
      return
    }
    setDialogError(outcome.message)
    if (outcome.type === 'conflict') props.refresh()
  }

  const doException = async () => {
    setPendingKey('exception')
    setDialogError(null)
    const receipt = await submit(
      { kind: 'budget-exception', projectId: props.projectId, note: exceptionNote },
      { expectedRevision: props.expectedRevision, subject: `automation:${props.projectId}` },
    )
    setPendingKey(null)
    const outcome = receipt.outcome
    if (!outcome) return
    if (outcome.type === 'confirmed') {
      setConfirmException(false)
      return
    }
    setDialogError(outcome.message)
    if (outcome.type === 'conflict') props.refresh()
  }

  return (
    <section className={styles.card} aria-label="Automation Policy">
      <h3 className={styles.cardTitle}>Automation Policy</h3>
      <dl className={styles.facts}>
        <div>
          <dt>Policy revision</dt>
          <dd>{policy.policyRevision}</dd>
        </div>
        <div>
          <dt>启用状态</dt>
          <dd>{policy.enabled ? <Chip tone="ok">已启用</Chip> : <Chip tone="neutral">未启用</Chip>}</dd>
        </div>
      </dl>

      <div role="radiogroup" aria-label="触发方式" className={styles.radioGroup}>
        <span className={styles.groupLabel}>触发方式</span>
        {(['manual', 'auto'] as const).map((mode) => (
          <label
            key={mode}
            className={[styles.radioLabel, policy.triggerMode === mode ? styles.radioLabelChecked : ''].join(' ')}
          >
            <input
              type="radio"
              name={`trigger-mode-${props.projectId}`}
              value={mode}
              checked={policy.triggerMode === mode}
              disabled={pendingKey === 'triggerMode'}
              onChange={() => submitField('triggerMode', 'triggerMode', mode)}
            />
            {mode === 'manual' ? '手动' : '自动'}
          </label>
        ))}
      </div>

      <div>
        <h4 className={styles.subTitle}>自动化动作</h4>
        <ul className={styles.actionList}>
          {policy.availableActions.map((action) => {
            const key = `action:${action.id}`
            const checked = policy.enabledActions.includes(action.label)
            return (
              <li key={action.id}>
                <label className={styles.checkLabel}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={pendingKey === key}
                    onChange={(e) => submitField(key, key, e.target.checked)}
                  />
                  {action.label}
                </label>
              </li>
            )
          })}
        </ul>
      </div>

      <div>
        <h4 className={styles.subTitle}>预算维度（类型化，可编辑）</h4>
        <table className={styles.limitTable}>
          <thead>
            <tr>
              <th scope="col">维度</th>
              <th scope="col">上限</th>
              <th scope="col">已用</th>
              <th scope="col">状态</th>
            </tr>
          </thead>
          <tbody>
            {policy.limits.map((limit) => {
              const exhausted = limit.used === limit.limit
              const key = `limit:${limit.dimension}`
              const draft = limitDrafts[limit.dimension] ?? limit.limit
              return (
                <tr key={limit.dimension} className={exhausted ? styles.limitExhausted : ''}>
                  <td>{limit.dimension}</td>
                  <td>
                    <span className={styles.limitEdit}>
                      <input
                        className={[styles.input, styles.limitInput].join(' ')}
                        value={draft}
                        disabled={pendingKey === key}
                        onChange={(e) => setLimitDrafts((drafts) => ({ ...drafts, [limit.dimension]: e.target.value }))}
                        aria-label={`${limit.dimension} 的上限`}
                      />
                      <Button
                        variant="ghost"
                        disabled={pendingKey === key || draft === limit.limit || !draft.trim()}
                        onClick={() => submitField(key, key, draft.trim())}
                        aria-label={`保存 ${limit.dimension} 的上限`}
                      >
                        {pendingKey === key ? '保存中…' : '保存'}
                      </Button>
                    </span>
                  </td>
                  <td>{limit.used}</td>
                  <td>{exhausted ? <span className={styles.exhaustedText}>已耗尽</span> : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div>
        <h4 className={styles.subTitle}>Outcome Evidence 规则</h4>
        <ul className={styles.evidenceList}>
          {policy.evidenceRules.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
        <p className={styles.note}>自动交付 / 自动 Done 需要以上 Outcome Evidence 全部满足；规则只读。</p>
      </div>

      {policy.reservations.length > 0 ? (
        <div>
          <h4 className={styles.subTitle}>Reservations</h4>
          <ul className={styles.reservationList}>
            {policy.reservations.map((r) => (
              <li key={r.id}>
                <code className={styles.mono}>{r.id}</code> · {r.scope} · {r.dimensions}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {conflict ? (
        <p role="alert" className={styles.conflictText}>
          {conflict}
        </p>
      ) : null}

      {policy.paused ? (
        <div className={styles.pauseBlock}>
          <StateBadge condition={{ kind: 'intervention-required', question: policy.pauseReason ?? '自动化已暂停' }} />
          {policy.unknownObservations.length > 0 ? (
            <ul className={styles.unknownList}>
              {policy.unknownObservations.map((obs) => (
                <li key={obs}>
                  <span aria-hidden>⚠ </span>
                  {obs}
                </li>
              ))}
            </ul>
          ) : null}
          <p className={styles.note}>未知观察保持可见；暂停绝不意味着工作已完成。</p>
          <div className={styles.cardActions}>
            <Button variant="primary" onClick={() => { setDialogError(null); setConfirmResume(true) }}>
              恢复自动化
            </Button>
            <Button variant="danger" onClick={() => { setDialogError(null); setConfirmException(true) }}>
              授权一次性预算例外
            </Button>
          </div>
        </div>
      ) : (
        <p className={styles.note}>自动化运行中或未启用。</p>
      )}

      {confirmResume ? (
        <Dialog
          title={`恢复自动化 · ${props.projectName}`}
          onClose={() => setConfirmResume(false)}
          footer={
            <>
              <Button onClick={() => setConfirmResume(false)} disabled={pendingKey === 'resume'}>
                取消
              </Button>
              <Button variant="primary" onClick={doResume} disabled={pendingKey === 'resume'}>
                {pendingKey === 'resume' ? '提交中…' : '确认恢复'}
              </Button>
            </>
          }
        >
          <div className={styles.confirmBody}>
            <p className={styles.confirmText}>将按当前 Automation Policy（revision {policy.policyRevision}）恢复项目「{props.projectName}」的自动化。</p>
            <p className={styles.note}>控制面会在提交时重新评估 Principal、Grant 与预算维度；恢复后新满足条件的工作项会被自动领取。</p>
            {dialogError ? (
              <p role="alert" className={styles.conflictText}>
                {dialogError}
              </p>
            ) : null}
          </div>
        </Dialog>
      ) : null}

      {confirmException ? (
        <Dialog
          title={`授权一次性预算例外 · ${props.projectName}`}
          onClose={() => setConfirmException(false)}
          footer={
            <>
              <Button onClick={() => setConfirmException(false)} disabled={pendingKey === 'exception'}>
                取消
              </Button>
              <Button variant="danger" onClick={doException} disabled={pendingKey === 'exception'}>
                {pendingKey === 'exception' ? '提交中…' : '确认授权例外'}
              </Button>
            </>
          }
        >
          <div className={styles.confirmBody}>
            <p className={styles.confirmText}>将为项目「{props.projectName}」记录一条一次性预算例外。</p>
            <p className={styles.confirmFact}>例外 24 小时后过期，且不扩张底层 Grant。</p>
            <label className={styles.field}>
              备注（可选）
              <textarea
                className={styles.textarea}
                rows={3}
                value={exceptionNote}
                onChange={(e) => setExceptionNote(e.target.value)}
                placeholder="例如：本周额度周期重置前的临时放行。"
              />
            </label>
            {dialogError ? (
              <p role="alert" className={styles.conflictText}>
                {dialogError}
              </p>
            ) : null}
          </div>
        </Dialog>
      ) : null}
    </section>
  )
}

// ---------------------------------------------------------------------------
// 同步配置 (editable; saving starts the visible activation chain)
// ---------------------------------------------------------------------------

const syncSteps: { state: 'saved' | 'revalidating' | 'scanning' | 'checkpointed' | 'activated'; label: string }[] = [
  { state: 'saved', label: '已保存（saved）' },
  { state: 'revalidating', label: '重新验证映射（revalidating）' },
  { state: 'scanning', label: '完整扫描（scanning）' },
  { state: 'checkpointed', label: '新 checkpoint（checkpointed）' },
  { state: 'activated', label: '已启用（activated）' },
]

function SyncConfigCard(props: { projectId: string; config: ProjectConfigProjection; revision: number; refresh: () => void }) {
  const { config } = props
  const { engine } = useControlPlane()
  const { submit } = useSubmitIntent()
  const [draft, setDraft] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [conflict, setConflict] = useState<string | null>(null)

  const value = draft ?? String(config.sync.pollingSeconds)
  const parsed = Number.parseInt(value, 10)
  const valid = Number.isFinite(parsed) && parsed > 0
  const changed = valid && parsed !== config.sync.pollingSeconds
  const currentStep = syncSteps.findIndex((s) => s.state === config.sync.state)

  const doSave = async () => {
    setPending(true)
    setConflict(null)
    const receipt = await submit(
      { kind: 'update-sync-config', projectId: props.projectId, pollingSeconds: parsed },
      { expectedRevision: props.revision, subject: `project-config:${props.projectId}` },
    )
    setPending(false)
    const outcome = receipt.outcome
    if (!outcome) return
    if (outcome.type === 'confirmed') {
      setDraft(null)
      // A confirmed save is only `saved`; Host-side pokes drive the chain to
      // `activated` and the Projection invalidation re-renders this stepper.
      advanceSyncActivation(engine, props.projectId)
      return
    }
    setConflict(outcome.message)
    if (outcome.type === 'conflict') props.refresh()
  }

  return (
    <section className={styles.card} aria-label="同步配置">
      <h3 className={styles.cardTitle}>同步配置</h3>
      <label className={styles.field}>
        GitHub 轮询间隔（秒）
        <input
          className={styles.input}
          type="number"
          min={1}
          step={1}
          value={value}
          disabled={pending}
          onChange={(e) => setDraft(e.target.value)}
        />
      </label>
      <div className={styles.cardActions}>
        <Button variant="primary" disabled={pending || !changed} onClick={doSave}>
          {pending ? '保存中…' : '保存同步配置'}
        </Button>
        <span className={styles.note}>最近启用：{config.sync.lastActivatedAt ?? '—'}</span>
      </div>

      <ol className={styles.stepper} aria-label="同步激活流程">
        {syncSteps.map((step, i) => {
          const stepClass = i < currentStep ? styles.stepDone : i === currentStep ? styles.stepCurrent : ''
          return (
            <li key={step.state} className={styles.stepItem}>
              <span className={[styles.step, stepClass].join(' ')} aria-current={i === currentStep ? 'step' : undefined}>
                <span aria-hidden>{i < currentStep ? '✓ ' : i === currentStep ? '● ' : '○ '}</span>
                {step.label}
              </span>
              {i < syncSteps.length - 1 ? (
                <span className={styles.stepArrow} aria-hidden>
                  →
                </span>
              ) : null}
            </li>
          )
        })}
      </ol>
      <p className={styles.note}>保存成功不等于已启用；激活链由 Host 侧逐步推进并重新确认。</p>
      {config.sync.state === 'idle' ? <p className={styles.note}>当前没有进行中的激活流程。</p> : null}
      {conflict ? (
        <p role="alert" className={styles.conflictText}>
          {conflict}
        </p>
      ) : null}
    </section>
  )
}

// ---------------------------------------------------------------------------
// 同步状态 (read-only freshness facts from the Project index)
// ---------------------------------------------------------------------------

function SyncStatusCard(props: { entry: ProjectIndexEntry | undefined }) {
  const { entry } = props
  return (
    <section className={styles.card} aria-label="同步状态">
      <h3 className={styles.cardTitle}>同步状态</h3>
      {entry ? (
        <dl className={styles.facts}>
          <div>
            <dt>最近确认</dt>
            <dd>{entry.githubConfirmedAt}</dd>
          </div>
          <div>
            <dt>新鲜度</dt>
            <dd>
              {entry.githubFreshness === 'fresh' ? (
                <StateBadge condition={{ kind: 'confirmed', confirmedAt: entry.githubConfirmedAt }} compact />
              ) : entry.githubFreshness === 'stale' ? (
                <StateBadge condition={{ kind: 'stale', confirmedAt: entry.githubConfirmedAt, source: '后台 5 分钟轮询' }} compact />
              ) : (
                <StateBadge condition={{ kind: 'offline', source: '离线，显示缓存' }} compact />
              )}
            </dd>
          </div>
        </dl>
      ) : (
        <p className={styles.note}>项目索引中找不到该项目。</p>
      )}
    </section>
  )
}
