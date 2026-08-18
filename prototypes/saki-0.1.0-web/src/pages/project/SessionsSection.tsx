import { useState } from 'react'
import { useProjection } from '../../client/controlPlane'
import { navigate } from '../../client/navigation'
import type { AgentRunState, RunTimelineEvent, SakiViewAddress, SessionListEntry, SessionViewProjection } from '../../contract/types'
import { Button, Chip, EmptyHint, Spinner } from '../../components/primitives'
import { rememberReturn } from '../conversation/ConversationPage'
import styles from './SessionsSection.module.css'

type SessionsAddress = SakiViewAddress & { kind: 'sessions'; projectId: string }

/**
 * 「项目 → 会话与运行」: two-pane view over the Session Projection. The left
 * list groups Work Sessions by their projection state (运行中 / 等你处理 /
 * 最近结束); the right pane renders the selected session's run detail — the
 * fixture carries detail only for ws-2310. Below 720px the panes stack and a
 * selected session swaps the list for the detail plus a back button.
 */
export function SessionsSection(props: { address: SessionsAddress }) {
  const { address } = props
  const { envelope, refreshing, error, refresh } = useProjection<SessionViewProjection>(`sessions:${address.projectId}`)

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
        <Spinner /> 正在读取 Session Projection…
      </p>
    )
  }

  const data = envelope.data
  const selectedId = address.workSessionId ?? null
  const highlightedId = selectedId ?? data.selected?.workSessionId ?? null
  // The fixture detail shows when nothing is picked or the pick matches it.
  const showFixtureDetail = data.selected !== null && (selectedId === null || selectedId === data.selected.workSessionId)

  return (
    <div className={styles.section}>
      <div className={styles.meta}>
        <span>
          已确认 · Projection revision {envelope.revision} · {envelope.confirmedAt}
        </span>
        {refreshing ? (
          <span className={styles.refreshing}>
            <Spinner label="正在刷新" /> 正在刷新，仍显示已确认值
          </span>
        ) : null}
      </div>

      <div className={`${styles.panes} ${selectedId ? styles.withSelection : styles.noSelection}`}>
        <div className={styles.listPane}>
          <SessionList sessions={data.sessions} projectId={address.projectId} highlightedId={highlightedId} />
        </div>
        <div className={styles.detailPane}>
          {selectedId ? (
            <Button
              variant="ghost"
              className={styles.backButton}
              onClick={() => navigate({ kind: 'sessions', projectId: address.projectId })}
            >
              ← 返回列表
            </Button>
          ) : null}
          {showFixtureDetail && data.selected ? (
            <SessionDetail selected={data.selected} address={address} />
          ) : selectedId ? (
            <EmptyHint
              icon="○"
              title="该会话的详情在 fixture 之外"
              detail="fixture 只提供 #2310 的运行详情；其他会话只有列表条目。"
            />
          ) : (
            <EmptyHint icon="○" title="选择左侧会话查看运行详情" detail="点击任意会话，查看它的运行时间线与关联摘要。" />
          )}
        </div>
      </div>
    </div>
  )
}

const sessionGroups: { state: SessionListEntry['state']; title: string }[] = [
  { state: 'active', title: '运行中' },
  { state: 'waiting', title: '等你处理' },
  { state: 'finished', title: '最近结束' },
]

