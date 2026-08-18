import { useState, type ReactNode } from 'react'
import { useProjection, useSubmitIntent } from '../../client/controlPlane'
import type { ChangesFile, ChangesProjection, ProjectIndexEntry, SakiIntent } from '../../contract/types'
import { Button, Spinner } from '../../components/primitives'
import { Dialog } from '../../components/Dialog'
import styles from './ChangesSection.module.css'

/**
 * 「项目 → 变更」: renders the Changes Projection — branch/HEAD facts, the
 * staged / unstaged / untracked groups with bounded diff previews, and the
 * eligibility facts that enable commit and push. Stage and commit are ordinary
 * intents; push is high-risk, so it confirms the affected project and target
 * ref before submitting.
 */
export function ChangesSection(props: { projectId: string }) {
  const { projectId } = props
  const { envelope, refreshing, error, refresh } = useProjection<ChangesProjection>(`changes:${projectId}`)
  const { envelope: projects } = useProjection<ProjectIndexEntry[]>('projects')
  const { submit } = useSubmitIntent()
  const [pending, setPending] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [pushOpen, setPushOpen] = useState(false)
  const [prOpen, setPrOpen] = useState(false)
  const [prTitle, setPrTitle] = useState('')
  const [prBody, setPrBody] = useState('')

  if (error) {
    return (
      <p role="alert" className={styles.error}>
        加载失败：{error} <Button onClick={refresh}>重试</Button>
      </p>
    )
  }
  if (!envelope) {
    return (
      <p className={styles.loading}>
        <Spinner /> 正在读取 Changes Projection…
      </p>
    )
  }

  const data = envelope.data
  const revision = envelope.revision
  const projectName = projects?.data.find((p) => p.projectId === projectId)?.name ?? projectId
  const stageAllPaths = [...data.unstaged, ...data.untracked].map((f) => f.path)

  const run = async (key: string, intent: SakiIntent): Promise<void> => {
    setPending(key)
    await submit(intent, revision)
    setPending(null)
  }

  const doCommit = async () => {
    setPending('commit')
    const receipt = await submit({ kind: 'commit', projectId, message, expectedIndexTree: data.head }, revision)
    setPending(null)
    if (receipt.outcome?.type === 'confirmed') setMessage('')
  }

  const doPush = async () => {
    setPending('push')
    await submit({ kind: 'push', projectId, expectedCommit: data.head, targetRef: `origin/${data.branch}` }, revision)
    setPending(null)
    setPushOpen(false)
  }

  const openPrDialog = () => {
    // PR title/body are pre-filled from work item wi-123 and stay editable.
    setPrTitle('#123 用户反馈收集与分析看板')
    setPrBody('')
    setPrOpen(true)
  }

  const doCreatePr = async () => {
    setPending('pr')
    await submit({ kind: 'create-pr', projectId, workItemId: 'wi-123', title: prTitle, body: prBody }, revision)
    setPending(null)
    setPrOpen(false)
  }

  return (
    <div className={styles.section}>
      <div className={styles.meta}>
        <span>
          分支 <span className={styles.mono}>{data.branch}</span>
        </span>
        <span>
          HEAD <span className={styles.mono}>{data.head}</span>
        </span>
        <span>
          已确认 · Projection revision {revision} · {envelope.confirmedAt}
        </span>
        {refreshing ? (
          <span className={styles.refreshing}>
            <Spinner label="正在刷新" /> 正在刷新，仍显示已确认值
          </span>
        ) : null}
      </div>

      {data.inheritedNotice ? (
        <p className={styles.banner} role="note">
          <span aria-hidden>⚠</span>
          <span>继承变更：{data.inheritedNotice}。手动接管留下的继承变更会作为证据保留，不会静默丢弃。</span>
        </p>
      ) : null}

      <FileGroup
        title="已暂存"
        files={data.staged}
        emptyHint="无已暂存文件"
        action="unstage"
        pending={pending}
        onAction={(path) => run(`unstage:${path}`, { kind: 'unstage-files', projectId, paths: [path] })}
      />
      <FileGroup
        title="未暂存"
        files={data.unstaged}
        emptyHint="无未暂存文件"
        action="stage"
        pending={pending}
        headerAction={
          stageAllPaths.length ? (
            <Button
              variant="ghost"
              disabled={pending !== null}
              aria-label="暂存全部未暂存与未跟踪文件"
              onClick={() => run('stage-all', { kind: 'stage-files', projectId, paths: stageAllPaths })}
            >
              {pending === 'stage-all' ? '暂存中…' : '全部暂存'}
            </Button>
          ) : null
        }
        onAction={(path) => run(`stage:${path}`, { kind: 'stage-files', projectId, paths: [path] })}
      />
      <FileGroup
        title="未跟踪"
        files={data.untracked}
        emptyHint="无未跟踪文件"
        action="stage"
        pending={pending}
        onAction={(path) => run(`stage:${path}`, { kind: 'stage-files', projectId, paths: [path] })}
      />

      <section className={styles.commitArea} aria-label="提交">
        <h3 className={styles.commitTitle}>提交</h3>
        <label className={styles.field}>
          提交信息
          <input
            className={styles.input}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="例如：新增用户反馈看板与导出字段"
          />
        </label>
        <div className={styles.commitRow}>
          <Button
            variant="primary"
            disabled={!message.trim() || data.staged.length === 0 || !data.eligibility.canCommit || pending !== null}
            onClick={doCommit}
          >
            {pending === 'commit' ? '提交中…' : '提交'}
          </Button>
          {data.staged.length === 0 ? <span className={styles.hint}>暂存至少一个文件后才能提交。</span> : null}
          {!data.eligibility.canCommit && data.eligibility.reason ? <span className={styles.reason}>{data.eligibility.reason}</span> : null}
        </div>
      </section>

      <div className={styles.actions}>
        <Button
          disabled={!data.eligibility.canPush || pending !== null}
          aria-label={`推送分支 ${data.branch} 到 origin（高风险操作，需要确认）`}
          onClick={() => setPushOpen(true)}
        >
          推送
        </Button>
        <Button disabled={pending !== null} onClick={openPrDialog}>
          创建 PR
        </Button>
        {!data.eligibility.canPush && data.eligibility.reason ? <span className={styles.reason}>{data.eligibility.reason}</span> : null}
      </div>

      {pushOpen ? (
        <Dialog
          title="推送确认"
          onClose={() => setPushOpen(false)}
          footer={
            <>
              <Button onClick={() => setPushOpen(false)} disabled={pending === 'push'}>
                取消
              </Button>
              <Button variant="primary" onClick={doPush} disabled={pending === 'push'}>
                {pending === 'push' ? '推送中…' : '确认推送'}
              </Button>
            </>
          }
        >
          <p className={styles.dialogText}>
            将把项目「{projectName}」的分支 <span className={styles.mono}>{data.branch}</span>（HEAD{' '}
            <span className={styles.mono}>{data.head}</span>）推送到 <span className={styles.mono}>origin/{data.branch}</span>。
          </p>
          <p className={styles.dialogNote}>
            推送是高风险操作，确认内容需标明受影响 Project 与 resource；控制面会按当前 Principal、Grant 与最新 eligibility 重新评估。
          </p>
        </Dialog>
      ) : null}

      {prOpen ? (
        <Dialog
          title="创建 PR"
          onClose={() => setPrOpen(false)}
          footer={
            <>
              <Button onClick={() => setPrOpen(false)} disabled={pending === 'pr'}>
                取消
              </Button>
              <Button variant="primary" onClick={doCreatePr} disabled={pending === 'pr' || !prTitle.trim()}>
                {pending === 'pr' ? '创建中…' : '创建'}
              </Button>
            </>
          }
        >
          <div className={styles.prForm}>
            <p className={styles.dialogText}>为项目「{projectName}」关联工作项 #123 创建 Pull Request；标题与正文按工作项预填，可编辑。</p>
            <label className={styles.field}>
              标题
              <input className={styles.input} value={prTitle} onChange={(e) => setPrTitle(e.target.value)} />
            </label>
            <label className={styles.field}>
              正文（可选）
              <textarea className={styles.textarea} rows={4} value={prBody} onChange={(e) => setPrBody(e.target.value)} />
            </label>
          </div>
        </Dialog>
      ) : null}
    </div>
  )
}

