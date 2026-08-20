import { useEffect, useState, type ReactNode } from 'react'
import { useStore } from '../client/store'
import { navigate, navStore } from '../client/navigation'
import { useProjection } from '../client/controlPlane'
import type { AttentionEntry } from '../contract/types'
import { Badge } from '../components/primitives'
import styles from './shell.module.css'

/**
 * Prototype stand-in for the shipped DSH AppFrame + sidebar. It preserves the
 * elements the Web UI baseline keeps (brand, New Session, workspace browsing,
 * settings) and adds exactly two primary entries: 「工作」and「项目」.
 */
export function AppFrame(props: { children: ReactNode }) {
  const { address } = useStore(navStore)
  const [sidebarOpen, setSidebarOpen] = useState(false)

  // Close the mobile sidebar drawer on navigation.
  useEffect(() => setSidebarOpen(false), [address])

  return (
    <div className={styles.frame}>
      <a className={styles.skipLink} href="#main-surface">
        跳到主要内容
      </a>
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className={styles.mainColumn}>
        <header className={styles.topbar}>
          <button
            type="button"
            className={styles.menuButton}
            aria-label="打开导航"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen(true)}
          >
            ☰
          </button>
          <TopbarTitle />
        </header>
        <main id="main-surface" className={styles.main} tabIndex={-1}>
          {props.children}
        </main>
      </div>
      {sidebarOpen ? <div className={styles.scrim} onClick={() => setSidebarOpen(false)} aria-hidden /> : null}
    </div>
  )
}

function TopbarTitle() {
  const { address } = useStore(navStore)
  const title =
    address.kind === 'my-work'
      ? '工作'
      : address.kind === 'projects'
        ? '项目'
        : address.kind === 'conversation'
          ? '会话'
          : address.kind === 'new-session'
            ? '新会话'
            : address.kind === 'settings'
              ? '设置'
              : address.kind === 'bootstrap'
                ? '初始设置'
                : '项目'
  return <span className={styles.topbarTitle}>{title}</span>
}

export function Sidebar(props: { open: boolean; onClose: () => void }) {
  const { address } = useStore(navStore)
  const { envelope: attention } = useProjection<AttentionEntry[]>('attention')
  const { envelope: projects } = useProjection<{ projectId: string; name: string }[]>('projects')
  // The badge counts only unresolved entries that need a person or block
  // automation; informational notices stay visible in the page list only.
  const openCount = attention?.data.filter((e) => e.severity !== 'info').length ?? 0
  const currentProjectId = 'projectId' in address ? address.projectId : null

  return (
    <nav className={[styles.sidebar, props.open ? styles.sidebarOpen : ''].join(' ')} aria-label="主导航">
      <div className={styles.brandRow}>
        <span className={styles.brand}>
          <span className={styles.brandMark} aria-hidden>
            ◈
          </span>
          deepseek <span className={styles.brandSuffix}>HARNESS</span>
        </span>
        <button type="button" className={styles.collapse} aria-label="收起侧边栏（prototype 中固定展开）" title="收起侧边栏">
          ⫷
        </button>
      </div>

      <div className={styles.newSessionRow}>
        <button type="button" className={styles.newSession} onClick={() => navigate({ kind: 'new-session' })}>
          <span aria-hidden>⊕</span> 新会话
        </button>
      </div>

      <div className={styles.sectionLabel}>工作区</div>
      <ul className={styles.primaryList}>
        <li>
          <button
            type="button"
            className={[styles.primaryItem, address.kind === 'my-work' ? styles.primaryActive : ''].join(' ')}
            aria-current={address.kind === 'my-work' ? 'page' : undefined}
            onClick={() => navigate({ kind: 'my-work' })}
          >
            <span aria-hidden>▤</span> 工作
            {openCount > 0 ? (
              <span className={styles.badgeSlot}>
                <Badge label={`${openCount} 条待处理`}>{openCount}</Badge>
              </span>
            ) : null}
          </button>
        </li>
        <li>
          <button
            type="button"
            className={[styles.primaryItem, isProjectAddress(address.kind) ? styles.primaryActive : ''].join(' ')}
            aria-current={isProjectAddress(address.kind) ? 'page' : undefined}
            onClick={() => navigate(currentProjectId ? { kind: 'work', projectId: currentProjectId } : { kind: 'projects' })}
          >
            <span aria-hidden>▦</span> 项目
          </button>
        </li>
      </ul>

      <div className={styles.workspaceBrowser}>
        <div className={styles.workspaceTitle}>
          <span>DSH 自用</span>
          <span className={styles.workspaceIcons} aria-hidden>
            ⌕ ⏷ ⧉
          </span>
        </div>
        <ul className={styles.sessionList}>
          {(projects?.data ?? []).map((p) => (
            <li key={p.projectId}>
              <button
                type="button"
                className={[styles.sessionItem, currentProjectId === p.projectId ? styles.sessionActive : ''].join(' ')}
                onClick={() => navigate({ kind: 'work', projectId: p.projectId })}
              >
                {p.name}
              </button>
            </li>
          ))}
          <li>
            <button
              type="button"
              className={[styles.sessionItem, address.kind === 'conversation' ? styles.sessionActive : ''].join(' ')}
              onClick={() => navigate({ kind: 'conversation', sessionId: 'sess-demo' })}
            >
              最近的会话
            </button>
          </li>
        </ul>
      </div>

      <div className={styles.sidebarFooter}>
        <button type="button" className={styles.settingsButton} onClick={() => navigate({ kind: 'settings', section: 'general' })}>
          <span aria-hidden>⚙</span> 设置
        </button>
      </div>
    </nav>
  )
}

function isProjectAddress(kind: string): boolean {
  return ['work', 'milestones', 'changes', 'sessions', 'trace', 'project-settings', 'projects'].includes(kind)
}
