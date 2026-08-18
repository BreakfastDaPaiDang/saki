import { useState } from 'react'
import { useProjection, useSubmitIntent } from '../../client/controlPlane'
import { navigate } from '../../client/navigation'
import type { ActionOffer, AttentionEntry, MyWorkItem, MyWorkProjection, PresentationGroup, SakiIntent } from '../../contract/types'
import { Button, EmptyHint, Spinner } from '../../components/primitives'
import { Dialog } from '../../components/Dialog'
import styles from './MyWorkPage.module.css'

/**
 * 「工作」: the beginner-operable page. It renders the My Work Projection's
 * presentation groups verbatim and at most one Action Offer per item; the
 * client never derives buttons from Work Item Status. Cross-project
 * attention (interventions, recovery, unknown dispatches) appears in plain
 * language above the groups.
 */
export function MyWorkPage() {
  const { envelope, refreshing, error, refresh } = useProjection<MyWorkProjection>('my-work')
  const attention = useProjection<AttentionEntry[]>('attention')
  const [requestOpen, setRequestOpen] = useState(false)

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>我的工作</h1>
          <p className={styles.subtitle}>你负责的工作汇总，按状态清晰排序，下一步一目了然。</p>
        </div>
        <div className={styles.headerActions}>
          {refreshing ? <span className={styles.refreshing}><Spinner label="正在刷新" /> 正在刷新，仍显示已确认值</span> : null}
          <Button variant="primary" onClick={() => setRequestOpen(true)}>提交需求</Button>
        </div>
      </header>

      {error ? <p role="alert" className={styles.error}>加载失败：{error} <Button onClick={refresh}>重试</Button></p> : null}
      {!envelope && !error ? <p className={styles.loading}><Spinner /> 正在读取 My Work Projection…</p> : null}

      {attention.envelope && attention.envelope.data.length > 0 ? (
        <AttentionList entries={attention.envelope.data} />
      ) : null}

      {envelope ? (
        <>
          <p className={styles.revision}>已确认 · Projection revision {envelope.revision} · {envelope.confirmedAt}</p>
          {envelope.data.items.length === 0 ? (
            <EmptyHint
              icon="○"
              title="现在没有与你相关的工作"
              detail="这里只显示与你有关的工作。可以从「提交需求」创建第一项，或等待新的分配。"
              action={<Button variant="primary" onClick={() => setRequestOpen(true)}>提交需求</Button>}
            />
          ) : (
            <GroupList items={envelope.data.items} myWorkRevision={envelope.revision} />
          )}
        </>
      ) : null}

      {requestOpen ? <SubmitRequestDialog onClose={() => setRequestOpen(false)} /> : null}
    </div>
  )
}

const groupMeta: { group: PresentationGroup; title: string }[] = [
  { group: 'not-started', title: '待开始' },
  { group: 'in-progress', title: '处理中' },
  { group: 'waiting-on-you', title: '等你处理' },
  { group: 'recently-finished', title: '最近结束' },
]

const severityMeta = {
  urgent: { icon: '⚠', label: '紧急' },
  'action-needed': { icon: '✋', label: '需要行动' },
  info: { icon: 'ℹ', label: '通知' },
} as const

const kindLabel: Record<AttentionEntry['kind'], string> = {
  intervention: '等待回答',
  'dispatch-unknown': '需要对账',
  recovery: '恢复',
  assignment: '新分配',
}