const changeKindLabel: Record<ChangesFile['changeKind'], string> = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
}

function FileGroup(props: {
  title: string
  files: ChangesFile[]
  emptyHint: string
  action: 'stage' | 'unstage'
  pending: string | null
  headerAction?: ReactNode
  onAction: (path: string) => void
}) {
  const actionLabel = props.action === 'stage' ? '暂存' : '取消暂存'
  return (
    <section className={styles.group} aria-label={props.title}>
      <header className={styles.groupHeader}>
        <h3 className={styles.groupTitle}>
          {props.title} <span className={styles.groupCount}>{props.files.length}</span>
        </h3>
        {props.headerAction ? <span className={styles.groupHeaderAction}>{props.headerAction}</span> : null}
      </header>
      {props.files.length === 0 ? (
        <p className={styles.emptyGroup}>{props.emptyHint}</p>
      ) : (
        <ul className={styles.fileList}>
          {props.files.map((file) => {
            const key = `${props.action}:${file.path}`
            return (
              <li key={file.path} className={styles.fileRow}>
                <div className={styles.fileRowTop}>
                  <span className={styles.filePath}>{file.path}</span>
                  <span className={styles.fileKind}>{changeKindLabel[file.changeKind]}</span>
                  <span className={styles.fileStats}>
                    <span className={styles.statAdd}>+{file.additions}</span>
                    <span className={styles.statDel}>−{file.deletions}</span>
                  </span>
                  <Button
                    variant="ghost"
                    disabled={props.pending !== null}
                    aria-label={`${actionLabel} ${file.path}`}
                    onClick={() => props.onAction(file.path)}
                  >
                    {props.pending === key ? '处理中…' : actionLabel}
                  </Button>
                </div>
                <details className={styles.diff}>
                  <summary className={styles.diffSummary}>变更预览（{file.diffPreview.length} 行，有界）</summary>
                  <pre className={styles.diffPre}>{file.diffPreview.join('\n')}</pre>
                </details>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
