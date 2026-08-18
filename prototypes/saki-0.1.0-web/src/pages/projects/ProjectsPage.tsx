import { useProjection } from '../../client/controlPlane'
import { navigate } from '../../client/navigation'
import type { ProjectIndexEntry } from '../../contract/types'
import { Button, Spinner } from '../../components/primitives'
import { StateBadge } from '../../components/StateBadge'
import styles from './ProjectsPage.module.css'

/**
 * Projects address: the Installation's Development Projects with binding,
 * GitHub and Host health, plus attention counts. Opening one enters its
 * Development Workspace (the 「项目」 page).
 */
export function ProjectsPage() {
  const { envelope, refreshing, refresh } = useProjection<ProjectIndexEntry[]>('projects')

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
            <li key={p.projectId}>
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
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
