import { useState } from 'react'
import { useProjection, useSubmitIntent } from '../../client/controlPlane'
import type { AutomationProjection, ProjectIndexEntry, WorkspaceProjection } from '../../contract/types'
import { Button, Chip, Spinner } from '../../components/primitives'
import { Dialog } from '../../components/Dialog'
import { StateBadge } from '../../components/StateBadge'
import styles from './ProjectSettingsSection.module.css'

/**
 * 「项目」项目设置区段: Resource Binding、GitHub 映射、默认 Agent Profile、
 * Automation Policy 与同步状态的已确认事实。高风险操作先经过点名项目与
 * 资源的确认 Dialog，再携带 expected revision 提交 Intent。
 */
export function ProjectSettingsSection(props: { projectId: string }) {
  const { projectId } = props
  const workspace = useProjection<WorkspaceProjection>(`workspace:${projectId}`)
  const automation = useProjection<AutomationProjection>(`automation:${projectId}`)
  const projects = useProjection<ProjectIndexEntry[]>('projects')

  const error = workspace.error ?? automation.error ?? projects.error
  if (error) {
    return (
      <p role="alert" className={styles.error}>
        加载失败：{error}{' '}
        <Button
          onClick={() => {
            workspace.refresh()
            automation.refresh()
            projects.refresh()
          }}
        >
          重试
        </Button>
      </p>
    )
  }

  if (!workspace.envelope || !automation.envelope || !projects.envelope) {
    return (
      <p className={styles.loading}>
        <Spinner /> 正在读取项目设置 Projection…
      </p>
    )
  }

  const ws = workspace.envelope.data
  const policy = automation.envelope.data
  const entry = projects.envelope.data.find((p) => p.projectId === projectId)
  const projectName = entry?.name ?? projectId

  return (
    <div className={styles.stack}>
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
        {ws.bindingHealth !== 'active' ? (
          <RepairBindingAction projectId={projectId} projectName={projectName} workspace={ws} expectedRevision={workspace.envelope.revision} />
        ) : null}
      </section>

      <section className={styles.card} aria-label="GitHub 映射">
        <h3 className={styles.cardTitle}>GitHub 映射</h3>
        {entry ? (
          <p className={styles.mappingLine}>
            {entry.mappingHealth === 'ok' ? <Chip tone="ok">字段映射正常</Chip> : <Chip tone="danger">需要修复</Chip>}
          </p>
        ) : (
          <p className={styles.note}>项目索引中找不到该项目。</p>
        )}
        <p className={styles.note}>GitHub Projects v2 Status 与 item position 是远端权威。</p>
      </section>

      <section className={styles.card} aria-label="默认 Agent Profile">
        <h3 className={styles.cardTitle}>默认 Agent Profile</h3>
        <dl className={styles.facts}>
          <div>
            <dt>Profile</dt>
            <dd>Development Agent v4</dd>
          </div>
          <div>
            <dt>Route</dt>
            <dd>Codex · GPT-5（个人 Pro）</dd>
          </div>
        </dl>
        <p className={styles.note}>持久化关系使用稳定 Profile 标识，不使用显示名。</p>
      </section>

      <AutomationPolicyCard
        projectId={projectId}
        projectName={projectName}
        policy={policy}
        expectedRevision={automation.envelope.revision}
      />

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
// Resource Binding repair
// ---------------------------------------------------------------------------

function RepairBindingAction(props: { projectId: string; projectName: string; workspace: WorkspaceProjection; expectedRevision: number }) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const { submit } = useSubmitIntent()
  const brokenFact = props.workspace.blockedRecovery[0] ?? `目录 ${props.workspace.displayPath} 不存在或不再匹配 worktree 观察`

  return (
    <div className={styles.cardActions}>
      <Button variant="danger" onClick={() => setOpen(true)}>
        修复 Binding
      </Button>
      {open ? (
        <Dialog
          title={`修复 Resource Binding · ${props.projectName}`}
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button onClick={() => setOpen(false)} disabled={pending}>
                取消
              </Button>
              <Button
                variant="primary"
                disabled={pending}
                onClick={async () => {
                  setPending(true)
                  const receipt = await submit(
                    { kind: 'repair-binding', projectId: props.projectId, directory: props.workspace.displayPath },
                    props.expectedRevision,
                  )
                  setPending(false)
                  if (receipt.outcome?.type === 'confirmed') setOpen(false)
                }}
              >
                {pending ? '验证中…' : '重新验证该目录'}
              </Button>
            </>
          }
        >
          <div className={styles.confirmBody}>
            <p className={styles.confirmText}>项目「{props.projectName}」的 Resource Binding 需要修复。</p>
            <p className={styles.confirmFact}>
              观察到的事实：{brokenFact}（<code className={styles.mono}>{props.workspace.displayPath}</code>）。
            </p>
            <p className={styles.note}>修复不会删除文件或 Git 资源。</p>
          </div>
        </Dialog>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Automation Policy
// ---------------------------------------------------------------------------

function AutomationPolicyCard(props: { projectId: string; projectName: string; policy: AutomationProjection; expectedRevision: number }) {
  const { policy } = props
  const { submit } = useSubmitIntent()
  const [confirmResume, setConfirmResume] = useState(false)
  const [confirmException, setConfirmException] = useState(false)
  const [exceptionNote, setExceptionNote] = useState('')
  const [pending, setPending] = useState(false)

  const doResume = async () => {
    setPending(true)
    const receipt = await submit({ kind: 'resume-automation', projectId: props.projectId }, props.expectedRevision)
    setPending(false)
    if (receipt.outcome?.type === 'confirmed') setConfirmResume(false)
  }

  const doException = async () => {
    setPending(true)
    const receipt = await submit({ kind: 'budget-exception', projectId: props.projectId, note: exceptionNote }, props.expectedRevision)
    setPending(false)
    if (receipt.outcome?.type === 'confirmed') setConfirmException(false)
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
        <div>
          <dt>启用的动作</dt>
          <dd>
            <span className={styles.chipList}>
              {policy.enabledActions.map((action) => (
                <Chip key={action} tone="neutral">
                  {action}
                </Chip>
              ))}
            </span>
          </dd>
        </div>
      </dl>

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
            return (
              <tr key={limit.dimension} className={exhausted ? styles.limitExhausted : ''}>
                <td>{limit.dimension}</td>
                <td>{limit.limit}</td>
                <td>{limit.used}</td>
                <td>{exhausted ? <span className={styles.exhaustedText}>已耗尽</span> : '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>

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
            <Button variant="primary" onClick={() => setConfirmResume(true)}>
              恢复自动化
            </Button>
            <Button variant="danger" onClick={() => setConfirmException(true)}>
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
              <Button onClick={() => setConfirmResume(false)} disabled={pending}>
                取消
              </Button>
              <Button variant="primary" onClick={doResume} disabled={pending}>
                {pending ? '提交中…' : '确认恢复'}
              </Button>
            </>
          }
        >
          <div className={styles.confirmBody}>
            <p className={styles.confirmText}>将按当前 Automation Policy（revision {policy.policyRevision}）恢复项目「{props.projectName}」的自动化。</p>
            <p className={styles.note}>控制面会在提交时重新评估 Principal、Grant 与预算维度；恢复后新满足条件的工作项会被自动领取。</p>
          </div>
        </Dialog>
      ) : null}

      {confirmException ? (
        <Dialog
          title={`授权一次性预算例外 · ${props.projectName}`}
          onClose={() => setConfirmException(false)}
          footer={
            <>
              <Button onClick={() => setConfirmException(false)} disabled={pending}>
                取消
              </Button>
              <Button variant="danger" onClick={doException} disabled={pending}>
                {pending ? '提交中…' : '确认授权例外'}
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
          </div>
        </Dialog>
      ) : null}
    </section>
  )
}
