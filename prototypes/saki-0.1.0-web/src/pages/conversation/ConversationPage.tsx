import { useEffect, useRef, useState } from 'react'
import { navigate } from '../../client/navigation'
import { createStore, useStore } from '../../client/store'
import { Button } from '../../components/primitives'
import styles from './ConversationPage.module.css'

/**
 * Stand-in for the inherited DSH Conversation page. It exists to prove the
 * return-address contract: drafts, the selected view tab, and details state
 * survive navigating to Saki pages and back.
 */

interface ConversationUiState {
  draft: string
  view: 'chat' | 'run-evidence'
  detailsOpen: boolean
}

const STORAGE_KEY = 'saki-proto-conversation-ui'

function loadPersisted(): Record<string, ConversationUiState> {
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, ConversationUiState>
  } catch {
    return {}
  }
}

const uiStore = createStore<Record<string, ConversationUiState>>(loadPersisted())

function persist(state: Record<string, ConversationUiState>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Prototype storage loss only affects the draft-preservation demo.
  }
}

uiStore.subscribe(() => persist(uiStore.getSnapshot()))

export function ConversationPage(props: { sessionId: string | null }) {
  const id = props.sessionId ?? 'sess-demo'
  const all = useStore(uiStore)
  const ui = all[id] ?? { draft: '', view: 'chat' as const, detailsOpen: false }
  const [returnAddress] = useState(() => {
    try {
      return JSON.parse(window.sessionStorage.getItem('saki-proto-return') ?? 'null') as { label: string; address: never } | null
    } catch {
      return null
    }
  })
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [id])

  const update = (patch: Partial<ConversationUiState>) =>
    uiStore.update((current) => {
      const existing = current[id]
      return {
        ...current,
        [id]: {
          draft: existing?.draft ?? '',
          view: existing?.view ?? 'chat',
          detailsOpen: existing?.detailsOpen ?? false,
          ...patch,
        },
      }
    })

  return (
    <div className={styles.page}>
      {returnAddress ? (
        <div className={styles.returnBar}>
          <span>来自：{returnAddress.label}</span>
          <Button variant="ghost" onClick={() => navigate(returnAddress.address)}>← 返回{returnAddress.label}</Button>
        </div>
      ) : null}

      <div className={styles.viewTabs} role="tablist" aria-label="会话视图">
        {(['chat', 'run-evidence'] as const).map((view) => (
          <button
            key={view}
            type="button"
            role="tab"
            aria-selected={ui.view === view}
            className={[styles.viewTab, ui.view === view ? styles.viewTabActive : ''].join(' ')}
            onClick={() => update({ view })}
          >
            {view === 'chat' ? '会话' : 'Run 证据'}
          </button>
        ))}
        <span className={styles.viewSpacer} />
        <Button variant="ghost" aria-pressed={ui.detailsOpen} onClick={() => update({ detailsOpen: !ui.detailsOpen })}>
          {ui.detailsOpen ? '隐藏详情' : '显示详情'}
        </Button>
      </div>

      <div className={styles.body}>
        <div className={styles.transcript}>
          {ui.view === 'chat' ? (
            <>
              <div className={styles.hero}>
                <h1 className={styles.heroTitle}>会话 #{id.replace('sess-', '')}</h1>
                <p className={styles.heroSub}>这是继承的 DSH Conversation 页面占位。真实 transcript、composer 与工具展示由 DSH 提供。</p>
              </div>
              <div className={styles.messageAgent}>Agent：已完成反馈看板的筛选与导出，CI 全部通过。还需要我调整导出字段吗？</div>
            </>
          ) : (
            <div className={styles.evidence}>
              <h2 className={styles.evidenceTitle}>Run 证据（可选视图）</h2>
              <ul className={styles.evidenceList}>
                <li>Profile：Development Agent v4</li>
                <li>Route：Codex · GPT-5（个人 Pro）</li>
                <li>提交：2 个 commit（a1b2c3d）</li>
                <li>PR #432 · CI 通过</li>
              </ul>
            </div>
          )}
        </div>
        {ui.detailsOpen ? (
          <aside className={styles.details} aria-label="会话详情">
            <h2 className={styles.detailsTitle}>详情</h2>
            <p>关联 Work Item：#123 用户反馈收集与分析看板</p>
            <p>主会话：Work Session #2310</p>
          </aside>
        ) : null}
      </div>

      <div className={styles.composer}>
        <textarea
          ref={textareaRef}
          className={styles.input}
          rows={3}
          value={ui.draft}
          onChange={(e) => update({ draft: e.target.value })}
          placeholder="输入消息…（在这里打草稿，离开再回来不会丢）"
          aria-label="消息草稿"
        />
        <div className={styles.composerRow}>
          <span className={styles.draftState} aria-live="polite">
            {ui.draft ? '草稿已保留' : '无草稿'}
          </span>
          <Button variant="primary" disabled={!ui.draft.trim()} onClick={() => update({ draft: '' })}>发送</Button>
        </div>
      </div>
    </div>
  )
}

/** Records where the user came from so the conversation can offer a return. */
export function rememberReturn(label: string, address: unknown): void {
  try {
    window.sessionStorage.setItem('saki-proto-return', JSON.stringify({ label, address }))
  } catch {
    // Losing the return hint only removes the back affordance.
  }
}
