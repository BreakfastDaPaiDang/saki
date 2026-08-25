import type { ButtonHTMLAttributes, ReactNode } from 'react'
import styles from './primitives.module.css'

/** Shared low-fi primitives. Product copy is Chinese; tone uses text + icon, never color alone. */

type ButtonVariant = 'primary' | 'default' | 'ghost' | 'danger'

export function Button(props: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  const { variant = 'default', className, ...rest } = props
  return <button type="button" className={[styles.button, styles[variant], className].filter(Boolean).join(' ')} {...rest} />
}

export function Chip(props: { tone?: 'accent' | 'ok' | 'warn' | 'danger' | 'info' | 'purple' | 'neutral'; children: ReactNode }) {
  return <span className={[styles.chip, styles[`chip-${props.tone ?? 'neutral'}`]].join(' ')}>{props.children}</span>
}

export function Badge(props: { children: ReactNode; label?: string }) {
  return (
    <span className={styles.badge} role="status" aria-label={props.label ?? String(props.children)}>
      {props.children}
    </span>
  )
}

export function Spinner(props: { label?: string }) {
  return <span className={styles.spinner} role="status" aria-label={props.label ?? '加载中'} />
}

export function EmptyHint(props: { icon: string; title: string; detail: string; action?: ReactNode }) {
  return (
    <div className={styles.empty}>
      <span className={styles.emptyIcon} aria-hidden>
        {props.icon}
      </span>
      <p className={styles.emptyTitle}>{props.title}</p>
      <p className={styles.emptyDetail}>{props.detail}</p>
      {props.action}
    </div>
  )
}
