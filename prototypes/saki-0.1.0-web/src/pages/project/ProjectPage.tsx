import { useCallback, useEffect, useRef, useState } from 'react'
import { useProjection, useSubmitIntent } from '../../client/controlPlane'
import { navigate, projectAddress, projectSections, type SakiViewAddress } from '../../client/navigation'
import type { BoardCard, BoardProjection, ProjectIndexEntry, ProjectSection, WorkItemDetail, WorkItemStatus } from '../../contract/types'
import { Button, Chip, Spinner } from '../../components/primitives'
import { Dialog } from '../../components/Dialog'
import { StateBadge } from '../../components/StateBadge'
import { MilestonesSection } from './MilestonesSection'
import { ChangesSection } from './ChangesSection'
import { SessionsSection } from './SessionsSection'
import { TraceSection } from './TraceSection'
import { ProjectSettingsSection } from './ProjectSettingsSection'
import styles from './ProjectPage.module.css'

/**
 * 「项目」: the complex page for one selected Development Project. Internal
 * destinations (看板/里程碑/变更/会话与运行/追溯/项目设置) render one at a
 * time; selecting a Work Item opens a drawer that preserves its return
 * address.
 */
export function ProjectPage(props: { address: SakiViewAddress & { projectId: string } }) {
  const { address } = props
  const { envelope: projects } = useProjection<ProjectIndexEntry[]>('projects')
  const project = projects?.data.find((p) => p.projectId === address.projectId)
  const section = address.kind as ProjectSection

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <h1 className={styles.title}>
            项目 <span className={styles.titleSep}>/</span>
            <ProjectSwitcher current={address.projectId} section={section} projects={projects?.data ?? []} />
          </h1>
          <div className={styles.headerStates}>
            {project ? (
              <>
                {project.bindingHealth === 'active' ? (
                  <StateBadge condition={{ kind: 'confirmed', confirmedAt: `已连接 · ${project.githubConfirmedAt}` }} compact />
                ) : (
                  <StateBadge condition={{ kind: 'repair-required', detail: '目录不存在或不匹配，项目只读' }} compact />
                )}
                {project.githubFreshness === 'stale' ? (
                  <StateBadge condition={{ kind: 'stale', confirmedAt: project.githubConfirmedAt, source: 'GitHub 轮询间隔中' }} compact />
                ) : null}
                {project.githubFreshness === 'offline' ? (
                  <StateBadge condition={{ kind: 'offline', source: 'GitHub 不可达，显示缓存' }} compact />
                ) : null}
                {project.automationPaused ? (
                  <StateBadge condition={{ kind: 'intervention-required', question: project.automationPauseReason ?? '自动化已暂停' }} compact />
                ) : null}
              </>
            ) : null}
          </div>
        </div>
        {/* 新建入口唯一归属「工作」页的「提交需求」；项目页不保留第二入口。 */}
      </header>

      <nav className={styles.tabs} role="tablist" aria-label="项目内部区段">
        {projectSections.map((s) => (
          <button
            key={s.kind}
            type="button"
            role="tab"
            aria-selected={section === s.kind}
            className={[styles.tab, section === s.kind ? styles.tabActive : ''].join(' ')}
            onClick={() => navigate(projectAddress(address.projectId, s.kind))}
          >
            {s.label}
          </button>
        ))}
      </nav>

      <div className={styles.sectionBody}>
        {section === 'work' ? <BoardSection address={address as SakiViewAddress & { kind: 'work'; projectId: string }} /> : null}
        {section === 'milestones' ? <MilestonesSection projectId={address.projectId} /> : null}
        {section === 'changes' ? <ChangesSection projectId={address.projectId} /> : null}
        {section === 'sessions' ? <SessionsSection address={address as SakiViewAddress & { kind: 'sessions'; projectId: string }} /> : null}
        {section === 'trace' ? <TraceSection address={address as SakiViewAddress & { kind: 'trace'; projectId: string }} /> : null}
        {section === 'project-settings' ? <ProjectSettingsSection projectId={address.projectId} /> : null}
      </div>
    </div>
  )
}

