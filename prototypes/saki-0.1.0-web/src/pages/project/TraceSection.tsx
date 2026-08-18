import type { ReactNode } from 'react'
import { useProjection } from '../../client/controlPlane'
import { navigate } from '../../client/navigation'
import type { AgentRunState, SakiViewAddress, SessionListEntry, SessionViewProjection, WorkItemDetail, WorkItemStatus } from '../../contract/types'
import { EmptyHint, Spinner } from '../../components/primitives'
import styles from './TraceSection.module.css'

/**
 * 「项目 → 追溯」: renders one work item's traceability chain — Work Item →
 * Work Session → Agent Run → Changes → PR → CI → Outcome Evidence — as a
 * vertical flow of node cards. Every node comes straight from a Projection;
 * the page never joins backend records in the browser. The fixture carries
 * the chain only for wi-123, which is also the default when the address
 * carries no workItemId.
 */
export function TraceSection(props: { address: SakiViewAddress & { kind: 'trace'; projectId: string } }) {
  const { address } = props
  const workItemId = address.workItemId ?? 'wi-123'
  const { envelope, refreshing, error } = useProjection<WorkItemDetail>(`work-item:${workItemId}`)
  const { envelope: sessions } = useProjection<SessionViewProjection>(`sessions:${address.projectId}`)

  if (error) {
    return (
      <div className={styles.section}>
        <p className={styles.intro}>追溯把一项工作从需求连到交付证据；所有节点来自 Projection，不在浏览器拼接后端记录。</p>
        <EmptyHint
          icon="○"
          title="该工作项的追溯在 fixture 之外"
          detail={`fixture 只提供 wi-123 的追溯链；「${workItemId}」没有对应的 Work Item Projection。`}
        />
      </div>
    )
  }
  if (!envelope) {
    return (
      <p className={styles.loading}>
        <Spinner /> 正在读取 Work Item Projection…
      </p>
    )
  }

  const detail = envelope.data
  const related = sessions?.data.selected?.related ?? []
  const primarySession = sessions?.data.sessions.find((s) => s.workItemId === detail.workItemId) ?? null
  const sessionTarget = primarySession?.workSessionId ?? sessions?.data.selected?.workSessionId ?? 'ws-2310'
  const commitRelated = related.find((r) => r.label === '提交')
  const prRelated = related.find((r) => r.label === 'PR')
  const ciRelated = related.find((r) => r.label === 'CI')
  const commitRef = detail.evidence.find((e) => e.kind === 'commit')?.ref ?? null
  const commitShort = commitRelated?.state ?? commitRef

  return (
    <div className={styles.section}>
      <p className={styles.intro}>追溯把一项工作从需求连到交付证据；所有节点来自 Projection，不在浏览器拼接后端记录。</p>
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

      <ol className={styles.flow} aria-label="追溯链">
        <li className={styles.flowItem}>
          <TraceNode
            kind="工作项"
            title={`#${detail.issueNumber} ${detail.title}`}
            meta={`状态 ${workItemStatusLabel[detail.status]} · 负责人 ${detail.assignee}`}
            address={{ kind: 'work', projectId: address.projectId, workItemId: detail.workItemId }}
            linkLabel={`打开工作项 #${detail.issueNumber}`}
          />
        </li>
        <li className={styles.flowItem}>
          <TraceNode
            kind="Work Session"
            title={detail.sessionRef ?? '#2310'}
            meta={primarySession ? `状态 ${sessionStateLabel(primarySession)}` : '状态未在会话列表中'}
            address={{ kind: 'sessions', projectId: address.projectId, workSessionId: sessionTarget }}
            linkLabel="打开会话与运行"
          />
        </li>
        <li className={styles.flowItem}>
          <TraceNode
            kind="Agent Run"
            title={detail.agentRun ? <span className={styles.mono}>{detail.agentRun.runId}</span> : '暂无运行'}
            meta={
              detail.agentRun
                ? `状态 ${runStateLabel(detail.agentRun.state)} · Profile Development Agent v4 · 路由 Codex · GPT-5（个人 Pro）`
                : '该工作项还没有 Agent Run'
            }
            address={
              detail.agentRun
                ? { kind: 'sessions', projectId: address.projectId, workSessionId: sessionTarget, agentRunId: detail.agentRun.runId }
                : undefined
            }
            linkLabel="打开 Agent Run"
          />
        </li>
        <li className={styles.flowItem}>
          <TraceNode
            kind="变更"
            title={commitRelated?.value ?? (commitRef ? `提交 ${commitRef}` : '暂无提交')}
            meta={commitShort ? <span className={styles.mono}>{commitShort}</span> : undefined}
            address={{ kind: 'changes', projectId: address.projectId }}
            linkLabel="打开变更"
          />
        </li>
        <li className={styles.flowItem}>
          <TraceNode
            kind="PR"
            title={detail.prRef ? `${detail.prRef} ↗` : '暂无 PR'}
            meta={prRelated ? `状态 ${prRelated.state}` : '外部引用，浏览器内不可打开'}
          />
        </li>
        <li className={styles.flowItem}>
          <TraceNode
            kind="CI"
            title={detail.ciState ? `${ciStateLabel(detail.ciState)} ↗` : '暂无 CI'}
            meta={ciRelated?.value ?? '外部引用，浏览器内不可打开'}
          />
        </li>
        <li className={styles.flowItem}>
          <TraceNode
            kind="验收"
            title="Outcome Evidence · 验收条件映射"
            meta={detail.evidence.length ? detail.evidence.map((e) => `${e.label} ${e.ref}`).join(' · ') : '暂无证据'}
          >
            <ul className={styles.acceptance}>
              {detail.acceptance.map((criterion) => (
                <li key={criterion}>
                  <span className={styles.checkIcon} aria-hidden>
                    ✓
                  </span>
                  {criterion}
                </li>
              ))}
            </ul>
          </TraceNode>
        </li>
      </ol>

      <section aria-label="活动记录">
        <h3 className={styles.sectionTitle}>活动记录</h3>
        <ul className={styles.activity}>
          {detail.activity.map((entry) => (
            <li key={`${entry.at}-${entry.text}`}>
              <span className={styles.activityTime}>{entry.at}</span>
              <span className={styles.activityActor}>{entry.actor}</span>
              <span>{entry.text}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

/** One trace chain node; renders as a button card when it owns a section address. */
function TraceNode(props: { kind: string; title: ReactNode; meta?: ReactNode; address?: SakiViewAddress; linkLabel?: string; children?: ReactNode }) {
  const address = props.address
  const body = (
    <>
      <span className={styles.nodeKind}>{props.kind}</span>
      <span className={styles.nodeBody}>
        <span className={styles.nodeTitle}>{props.title}</span>
        {props.meta ? <span className={styles.nodeMeta}>{props.meta}</span> : null}
        {props.children}
      </span>
      {address ? (
        <span className={styles.nodeGo} aria-hidden>
          →
        </span>
      ) : null}
    </>
  )
  if (address) {
    return (
      <button type="button" className={`${styles.node} ${styles.nodeLink}`} aria-label={props.linkLabel} onClick={() => navigate(address)}>
        {body}
      </button>
    )
  }
  return <div className={styles.node}>{body}</div>
}

const workItemStatusLabel: Record<WorkItemStatus, string> = {
  inbox: 'Inbox',
  backlog: 'Backlog',
  ready: 'Ready',
  'in-progress': '进行中',
  'in-review': '评审中',
  done: '已完成',
  canceled: '已取消',
}

function sessionStateLabel(entry: SessionListEntry): string {
  if (entry.runState) return runStateLabel(entry.runState)
  switch (entry.state) {
    case 'active':
      return '进行中'
    case 'waiting':
      return '等你处理'
    case 'finished':
      return '已结束'
  }
}

function runStateLabel(state: AgentRunState): string {
  switch (state) {
    case 'starting':
    case 'running':
      return '运行中'
    case 'waiting-for-user':
      return '等待回答'
    case 'succeeded':
      return '成功'
    case 'failed':
      return '失败'
    case 'canceled':
      return '已取消'
  }
}

function ciStateLabel(state: NonNullable<WorkItemDetail['ciState']>): string {
  switch (state) {
    case 'passing':
      return 'CI 通过'
    case 'failing':
      return 'CI 失败'
    case 'pending':
      return 'CI 进行中'
  }
}
