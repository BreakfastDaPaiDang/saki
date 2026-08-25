import { useProjection } from '../../client/controlPlane'
import type { MilestoneEntry, WorkItemStatus } from '../../contract/types'
import { Button, Chip, EmptyHint, Spinner } from '../../components/primitives'
import styles from './MilestonesSection.module.css'

/**
 * 「项目」里程碑区段: renders the Milestone list Projection. Status counts are
 * confirmed GitHub facts; the client only formats them, never derives phase.
 */

const phaseMeta: Record<MilestoneEntry['phase'], { label: string; tone: 'info' | 'warn' | 'ok' | 'neutral' }> = {
  planned: { label: '计划中', tone: 'neutral' },
  'in-progress': { label: '进行中', tone: 'info' },
  'ready-to-release': { label: '待发布', tone: 'warn' },
  released: { label: '已发布', tone: 'ok' },
  canceled: { label: '已取消', tone: 'neutral' },
}

/** Statuses drawn in the distribution bar, in display order. */
const barStatuses: { status: WorkItemStatus; label: string; segClass: 'segReady' | 'segInProgress' | 'segInReview' | 'segDone' }[] = [
  { status: 'ready', label: '就绪', segClass: 'segReady' },
  { status: 'in-progress', label: '进行中', segClass: 'segInProgress' },
  { status: 'in-review', label: '评审', segClass: 'segInReview' },
  { status: 'done', label: '完成', segClass: 'segDone' },
]

export function MilestonesSection(props: { projectId: string }) {
  const { envelope, refreshing, error, refresh } = useProjection<MilestoneEntry[]>(`milestones:${props.projectId}`)

  if (error) {
    return (
      <p role="alert" className={styles.error}>
        加载失败：{error} <Button onClick={refresh}>重试</Button>
      </p>
    )
  }

  if (!envelope) {
    return (
      <p className={styles.loading}>
        <Spinner /> 正在读取 Milestone Projection…
      </p>
    )
  }

  const milestones = envelope.data

  return (
    <div className={styles.section}>
      <p className={styles.meta}>
        已确认 · Projection revision {envelope.revision} · {envelope.confirmedAt}
        {refreshing ? (
          <span className={styles.refreshing}>
            <Spinner label="正在刷新" /> 正在刷新
          </span>
        ) : null}
      </p>
      <p className={styles.note}>Milestone 是交付范围；Work Item Status 计数来自 GitHub 权威。</p>

      {milestones.length === 0 ? (
        <EmptyHint
          icon="○"
          title="该项目还没有里程碑"
          detail="Milestone 在 GitHub 侧创建并按交付范围组织工作项；创建后会随下一次已确认扫描出现在这里。"
        />
      ) : (
        <ul className={styles.list} role="list" aria-label="里程碑列表">
          {milestones.map((m) => (
            <MilestoneCard key={m.milestoneId} milestone={m} />
          ))}
        </ul>
      )}
    </div>
  )
}

function MilestoneCard(props: { milestone: MilestoneEntry }) {
  const m = props.milestone
  const phase = phaseMeta[m.phase]
  const counts = barStatuses.map(({ status, label, segClass }) => ({ status, label, segClass, count: m.counts[status] ?? 0 }))
  const total = counts.reduce((sum, c) => sum + c.count, 0)

  return (
    <li className={styles.card}>
      <div className={styles.cardTop}>
        <span className={styles.cardTitle}>{m.title}</span>
        <Chip tone={phase.tone}>{phase.label}</Chip>
        {m.blockedCount > 0 ? <Chip tone="warn">有 {m.blockedCount} 项阻塞</Chip> : null}
        <span className={styles.dueDate}>到期：{m.dueDate ?? '未设置'}</span>
      </div>

      {total > 0 ? (
        <div className={styles.distribution}>
          <div
            className={styles.bar}
            role="img"
            aria-label={`状态分布：${counts.map((c) => `${c.label} ${c.count}`).join('，')}`}
          >
            {counts
              .filter((c) => c.count > 0)
              .map((c) => (
                <span
                  key={c.status}
                  className={[styles.seg, styles[c.segClass]].join(' ')}
                  style={{ width: `${(c.count / total) * 100}%` }}
                >
                  {c.count}
                </span>
              ))}
          </div>
          <p className={styles.legend}>{counts.map((c) => `${c.label} ${c.count}`).join(' · ')}</p>
        </div>
      ) : (
        <p className={styles.legend}>该里程碑下还没有已计数的工作项。</p>
      )}

      {m.phase === 'released' && m.release ? (
        <p className={styles.release}>
          Release Tag <code className={styles.mono}>{m.release.tag}</code> · commit <code className={styles.mono}>{m.release.commit}</code>
        </p>
      ) : null}
    </li>
  )
}
