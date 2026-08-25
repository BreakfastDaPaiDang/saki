import type { ViewCondition } from '../contract/types'
import styles from './StateBadge.module.css'

/**
 * Every view state carries text semantics, never color alone. The badge pairs
 * an icon with a plain-language label plus a detail line when present.
 */
export function StateBadge(props: { condition: ViewCondition; compact?: boolean }) {
  const { condition } = props
  const meta = describe(condition)
  return (
    <span className={[styles.badge, styles[meta.tone]].join(' ')} role="status">
      <span aria-hidden>{meta.icon}</span>
      <span>{meta.label}</span>
      {!props.compact && meta.detail ? <span className={styles.detail}>{meta.detail}</span> : null}
    </span>
  )
}

function describe(condition: ViewCondition): { icon: string; label: string; detail: string | null; tone: string } {
  switch (condition.kind) {
    case 'confirmed':
      return { icon: '✓', label: '已确认', detail: condition.confirmedAt, tone: 'ok' }
    case 'refreshing':
      return { icon: '↻', label: '正在刷新', detail: `仍显示 ${condition.confirmedAt} 的已确认值`, tone: 'info' }
    case 'optimistic':
      return { icon: '…', label: '等待确认', detail: `凭据 ${condition.receiptId}`, tone: 'info' }
    case 'stale':
      return { icon: '◔', label: '数据已过时', detail: `${condition.confirmedAt} · ${condition.source}`, tone: 'warn' }
    case 'offline':
      return { icon: '⚠', label: '离线', detail: condition.source, tone: 'warn' }
    case 'conflict':
      return { icon: '✗', label: '冲突', detail: `请求：${condition.requested}；已确认：${condition.confirmed}`, tone: 'danger' }
    case 'unavailable':
      return { icon: '⊘', label: '不可用', detail: `${condition.capability}：${condition.reason}`, tone: 'danger' }
    case 'repair-required':
      return { icon: '⚒', label: '需要修复', detail: condition.detail, tone: 'danger' }
    case 'reconciliation-required':
      return { icon: '?', label: '需要对账', detail: condition.detail, tone: 'warn' }
    case 'intervention-required':
      return { icon: '✋', label: '等待处理', detail: condition.question, tone: 'warn' }
    case 'empty':
      return {
        icon: '○',
        label: '空',
        detail:
          condition.reason === 'none-exist'
            ? '还没有任何对象'
            : condition.reason === 'filtered'
              ? '筛选条件排除了所有对象'
              : '首次扫描尚未完成',
        tone: 'neutral',
      }
  }
}