function ProjectSwitcher(props: { current: string; section: ProjectSection; projects: ProjectIndexEntry[] }) {
  const current = props.projects.find((p) => p.projectId === props.current)
  return (
    <select
      className={styles.switcher}
      aria-label="切换 Development Project"
      value={props.current}
      onChange={(e) => navigate(projectAddress(e.target.value, props.section))}
    >
      {!current ? <option value={props.current}>{props.current}</option> : null}
      {props.projects.map((p) => (
        <option key={p.projectId} value={p.projectId}>
          {p.name}
        </option>
      ))}
    </select>
  )
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

const columnTitles: Record<WorkItemStatus, string> = {
  inbox: 'Inbox',
  backlog: 'Backlog',
  ready: 'Ready',
  'in-progress': 'In Progress',
  'in-review': 'Review',
  done: 'Done',
  canceled: 'Canceled',
}

function BoardSection(props: { address: SakiViewAddress & { kind: 'work'; projectId: string } }) {
  const { address } = props
  const { envelope, refreshing } = useProjection<BoardProjection>(`board:${address.projectId}`)
  const { envelope: milestones } = useProjection<{ milestoneId: string; title: string }[]>(`milestones:${address.projectId}`)
  const { submit } = useSubmitIntent()
  const [optimistic, setOptimistic] = useState<{ workItemId: string; target: WorkItemStatus; receiptId: string } | null>(null)
  const [conflict, setConflict] = useState<{ workItemId: string; message: string } | null>(null)
  const [moveMenuCard, setMoveMenuCard] = useState<BoardCard | null>(null)
  // Narrow viewports show one status column at a time (状态 selector below).
  const [narrowColumn, setNarrowColumn] = useState<WorkItemStatus | null>(null)
  const liveRef = useRef<HTMLDivElement>(null)

  const announce = (text: string) => {
    if (liveRef.current) {
      liveRef.current.textContent = ''
      requestAnimationFrame(() => {
        if (liveRef.current) liveRef.current.textContent = text
      })
    }
  }

  const openItem = address.workItemId

  const doMove = useCallback(
    async (card: BoardCard, target: WorkItemStatus) => {
      if (!envelope) return
      const receiptId = `opt-${Date.now()}`
      setOptimistic({ workItemId: card.workItemId, target, receiptId })
      setConflict(null)
      announce(`正在把「${card.title}」移动到 ${columnTitles[target]}，等待 GitHub 确认`)
      const receipt = await submit(
        { kind: 'move-work-item', workItemId: card.workItemId, targetStatus: target, expectedRemoteFingerprint: card.remoteFingerprint },
        { expectedRevision: envelope.revision, subject: `board:${address.projectId}` },
      )
      setOptimistic(null)
      if (receipt.outcome?.type === 'conflict') {
        setConflict({ workItemId: card.workItemId, message: receipt.outcome.message })
        announce(`冲突：${receipt.outcome.message}`)
      } else {
        announce(`已确认：「${card.title}」现在在 ${columnTitles[target]}`)
      }
    },
    [envelope, submit, address.projectId],
  )

  if (!envelope) {
    return <p className={styles.loading}><Spinner /> 正在读取 Board Projection…</p>
  }

  const board = envelope.data
  const repair = board.mappingHealth === 'repair-required'
  const milestoneFilter = address.board?.milestoneId ?? null
  // Filter options come from the Milestone projection (scope authority), not
  // only from milestones currently visible on cards — filtering to a milestone
  // with no open cards is the filtered-empty case.
  const milestoneOptions = [
    ...new Set([
      ...(milestones?.data.map((m) => m.title) ?? []),
      ...board.columns.flatMap((c) => c.cards.map((card) => card.milestone).filter((m): m is string => m !== null)),
    ]),
  ]

  // The displayed board derives from the confirmed snapshot plus the
  // optimistic overlay: a pending move removes the card from its source
  // column AND inserts it into the target column, marked 等待确认. A conflict
  // discards the overlay and restores the confirmed snapshot.
  const displayColumns = optimistic
    ? (() => {
        const movedCard = board.columns.flatMap((c) => c.cards).find((c) => c.workItemId === optimistic.workItemId)
        if (!movedCard) return board.columns
        const overlaid = { ...movedCard, status: optimistic.target }
        return board.columns.map((c) => ({
          ...c,
          cards: c.status === optimistic.target ? [...c.cards, overlaid] : c.cards.filter((x) => x.workItemId !== optimistic.workItemId),
        }))
      })()
    : board.columns

  // The milestone filter lives in the typed address and narrows, never
  // rewrites, the confirmed columns.
  const filteredColumns = milestoneFilter
    ? displayColumns.map((c) => ({ ...c, cards: c.cards.filter((card) => card.milestone === milestoneFilter) }))
    : displayColumns
  const filteredEmpty = milestoneFilter !== null && filteredColumns.every((c) => c.cards.length === 0) && !board.columns.every((c) => c.cards.length === 0)

  return (
    <div className={styles.board}>
      <div className={styles.boardMeta}>
        <span>
          已确认扫描 · generation {board.checkpoint.generation} · {board.checkpoint.confirmedAt}
        </span>
        {refreshing ? <span className={styles.boardRefreshing}><Spinner label="正在刷新" /> 正在刷新</span> : null}
        {board.freshness === 'offline' ? <StateBadge condition={{ kind: 'offline', source: 'GitHub 不可达：显示 08:12 的已确认缓存，不会伪造远端写入' }} /> : null}
        {board.freshness === 'offline' ? <StateBadge condition={{ kind: 'unavailable', capability: '看板写入', reason: 'GitHub 不可达' }} /> : null}
        {board.freshness === 'stale' ? <StateBadge condition={{ kind: 'stale', confirmedAt: board.checkpoint.confirmedAt, source: '后台项目每 5 分钟轮询' }} compact /> : null}
        {board.checkpoint.complete === false ? <StateBadge condition={{ kind: 'empty', reason: 'not-scanned' }} compact /> : null}
        {repair ? <StateBadge condition={{ kind: 'repair-required', detail: board.mappingRepairDetail ?? '' }} compact /> : null}
        {repair ? <RepairMappingButton projectId={address.projectId} revision={envelope.revision} /> : null}
        {milestoneOptions.length > 0 ? (
          <label className={styles.filterLabel}>
            里程碑筛选
            <select
              className={styles.filterSelect}
              value={milestoneFilter ?? ''}
              onChange={(e) => navigate({ ...address, board: e.target.value ? { milestoneId: e.target.value } : undefined })}
              aria-label="按里程碑筛选看板"
            >
              <option value="">全部</option>
              {milestoneOptions.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      <div ref={liveRef} className="sp-sr-only" aria-live="polite" />

      {filteredEmpty ? (
        <div className={styles.emptyBoard}>
          <p>当前筛选「{milestoneFilter}」下没有任何工作项。</p>
          <p className={styles.emptyBoardSub}>这是筛选结果为空，不是看板为空。清除筛选即可看到全部。</p>
          <Button onClick={() => navigate({ ...address, board: undefined })}>清除筛选</Button>
        </div>
      ) : board.columns.every((c) => c.cards.length === 0) ? (
        <div className={styles.emptyBoard}>
          <p>{board.checkpoint.complete === false ? '首次扫描尚未完成，看板会在扫描确认后填充。' : '这个看板现在没有任何工作项。'}</p>
          <p className={styles.emptyBoardSub}>可以从「工作」页的「提交需求」创建第一项。</p>
        </div>
      ) : (
        <div className={styles.columns} aria-label="看板列">
          <div className={styles.columnSelector} role="tablist" aria-label="选择看板列（窄屏）">
            {filteredColumns.map((column) => (
              <button
                key={column.status}
                type="button"
                role="tab"
                aria-selected={(narrowColumn ?? filteredColumns.find((c) => c.cards.length)?.status) === column.status}
                className={styles.columnSelectorButton}
                onClick={() => setNarrowColumn(column.status)}
              >
                {columnTitles[column.status]} {column.cards.length}
              </button>
            ))}
          </div>
          {filteredColumns.map((column) => {
            const activeNarrow = narrowColumn ?? filteredColumns.find((c) => c.cards.length)?.status ?? null
            return (
            <section
              key={column.status}
              className={[styles.column, column.status !== activeNarrow ? styles.columnNarrowHidden : ''].join(' ')}
              aria-label={`${columnTitles[column.status]}，${column.cards.length} 项`}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes('text/saki-work-item')) e.preventDefault()
              }}
              onDrop={(e) => {
                const workItemId = e.dataTransfer.getData('text/saki-work-item')
                const dragged = board.columns.flatMap((c) => c.cards).find((c) => c.workItemId === workItemId)
                if (dragged && dragged.status !== column.status && !repair && board.freshness !== 'offline') {
                  doMove(dragged, column.status)
                }
              }}
            >
              <header className={styles.columnHeader}>
                <span className={styles.columnTitle}>{columnTitles[column.status]}</span>
                <span className={styles.columnCount}>{column.cards.length}</span>
              </header>
              <ul className={styles.columnCards}>
                {column.cards.map((card) => {
                  const isOptimistic = optimistic?.workItemId === card.workItemId
                  return (
                    <BoardCardView
                      key={card.workItemId}
                      card={card}
                      optimistic={isOptimistic}
                      conflict={conflict?.workItemId === card.workItemId ? conflict.message : null}
                      readOnly={repair || board.freshness === 'offline' || isOptimistic}
                      onOpen={() => navigate({ ...address, workItemId: card.workItemId })}
                      onMoveMenu={() => setMoveMenuCard(card)}
                      onKeyboardMove={(target) => doMove(card, target)}
                    />
                  )
                })}
              </ul>
            </section>
            )
          })}
        </div>
      )}

      {moveMenuCard ? (
        <MoveCardDialog
          card={moveMenuCard}
          onClose={() => setMoveMenuCard(null)}
          onMove={(target) => {
            setMoveMenuCard(null)
            doMove(moveMenuCard, target)
          }}
        />
      ) : null}

      {openItem ? <WorkItemDrawer workItemId={openItem} address={address} /> : null}
    </div>
  )
}

function RepairMappingButton(props: { projectId: string; revision: number }) {
  const { submit } = useSubmitIntent()
  const [pending, setPending] = useState(false)
  return (
    <Button
      variant="danger"
      disabled={pending}
      onClick={async () => {
        setPending(true)
        await submit({ kind: 'repair-mapping', projectId: props.projectId }, { expectedRevision: props.revision, subject: `board:${props.projectId}` })
        setPending(false)
      }}
    >
      {pending ? '修复中…' : '修复映射（带归因）'}
    </Button>
  )
}

function BoardCardView(props: {
  card: BoardCard
  optimistic: boolean
  conflict: string | null
  readOnly: boolean
  onOpen: () => void
  onMoveMenu: () => void
  onKeyboardMove: (target: WorkItemStatus) => void
}) {
  const { card } = props
  const ref = useRef<HTMLLIElement>(null)

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (props.readOnly) return
    const order: WorkItemStatus[] = ['inbox', 'backlog', 'ready', 'in-progress', 'in-review', 'done']
    const index = order.indexOf(card.status)
    if (event.altKey && event.key === 'ArrowRight' && index < order.length - 1) {
      event.preventDefault()
      props.onKeyboardMove(order[index + 1])
    }
    if (event.altKey && event.key === 'ArrowLeft' && index > 0) {
      event.preventDefault()
      props.onKeyboardMove(order[index - 1])
    }
  }

  return (
    <li
      ref={ref}
      className={[styles.boardCard, props.optimistic ? styles.boardCardOptimistic : '', props.conflict ? styles.boardCardConflict : ''].join(' ')}
      tabIndex={0}
      aria-label={`#${card.issueNumber} ${card.title}。按 Enter 打开详情；Alt+左右方向键移动列（键盘等效拖拽）。`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === ref.current) props.onOpen()
        onKeyDown(e)
      }}
      onDoubleClick={props.onOpen}
      draggable={!props.readOnly}
      onDragStart={(e) => e.dataTransfer.setData('text/saki-work-item', card.workItemId)}
    >
      <div className={styles.boardCardTop}>
        <span className={styles.boardCardNumber}>#{card.issueNumber}</span>
        {card.notInProject ? <Chip tone="warn">未加入 Project</Chip> : null}
        {card.blocked ? <Chip tone="danger">有阻塞</Chip> : null}
      </div>
      <p className={styles.boardCardTitle}>{card.title}</p>
      {card.labels.length ? (
        <div className={styles.boardCardLabels}>
          {card.labels.map((label) => (
            <Chip key={label.name} tone={label.tone}>{label.name}</Chip>
          ))}
        </div>
      ) : null}
      <div className={styles.boardCardMeta}>
        <span>{card.assignee}</span>
        <span>{card.updatedAt}</span>
      </div>
      {card.runSummary ? <div className={styles.boardCardRun}>{card.runSummary}</div> : null}
      {props.optimistic ? <div className={styles.boardCardState}>等待确认…</div> : null}
      {props.conflict ? (
        <div className={styles.boardCardConflictText} role="alert">
          冲突：{props.conflict}
        </div>
      ) : null}
      <div className={styles.boardCardActions}>
        <Button variant="ghost" onClick={props.onOpen} aria-label={`打开 #${card.issueNumber} 详情`}>
          详情
        </Button>
        {!props.readOnly ? (
          <Button variant="ghost" onClick={props.onMoveMenu} aria-label={`移动 #${card.issueNumber}（键盘等效操作）`}>
            移动…
          </Button>
        ) : null}
      </div>
    </li>
  )
}

