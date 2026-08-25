import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import styles from './Dialog.module.css'

/**
 * Accessible modal dialog: focus moves inside on open, Tab cycles within,
 * Escape closes, and focus returns to the invoking element on close. Closing
 * a panel never implies cancellation of a submitted operation.
 */
export function Dialog(props: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
  labelledBy?: string
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const returnFocusRef = useRef<Element | null>(null)

  useEffect(() => {
    returnFocusRef.current = document.activeElement
    const panel = panelRef.current
    // Defer the initial focus until the opening gesture (Enter/Space/click)
    // has fully dispatched, so it cannot activate a dialog control.
    const frame = requestAnimationFrame(() => {
      const focusables = panel?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      const first = focusables?.[0]
      ;(first ?? panel)?.focus()
    })

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        props.onClose()
        return
      }
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
      const target = returnFocusRef.current
      if (target instanceof HTMLElement) target.focus()
    }
  }, [])

  return createPortal(
    <div className={styles.backdrop} onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        tabIndex={-1}
        className={[styles.panel, props.wide ? styles.wide : ''].join(' ')}
      >
        <header className={styles.header}>
          <h2 className={styles.title}>{props.title}</h2>
          <button type="button" className={styles.close} onClick={props.onClose} aria-label="关闭对话框">
            ✕
          </button>
        </header>
        <div className={styles.body}>{props.children}</div>
        {props.footer ? <footer className={styles.footer}>{props.footer}</footer> : null}
      </div>
    </div>,
    document.body,
  )
}
