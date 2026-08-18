import { useState } from 'react'
import { useControlPlane, useSubmitIntent } from '../client/controlPlane'
import { navigate } from '../client/navigation'
import styles from './DevBar.module.css'

/**
 * Prototype tooling, not product UI: scenario switcher plus a scenario index
 * dialog. Every fixture declares the Projections it simulates and the Intents
 * it accepts; see SCENARIOS.md for the same index in document form.
 */
export function DevBar() {
  const { scenario, switchScenario, allScenarios } = useControlPlane()
  const [indexOpen, setIndexOpen] = useState(false)

  return (
    <>
      <div className={styles.bar} role="region" aria-label="prototype 场景工具">
        <span className={styles.tag}>prototype</span>
        <label className={styles.field}>
          场景
          <select
            className={styles.select}
            value={scenario.id}
            onChange={(event) => {
              const next = allScenarios.find((s) => s.id === event.target.value)
              switchScenario(event.target.value)
              if (next) navigate(next.startAddress, { replace: true })
            }}
          >
            {allScenarios.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className={styles.indexButton} onClick={() => setIndexOpen(true)}>
          场景索引（{allScenarios.length}）
        </button>
        <span className={styles.summary}>{scenario.summary}</span>
      </div>
      {indexOpen ? <ScenarioIndex onClose={() => setIndexOpen(false)} /> : null}
    </>
  )
}

function ScenarioIndex(props: { onClose: () => void }) {
  const { scenario, switchScenario, allScenarios } = useControlPlane()
  return (
    <div className={styles.indexBackdrop} onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={styles.indexPanel} role="dialog" aria-modal="true" aria-label="场景索引">
        <header className={styles.indexHeader}>
          <h2 className={styles.indexTitle}>场景索引</h2>
          <button type="button" className={styles.indexClose} onClick={props.onClose} aria-label="关闭场景索引">
            ✕
          </button>
        </header>
        <ul className={styles.indexList}>
          {allScenarios.map((s) => (
            <li key={s.id} className={s.id === scenario.id ? styles.indexActive : ''}>
              <button
                type="button"
                className={styles.indexItem}
                onClick={() => {
                  switchScenario(s.id)
                  navigate(s.startAddress, { replace: true })
                  props.onClose()
                }}
              >
                <span className={styles.indexItemTitle}>{s.title}</span>
                <span className={styles.indexItemSummary}>{s.summary}</span>
                <span className={styles.indexItemTags}>
                  {s.demonstrates.map((d) => (
                    <span key={d} className={styles.demonstrateTag}>
                      {d}
                    </span>
                  ))}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/** Intent receipt toasts: an accepted Intent stays visible until its outcome is confirmed. */
export function ReceiptToasts() {
  const { submissions, dismiss } = useSubmitIntent()
  if (!submissions.length) return null
  return (
    <div className={styles.toasts} role="region" aria-label="操作结果" aria-live="polite">
      {submissions.slice(-3).map((s) => (
        <div key={s.receipt.receiptId} className={[styles.toast, s.pending ? '' : styles[`toast-${s.receipt.outcome?.type ?? ''}`]].join(' ')}>
          {s.pending ? (
            <span>已提交，等待控制面确认…（凭据 {s.receipt.receiptId}）</span>
          ) : (
            <>
              <span>{s.receipt.outcome?.message}</span>
              <button type="button" className={styles.toastClose} onClick={() => dismiss(s.receipt.receiptId)} aria-label="关闭通知">
                ✕
              </button>
            </>
          )}
        </div>
      ))}
    </div>
  )
}
