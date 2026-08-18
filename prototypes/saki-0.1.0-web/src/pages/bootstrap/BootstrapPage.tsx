import { useState } from 'react'
import { useSubmitIntent } from '../../client/controlPlane'
import { navigate } from '../../client/navigation'
import { Button } from '../../components/primitives'
import styles from './BootstrapPage.module.css'

/**
 * One-time local bootstrap: exchange a short single-use secret, create the
 * local human Principal with a Host Operator Grant, then register an existing
 * directory as a Development Project after reviewing Git evidence.
 */
type Step = 'secret' | 'principal' | 'register' | 'done'

interface DirectoryCandidate {
  path: string
  gitTopLevel: string
  branch: string
  remote: string
  duplicates: string[]
  dirty: { staged: number; unstaged: number; untracked: number }
}

const candidates: DirectoryCandidate[] = [
  {
    path: 'D:\\saki',
    gitTopLevel: 'D:\\saki',
    branch: 'master',
    remote: 'git@github.com:BreakfastDaPaiDang/saki.git',
    duplicates: ['D:\\saki-worktrees\\issue-42-k0-prototype（同一仓库的 linked worktree，不会折叠）'],
    dirty: { staged: 0, unstaged: 4, untracked: 1 },
  },
  {
    path: 'D:\\sites\\website',
    gitTopLevel: 'D:\\sites\\website',
    branch: 'main',
    remote: 'git@github.com:BreakfastDaPaiDang/website.git',
    duplicates: [],
    dirty: { staged: 0, unstaged: 0, untracked: 0 },
  },
]

export function BootstrapPage() {
  const { submit } = useSubmitIntent()
  const [step, setStep] = useState<Step>('secret')
  const [secret, setSecret] = useState('')
  const [name, setName] = useState('')
  const [selected, setSelected] = useState<DirectoryCandidate | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [pending, setPending] = useState(false)

  const finish = async () => {
    if (!selected) return
    setPending(true)
    await submit({ kind: 'complete-bootstrap', displayName: name }, 0)
    await submit({ kind: 'register-project', displayName: 'Saki', directory: selected.path }, 0)
    setPending(false)
    setStep('done')
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.title}>欢迎使用 Saki</h1>
        <p className={styles.subtitle}>首次启动需要完成一次性的本地 bootstrap。这只发生在这台机器上。</p>

        <ol className={styles.steps} aria-label="bootstrap 步骤">
          {(['secret', 'principal', 'register', 'done'] as Step[]).map((s, i) => (
            <li key={s} className={step === s ? styles.stepActive : ''} aria-current={step === s ? 'step' : undefined}>
              {i + 1}. {{ secret: '验证', principal: '身份', register: '登记项目', done: '完成' }[s]}
            </li>
          ))}
        </ol>

        {step === 'secret' ? (
          <section aria-label="输入本地 bootstrap secret" className={styles.section}>
            <p>Saki 启动器显示了一个短期、单次使用的本地 secret。请输入它以继续。</p>
            <label className={styles.field}>
              本地 bootstrap secret
              <input className={styles.input} value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="例如 7f3a-…" />
            </label>
            <p className={styles.note}>secret 通过本地启动流程传递，不会出现在 URL 或持久日志中，且只能使用一次。</p>
            <Button variant="primary" disabled={!secret.trim()} onClick={() => setStep('principal')}>继续</Button>
          </section>
        ) : null}

        {step === 'principal' ? (
          <section aria-label="创建本地 Principal" className={styles.section}>
            <p>为本机创建一个本地 human Principal，并为其配置 Host Operator Grant。</p>
            <label className={styles.field}>
              你的称呼
              <input className={styles.input} value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：你" />
            </label>
            <p className={styles.note}>数据模型不假设永远只有一个用户；0.1.0 的界面不为后续角色增加复杂度。</p>
            <div className={styles.row}>
              <Button onClick={() => setStep('secret')}>上一步</Button>
              <Button variant="primary" disabled={!name.trim()} onClick={() => setStep('register')}>继续</Button>
            </div>
          </section>
        ) : null}

        {step === 'register' ? (
          <section aria-label="登记 Development Project" className={styles.section}>
            <p>选择一个已有本地目录。Saki 会检测 Git 工作树、remote 和候选 GitHub Repository，确认前请复核证据。</p>
            <ul className={styles.candidateList}>
              {candidates.map((c) => (
                <li key={c.path}>
                  <button
                    type="button"
                    className={[styles.candidate, selected?.path === c.path ? styles.candidateActive : ''].join(' ')}
                    onClick={() => {
                      setSelected(c)
                      setConfirmed(false)
                    }}
                    aria-pressed={selected?.path === c.path}
                  >
                    <span className={styles.candidatePath}>{c.path}</span>
                    <span className={styles.candidateMeta}>
                      Git top level {c.gitTopLevel} · 分支 {c.branch}
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            {selected ? (
              <div className={styles.evidence} role="region" aria-label="Git 与候选证据">
                <dl className={styles.factList}>
                  <div><dt>Git top level</dt><dd>{selected.gitTopLevel}</dd></div>
                  <div><dt>remote</dt><dd>{selected.remote}</dd></div>
                  <div><dt>候选 GitHub Repository</dt><dd>BreakfastDaPaiDang/{selected.path.includes('saki') ? 'saki' : 'website'}</dd></div>
                  <div>
                    <dt>重复候选</dt>
                    <dd>{selected.duplicates.length ? selected.duplicates.join('；') : '无：同 Host 路径别名解析为同一物理候选'}</dd>
                  </div>
                  <div>
                    <dt>dirty-state</dt>
                    <dd>
                      {selected.dirty.staged + selected.dirty.unstaged + selected.dirty.untracked === 0
                        ? '工作树干净'
                        : `有未提交修改：staged ${selected.dirty.staged} · unstaged ${selected.dirty.unstaged} · untracked ${selected.dirty.untracked}。手动接管会把它们记录为继承 evidence。`}
                    </dd>
                  </div>
                </dl>
                <label className={styles.confirmCheck}>
                  <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                  我已复核以上证据，确认把该目录登记为 Development Project
                </label>
              </div>
            ) : null}

            <div className={styles.row}>
              <Button onClick={() => setStep('principal')}>上一步</Button>
              <Button variant="primary" disabled={!selected || !confirmed || pending} onClick={finish}>
                {pending ? '登记中…' : '确认登记'}
              </Button>
            </div>
          </section>
        ) : null}

        {step === 'done' ? (
          <section aria-label="完成" className={styles.section}>
            <p>✅ 已完成 bootstrap 并登记了第一个 Development Project。</p>
            <p className={styles.note}>GitHub、Host 与 Binding 的可用或待修复状态会显示在「项目」页。</p>
            <Button variant="primary" onClick={() => navigate({ kind: 'work', projectId: 'proj-registered' })}>
              打开 Development Workspace
            </Button>
          </section>
        ) : null}
      </div>
    </div>
  )
}