/** Cross-project attention in plain language; each row returns to its object. */
function AttentionList(props: { entries: AttentionEntry[] }) {
  return (
    <section aria-label="需要关注" className={styles.attention}>
      <h2 className={styles.groupTitle}>需要关注 <span className={styles.groupCount}>{props.entries.length}</span></h2>
      <ul className={styles.cardList}>
        {props.entries.map((entry) => {
          const meta = severityMeta[entry.severity]
          return (
            <li key={entry.attentionId} className={[styles.card, styles[`attention-${entry.severity}`]].join(' ')}>
              <span className={styles.cardIcon} aria-hidden>
                {meta.icon}
              </span>
              <div className={styles.cardBody}>
                <div className={styles.cardTitleRow}>
                  <span className={styles.cardTitleText}>{entry.title}</span>
                  <span className={styles.cardProject}>{entry.projectName}</span>
                </div>
                <p className={styles.cardSubtitle}>
                  {kindLabel[entry.kind]} · {entry.detail} · {entry.age}
                </p>
              </div>
              <div className={styles.cardAction}>
                <Button onClick={() => navigate(entry.returnAddress)} aria-label={`处理：${entry.title}`}>
                  去处理
                </Button>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function GroupList(props: { items: MyWorkItem[]; myWorkRevision: number }) {
  return (
    <div className={styles.groups}>
      {groupMeta.map(({ group, title }) => {
        const items = props.items.filter((item) => item.group === group)
        if (!items.length) return null
        return (
          <section key={group} aria-label={title} className={styles.group}>
            <h2 className={styles.groupTitle}>
              {title} <span className={styles.groupCount}>{items.length}</span>
            </h2>
            <ul className={styles.cardList}>
              {items.map((item) => (
                <WorkCard key={item.workItemId} item={item} myWorkRevision={props.myWorkRevision} />
              ))}
            </ul>
          </section>
        )
      })}
      <p className={styles.endHint}>没有更多工作了</p>
    </div>
  )
}

const statusLabel: Record<string, string> = {
  inbox: 'Inbox',
  backlog: 'Backlog',
  ready: 'Ready',
  'in-progress': '进行中',
  'in-review': '评审中',
  done: '已完成',
  canceled: '已取消',
}

function WorkCard(props: { item: MyWorkItem; myWorkRevision: number }) {
  const { item } = props
  const [confirmOffer, setConfirmOffer] = useState<ActionOffer | null>(null)

  return (
    <li className={styles.card}>
      <span className={styles.cardIcon} aria-hidden>
        {item.group === 'not-started' ? '▢' : item.group === 'in-progress' ? '◉' : item.group === 'waiting-on-you' ? '✋' : '✓'}
      </span>
      <div className={styles.cardBody}>
        <div className={styles.cardTitleRow}>
          <button
            type="button"
            className={styles.cardTitle}
            onClick={() => navigate({ kind: 'work', projectId: item.projectId, workItemId: item.workItemId })}
          >
            {item.title}
          </button>
          <span className={styles.cardProject}>{item.projectName}</span>
        </div>
        <p className={styles.cardSubtitle}>{item.subtitle}</p>
      </div>
      <div className={styles.cardMeta}>
        <span className={styles.cardActor}>{item.currentActor}</span>
        <span className={styles.cardTime}>{item.updatedAt}</span>
        <span className={styles.cardStatus}>{statusLabel[item.status]}</span>
      </div>
      <div className={styles.cardAction}>
        {item.offer ? (
          <>
            <Button onClick={() => setConfirmOffer(item.offer)}>{item.offer.label}</Button>
            <span className={styles.offerReason} title={item.offer.reason}>
              {item.offer.reason}
            </span>
          </>
        ) : (
          <span className={styles.offerReason}>{item.offerUnavailableReason ?? '现在没有可执行的操作'}</span>
        )}
      </div>
      {confirmOffer ? (
        <OfferConfirmDialog
          offer={confirmOffer}
          item={item}
          expectedRevision={props.myWorkRevision}
          onClose={() => setConfirmOffer(null)}
        />
      ) : null}
    </li>
  )
}

/**
 * Executing an offer always submits the typed Intent with the expected
 * Projection revision. Pre-submit review shows what the frontend contract
 * requires (profile, route, grants, binding health, limits, evidence).
 */
function OfferConfirmDialog(props: { offer: ActionOffer; item: MyWorkItem; expectedRevision: number; onClose: () => void }) {
  const { submit } = useSubmitIntent()
  const [pending, setPending] = useState(false)
  const [answer, setAnswer] = useState('')
  const { offer, item } = props

  const isAnswer = offer.intent.kind === 'answer-intervention'
  const finalIntent: SakiIntent = isAnswer ? { kind: 'answer-intervention', interventionId: offer.intent.kind === 'answer-intervention' ? offer.intent.interventionId : '', response: answer } : offer.intent

  const doSubmit = async () => {
    setPending(true)
    const receipt = await submit(finalIntent, props.expectedRevision)
    setPending(false)
    if (receipt.outcome?.type === 'confirmed') props.onClose()
  }

  return (
    <Dialog
      title={`${offer.label} · #${item.issueNumber} ${item.title}`}
      onClose={props.onClose}
      footer={
        <>
          <Button onClick={props.onClose} disabled={pending}>取消</Button>
          <Button variant="primary" onClick={doSubmit} disabled={pending || (isAnswer && !answer.trim())}>
            {pending ? '提交中…' : `确认${offer.label}`}
          </Button>
        </>
      }
    >
      <div className={styles.confirmBody}>
        <p className={styles.confirmReason}>{offer.reason}</p>
        {offer.intent.kind === 'claim-work-item' && offer.label === '交给 Agent' ? (
          <dl className={styles.factList}>
            <div><dt>Agent Profile</dt><dd>Development Agent v4</dd></div>
            <div><dt>Model Route</dt><dd>Codex · GPT-5（个人 Pro）</dd></div>
            <div><dt>所需权限</dt><dd>你持有的 Host Operator Grant 的委派子集</dd></div>
            <div><dt>Binding 健康</dt><dd>active · 工作树干净</dd></div>
            <div><dt>继承变更</dt><dd>无</dd></div>
            <div><dt>适用限制</dt><dd>并发 Run 1 · Run 时长 45 分钟</dd></div>
          </dl>
        ) : null}
        {offer.intent.kind === 'accept-deliverable' ? (
          <dl className={styles.factList}>
            <div><dt>Outcome Evidence</dt><dd>PR #432 已创建 · CI 全部通过 · 验收条件 3/3 已映射证据</dd></div>
            <div><dt>影响</dt><dd>Issue 将关闭，Work Item 进入 Done</dd></div>
          </dl>
        ) : null}
        {isAnswer ? (
          <label className={styles.answerField}>
            你的回答
            <textarea
              className={styles.textarea}
              rows={4}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder="例如：字段齐全，按当前实现导出即可。"
            />
          </label>
        ) : null}
        <p className={styles.confirmNote}>
          提交时携带 expected Projection revision {props.expectedRevision}；控制面会按当前 Principal、Grant 与最新状态重新评估，已渲染的操作不代表权限。
        </p>
      </div>
    </Dialog>
  )
}

function SubmitRequestDialog(props: { onClose: () => void }) {
  const { submit } = useSubmitIntent()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [pending, setPending] = useState(false)

  const doSubmit = async () => {
    setPending(true)
    await submit({ kind: 'create-work-item', projectId: 'proj-saki', title, body }, 0)
    setPending(false)
    props.onClose()
  }

  return (
    <Dialog
      title="提交需求"
      onClose={props.onClose}
      footer={
        <>
          <Button onClick={props.onClose} disabled={pending}>取消</Button>
          <Button variant="primary" onClick={doSubmit} disabled={pending || !title.trim()}>
            {pending ? '提交中…' : '提交'}
          </Button>
        </>
      }
    >
      <div className={styles.confirmBody}>
        <p className={styles.confirmReason}>用白话描述你想要的结果即可；验收条件和技术细节可以之后补充。</p>
        <label className={styles.answerField}>
          想要什么
          <input className={styles.input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：官网首页加上用户评价" />
        </label>
        <label className={styles.answerField}>
          补充说明（可选）
          <textarea className={styles.textarea} rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
        <p className={styles.confirmNote}>提交后会创建 GitHub Issue 并加入所选 Project 的 Inbox；若只完成一部分，界面会显示已完成事实和恢复操作。</p>
      </div>
    </Dialog>
  )
}