/** Keyboard-equivalent move: every drag has a menu alternative. */
function MoveCardDialog(props: { card: BoardCard; onMove: (target: WorkItemStatus) => void; onClose: () => void }) {
  const order: WorkItemStatus[] = ['inbox', 'backlog', 'ready', 'in-progress', 'in-review', 'done']
  return (
    <Dialog title={`移动 #${props.card.issueNumber} ${props.card.title}`} onClose={props.onClose}>
      <p className={styles.moveHint}>选择目标列。拖动卡片与这里的操作等价，都会携带已确认远端指纹。</p>
      <ul className={styles.moveList}>
        {order
          .filter((status) => status !== props.card.status)
          .map((status) => (
            <li key={status}>
              <Button className={styles.moveTarget} onClick={() => props.onMove(status)}>
                移动到 {columnTitles[status]}
              </Button>
            </li>
          ))}
      </ul>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Work item drawer
// ---------------------------------------------------------------------------

function WorkItemDrawer(props: { workItemId: string; address: SakiViewAddress & { kind: 'work'; projectId: string } }) {
  const { envelope } = useProjection<WorkItemDetail>(`work-item:${props.workItemId}`)
  const { submit } = useSubmitIntent()
  const [answer, setAnswer] = useState('')
  const [pending, setPending] = useState(false)
  const returnFocusRef = useRef<Element | null>(null)
  const asideRef = useRef<HTMLElement>(null)
  const closeRef = useRef(() => {})
  closeRef.current = () => {
    const { workItemId: _omit, ...rest } = props.address
    navigate(rest)
  }
  const close = () => closeRef.current()

  useEffect(() => {
    returnFocusRef.current = document.activeElement
    // Move focus inside the drawer after the opening gesture finishes, so an
    // Enter keydown that opened the drawer cannot activate its close button.
    const frame = requestAnimationFrame(() => {
      asideRef.current?.querySelector<HTMLElement>('button')?.focus()
    })
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        closeRef.current()
        return
      }
      // Tab containment: keep focus cycling inside the drawer.
      const panel = asideRef.current
      if (event.key !== 'Tab' || !panel) return
      const items = [...panel.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select, textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )].filter((el) => el.offsetParent !== null)
      if (!items.length) return
      const firstItem = items[0]
      const lastItem = items[items.length - 1]
      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault()
        lastItem.focus()
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault()
        firstItem.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onKeyDown, true)
      const el = returnFocusRef.current
      if (el instanceof HTMLElement) el.focus()
    }
  }, [])

  const detail = envelope?.data

  return (
    <div className={styles.drawerBackdrop} onClick={(e) => e.target === e.currentTarget && close()}>
      <aside ref={asideRef} className={styles.drawer} role="dialog" aria-modal="true" aria-label={detail ? `#${detail.issueNumber} ${detail.title}` : '工作项详情'}>
        <header className={styles.drawerHeader}>
          <span className={styles.drawerNumber}>#{detail?.issueNumber ?? '…'}</span>
          <button type="button" className={styles.drawerClose} onClick={close} aria-label="关闭详情并返回看板">
            ✕
          </button>
        </header>
        {!detail ? (
          <p className={styles.loading}><Spinner /> 正在读取 Work Item detail…</p>
        ) : (
          <div className={styles.drawerBody}>
            <h2 className={styles.drawerTitle}>{detail.title}</h2>
            <div className={styles.drawerLabels}>
              {detail.labels.map((label) => (
                <Chip key={label.name} tone={label.tone}>{label.name}</Chip>
              ))}
              <Chip tone="neutral">{detail.status}</Chip>
              {detail.blocked ? <Chip tone="danger">有阻塞</Chip> : null}
            </div>

            <dl className={styles.drawerFacts}>
              <div><dt>状态</dt><dd>{detail.agentRun?.summary ?? detail.status}</dd></div>
              <div><dt>负责人</dt><dd>{detail.assignee}</dd></div>
              <div><dt>创建者</dt><dd>{detail.creator}</dd></div>
              <div><dt>创建时间</dt><dd>{detail.createdAt}</dd></div>
              <div><dt>更新时间</dt><dd>{detail.updatedAt}</dd></div>
            </dl>

            <section aria-label="描述">
              <h3 className={styles.drawerSectionTitle}>描述</h3>
              <p className={styles.drawerText}>{detail.body}</p>
            </section>

            <section aria-label="验收条件">
              <h3 className={styles.drawerSectionTitle}>验收条件</h3>
              <ul className={styles.drawerList}>
                {detail.acceptance.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </section>

            <section aria-label="关联">
              <h3 className={styles.drawerSectionTitle}>关联</h3>
              <dl className={styles.drawerFacts}>
                <div><dt>会话</dt><dd>{detail.sessionRef ?? '无'}</dd></div>
                <div><dt>PR</dt><dd>{detail.prRef ?? '无'}</dd></div>
                <div><dt>CI</dt><dd>{detail.ciState === 'passing' ? '通过' : detail.ciState === 'failing' ? '失败' : detail.ciState === 'pending' ? '进行中' : '无'}</dd></div>
                <div><dt>里程碑</dt><dd>{detail.milestone ?? '无'}</dd></div>
                <div><dt>变更</dt><dd>{detail.evidence.find((e) => e.kind === 'commit')?.ref ?? '无'}</dd></div>
              </dl>
            </section>

            {detail.interventions.some((iv) => iv.status === 'open') ? (
              <section aria-label="等待处理" className={styles.drawerIntervention}>
                <h3 className={styles.drawerSectionTitle}>等待你处理</h3>
                {detail.interventions
                  .filter((iv) => iv.status === 'open')
                  .map((iv) => (
                    <div key={iv.interventionId}>
                      <p className={styles.drawerText}>{iv.question}</p>
                      {iv.kind === 'clarification' ? (
                        <>
                          <label className={styles.field}>
                            你的回答
                            <textarea className={styles.textarea} rows={3} value={answer} onChange={(e) => setAnswer(e.target.value)} />
                          </label>
                          <Button
                            variant="primary"
                            disabled={!answer.trim() || pending}
                            onClick={async () => {
                              setPending(true)
                              const receipt = await submit(
                                { kind: 'answer-intervention', interventionId: iv.interventionId, response: { kind: 'text', text: answer } },
                                { expectedRevision: envelope?.revision ?? 0, subject: `work-item:${props.workItemId}` },
                              )
                              setPending(false)
                              if (receipt.outcome?.type === 'confirmed') setAnswer('')
                            }}
                          >
                            {pending ? '提交中…' : '提交回答'}
                          </Button>
                        </>
                      ) : null}
                      {iv.kind === 'approval' ? (
                        <div className={styles.drawerApprovalRow}>
                          {(['approve', 'reject'] as const).map((decision) => (
                            <Button
                              key={decision}
                              variant={decision === 'approve' ? 'primary' : 'danger'}
                              disabled={pending}
                              onClick={async () => {
                                setPending(true)
                                await submit(
                                  { kind: 'answer-intervention', interventionId: iv.interventionId, response: { kind: 'decision', decision } },
                                  { expectedRevision: envelope?.revision ?? 0, subject: `work-item:${props.workItemId}` },
                                )
                                setPending(false)
                              }}
                            >
                              {decision === 'approve' ? '批准' : '拒绝'}
                            </Button>
                          ))}
                        </div>
                      ) : null}
                      {iv.kind === 'repair-link' ? (
                        <Button variant="danger" onClick={() => navigate({ kind: 'project-settings', projectId: detail.projectId })}>
                          去修复（项目设置）
                        </Button>
                      ) : null}
                      <p className={styles.drawerNote}>回答是一条针对 expected revision 的 Control Intent；第一个有效回答胜出，关闭通知不代表回答。</p>
                    </div>
                  ))}
              </section>
            ) : null}

            <section aria-label="活动记录">
              <h3 className={styles.drawerSectionTitle}>活动记录</h3>
              <ul className={styles.drawerActivity}>
                {detail.activity.map((a) => (
                  <li key={a.at + a.text}>
                    <span className={styles.drawerActivityTime}>{a.at}</span>
                    <span className={styles.drawerActivityActor}>{a.actor}</span>
                    <span>{a.text}</span>
                  </li>
                ))}
              </ul>
            </section>

            <div className={styles.drawerActions}>
              {detail.offer && detail.offer.intent.kind !== 'answer-intervention' ? (
                <Button
                  variant="primary"
                  disabled={pending}
                  onClick={async () => {
                    setPending(true)
                    await submit(detail.offer!.intent, { expectedRevision: envelope?.revision ?? 0, subject: `work-item:${props.workItemId}` })
                    setPending(false)
                  }}
                >
                  {detail.offer.label}
                </Button>
              ) : null}
              {detail.offerUnavailableReason ? <span className={styles.drawerNote}>{detail.offerUnavailableReason}</span> : null}
              <Button onClick={() => navigate({ kind: 'sessions', projectId: props.address.projectId, workSessionId: 'ws-2310' })}>打开会话与运行</Button>
              <Button onClick={() => navigate({ kind: 'trace', projectId: props.address.projectId, workItemId: detail.workItemId })}>查看追溯</Button>
            </div>
          </div>
        )}
      </aside>
    </div>
  )
}
