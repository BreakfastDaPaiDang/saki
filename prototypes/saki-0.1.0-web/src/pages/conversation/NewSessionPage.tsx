import { useState } from 'react'
import { navigate } from '../../client/navigation'
import { Button } from '../../components/primitives'
import styles from './ConversationPage.module.css'

/**
 * Stand-in for the inherited DSH New Session page. The baseline keeps it
 * unchanged; the prototype only proves it remains reachable and that starting
 * a session returns to the inherited Conversation.
 */
export function NewSessionPage() {
  const [text, setText] = useState('')

  return (
    <div className={styles.page}>
      <div className={styles.transcript} style={{ justifyContent: 'center', alignItems: 'center' }}>
        <div className={styles.hero}>
          <h1 className={styles.heroTitle}>开始新会话</h1>
          <p className={styles.heroSub}>继承的 DSH New Session 页面占位。Workspace picker 与 preset 选择由 DSH 拥有，prototype 不复制。</p>
        </div>
        <div style={{ width: 'min(560px, 100%)' }}>
          <textarea
            className={styles.input}
            rows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="描述你的任务…"
            aria-label="新会话消息"
          />
          <div className={styles.composerRow} style={{ marginTop: 8 }}>
            <span className={styles.draftState}>Workspace：DSH 自用</span>
            <Button variant="primary" disabled={!text.trim()} onClick={() => navigate({ kind: 'conversation', sessionId: 'sess-new' })}>
              开始
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