function SessionList(props: { sessions: SessionListEntry[]; projectId: string; highlightedId: string | null }) {
  if (props.sessions.length === 0) {
    return <EmptyHint icon="○" title="这个项目还没有会话" detail="Agent 领取工作项后会在这里创建 Work Session。" />
  }
  return (
    <>
      {sessionGroups.map((group) => {
        const entries = props.sessions.filter((s) => s.state === group.state)
        if (!entries.length) return null
        return (
          <section key={group.state} aria-label={group.title} className={styles.listGroup}>
            <h3 className={styles.listGroupTitle}>
              {group.title} <span className={styles.groupCount}>{entries.length}</span>
            </h3>
            <ul className={styles.sessionList}>
              {entries.map((entry) => {
                const view = runStateView(entry.runState)
                const selected = entry.workSessionId === props.highlightedId
                return (
                  <li key={entry.workSessionId}>
                    <button
                      type="button"
                      className={`${styles.sessionRow} ${selected ? styles.sessionRowSelected : ''}`}
                      aria-current={selected || undefined}
                      onClick={() => navigate({ kind: 'sessions', projectId: props.projectId, workSessionId: entry.workSessionId })}
                    >
                      <span className={styles.sessionTitle}>{entry.title}</span>
                      <span className={styles.sessionMeta}>
                        <span className={styles.sessionState}>
                          <span aria-hidden>{view.icon}</span> {view.label}
                        </span>
                        <span>{entry.updatedAt}</span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}
    </>
  )
}

function SessionDetail(props: { selected: NonNullable<SessionViewProjection['selected']>; address: SessionsAddress }) {
  const { selected } = props
  const [copied, setCopied] = useState(false)
  const view = runStateView(selected.runState)

  const openConversation = () => {
    rememberReturn('会话与运行', props.address)
    navigate({ kind: 'conversation', sessionId: selected.dshSessionRef })
  }

  const copyRunLink = () => {
    if (!navigator.clipboard) return
    // The run URL is a placeholder; the prototype has no shareable links.
    navigator.clipboard
      .writeText(`https://saki.example/run/${selected.runId ?? selected.workSessionId}`)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 2000)
      })
      .catch(() => {
        // A denied clipboard only drops the copy affordance.
      })
  }

  return (
    <article className={styles.detail}>
      <header className={styles.detailHeader}>
        <h2 className={styles.detailTitle}>{selected.title}</h2>
        <div>
          <Chip tone={view.tone}>
            {view.icon} {view.label}
          </Chip>
        </div>
        <dl className={styles.detailFacts}>
          <div>
            <dt>开始时间</dt>
            <dd>{selected.runStartedAt ?? '—'}</dd>
          </div>
          <div>
            <dt>运行 ID</dt>
            <dd className={styles.mono}>{selected.runId ?? '—'}</dd>
          </div>
        </dl>
        {selected.automationNote ? (
          <p className={styles.automation}>
            <span className={styles.automationLabel}>启动原因</span>
            {selected.automationNote}
          </p>
        ) : null}
      </header>

      <section aria-label="运行时间线">
        <h3 className={styles.sectionTitle}>运行时间线</h3>
        <ol className={styles.timeline}>
          {selected.timeline.map((event) => (
            <li key={`${event.at}-${event.kind}`} className={styles.timelineItem}>
              <span className={styles.timelineIcon} aria-hidden>
                {timelineIcon[event.kind]}
              </span>
              <div className={styles.timelineBody}>
                <p className={styles.timelineText}>{event.text}</p>
                <span className={styles.timelineTime}>{event.at}</span>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section aria-label="关联摘要">
        <h3 className={styles.sectionTitle}>关联摘要</h3>
        <dl className={styles.related}>
          {selected.related.map((item) => (
            <div key={item.label}>
              <dt>{item.label}</dt>
              <dd>
                {item.value}
                <span className={styles.relatedState}>{item.state}</span>
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <div className={styles.detailActions}>
        <Button variant="primary" onClick={openConversation}>
          打开会话
        </Button>
        <Button variant="ghost" aria-label="复制该运行的链接" onClick={copyRunLink}>
          {copied ? '已复制 ✓' : '复制运行链接'}
        </Button>
      </div>
    </article>
  )
}

const timelineIcon: Record<RunTimelineEvent['kind'], string> = {
  claimed: '✓',
  'session-created': '✓',
  started: '▶',
  waiting: '✋',
  committed: '⎇',
  'pr-created': '⑂',
  ci: '✓',
  failed: '✗',
  finished: '✓',
}

type ChipTone = 'accent' | 'ok' | 'warn' | 'danger' | 'info' | 'purple' | 'neutral'

function runStateView(state: AgentRunState | null): { icon: string; label: string; tone: ChipTone } {
  switch (state) {
    case 'starting':
    case 'running':
      return { icon: '▶', label: '运行中', tone: 'info' }
    case 'waiting-for-user':
      return { icon: '✋', label: '等待回答', tone: 'warn' }
    case 'succeeded':
      return { icon: '✓', label: '成功', tone: 'ok' }
    case 'failed':
      return { icon: '✗', label: '失败', tone: 'danger' }
    case 'canceled':
      return { icon: '⊘', label: '已取消', tone: 'neutral' }
    case null:
      return { icon: '○', label: '无运行', tone: 'neutral' }
  }
}
