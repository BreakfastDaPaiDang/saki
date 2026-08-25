import { useState } from 'react'
import { useProjection, useSubmitIntent } from '../../client/controlPlane'
import { navigate } from '../../client/navigation'
import type { ProjectIndexEntry } from '../../contract/types'
import { Button, Spinner } from '../../components/primitives'
import { Dialog } from '../../components/Dialog'
import { StateBadge } from '../../components/StateBadge'
import styles from './ProjectsPage.module.css'

/**
 * Projects address: the Installation's Development Projects with binding,
 * GitHub and Host health, plus attention counts. Opening one enters its
 * Development Workspace (the 「项目」 page). Resource Binding repair is owned
 * here (K1 registration/rebind flow), not in Project Settings.
 */
export function ProjectsPage() {
  const { envelope, refreshing, refresh } = useProjection<ProjectIndexEntry[]>('projects')
  const [repairTarget, setRepairTarget] = useState<ProjectIndexEntry | null>(null)

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>项目</h1>
          <p className={styles.subtitle}>选择一个 Development Project 进入工作。</p>
        </div>
        <Button onClick={refresh} disabled={refreshing}>{refreshing ? '刷新中…' : '刷新'}</Button>
      </header>

      {!envelope ? (
        <p className={styles.loading}><Spinner /> 正在读取 Project index…</p>
      ) : envelope.data.length === 0 ? (
        <div className={styles.empty}>
          <p>还没有登记任何 Development Project。</p>
          <Button variant="primary" onClick={() => navigate({ kind: 'bootstrap' })}>登记第一个项目</Button>
        </div>
      ) : (
        <ul className={styles.list}>
          {envelope.data.map((p) => (
            <li key={p.projectId} className={styles.itemRow}>
              <button type="button" className={styles.item} onClick={() => navigate({ kind: 'work', projectId: p.projectId })}>
                <span className={styles.itemMain}>
                  <span className={styles.itemName}>{p.name}</span>
                  <span className={styles.itemPath}>{p.directory}</span>
                </span>
                <span className={styles.itemStates}>
                  {p.bindingHealth === 'active' ? (
                    <StateBadge condition={{ kind: 'confirmed', confirmedAt: p.githubConfirmedAt }} compact />
                  ) : (
                    <StateBadge condition={{ kind: 'repair-required', detail: `目录不存在或不匹配（binding ${p.bindingHealth}）` }} compact />
                  )}
                  {p.mappingHealth === 'repair-required' ? (
                    <StateBadge condition={{ kind: 'repair-required', detail: 'GitHub 字段映射需要修复' }} compact />
                  ) : null}
                  {p.githubFreshness === 'offline' ? (
                    <StateBadge condition={{ kind: 'offline', source: 'GitHub 不可达，显示缓存' }} compact />
                  ) : null}
                  {p.automationPaused ? (
                    <StateBadge condition={{ kind: 'intervention-required', question: p.automationPauseReason ?? '自动化已暂停' }} compact />
                  ) : null}
                  {p.attentionCount > 0 ? <span className={styles.attention}>{p.attentionCount} 条待处理</span> : null}
                  {p.activeRuns > 0 ? <span className={styles.runs}>{p.activeRuns} 个运行中</span> : null}
                </span>
              </button>
              {p.bindingHealth === 'repair-required' ? (
                <Button variant="danger" onClick={() => setRepairTarget(p)} aria-label={`修复 ${p.name} 的 Resource Binding`}>
                  修复 Binding
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {repairTarget ? (
        <RepairBindingDialog project={repairTarget} revision={envelope?.revision ?? 0} onClose={() => setRepairTarget(null)} />
      ) : null}
    </div>
  )
}

/**
 * Binding repair stays attributed and destructive-free: it re-verifies an
 * existing directory; it never deletes files or Git resources.
 */
function RepairBindingDialog(props: { project: ProjectIndexEntry; revision: number; onClose: () => void }) {
  const { submit } = useSubmitIntent()
  const [pending, setPending] = useState(false)
  return (
    <Dialog
      title={`修复 Resource Binding · ${props.project.name}`}
      onClose={props.onClose}
      footer={
        <>
          <Button onClick={props.onClose} disabled={pending}>取消</Button>
          <Button
            variant="danger"
            disabled={pending}
            onClick={async () => {
              setPending(true)
              const receipt = await submit(
                { kind: 'repair-binding', projectId: props.project.projectId, directory: props.project.directory },
                { expectedRevision: props.revision, subject: 'projects' },
              )
              setPending(false)
              if (receipt.outcome?.type === 'confirmed') props.onClose()
            }}
          >
            {pending ? '修复中…' : '重新验证该目录'}
          </Button>
        </>
      }
    >
      <div className={styles.repairBody}>
        <p>
          观察到的损坏：目录 <span className={styles.mono}>{props.project.directory}</span> 不存在或不再匹配 worktree 观察。
        </p>
        <p>项目保持只读，历史可读。修复会重新验证该目录；不会删除文件或 Git 资源。</p>
      </div>
    </Dialog>
  )
}
