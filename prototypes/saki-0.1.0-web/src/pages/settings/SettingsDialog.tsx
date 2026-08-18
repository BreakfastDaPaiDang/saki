import { useState } from 'react'
import { useProjection, useSubmitIntent } from '../../client/controlPlane'
import { navigate } from '../../client/navigation'
import type { ContextPolicy, GenerationJob, ModelRoute, ModelSupplyProjection, ProviderAccountProfile } from '../../contract/types'
import { Button, Chip, Spinner } from '../../components/primitives'
import { Dialog } from '../../components/Dialog'
import styles from './SettingsDialog.module.css'

/**
 * Settings dialog: the DSH settings shell rendered as a wide modal over the
 * current surface. DSH-owned sections are placeholders; the Model Supply
 * section renders the installation-level Model Supply Projection.
 */

const sections: { id: string; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'models', label: 'Models' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'agent-presets', label: 'Agent Presets' },
  { id: 'model-supply', label: 'Model Supply' },
]

export function SettingsDialog(props: { section: string }) {
  const active = sections.find((s) => s.id === props.section)

  return (
    <Dialog title="设置" onClose={() => navigate({ kind: 'my-work' })} wide>
      <div className={styles.shell}>
        <nav className={styles.nav} aria-label="设置分节">
          {sections.map((s) => (
            <button
              key={s.id}
              type="button"
              className={[styles.navItem, s.id === props.section ? styles.navItemActive : ''].join(' ')}
              aria-current={s.id === props.section ? 'page' : undefined}
              onClick={() => navigate({ kind: 'settings', section: s.id })}
            >
              {s.label}
            </button>
          ))}
        </nav>
        <div className={styles.content} role="region" aria-label={active?.label ?? props.section}>
          {props.section === 'model-supply' ? <ModelSupplySection /> : <PlaceholderSection label={active?.label ?? props.section} />}
        </div>
      </div>
    </Dialog>
  )
}

function PlaceholderSection(props: { label: string }) {
  return (
    <div className={styles.placeholder}>
      <span className={styles.placeholderIcon} aria-hidden>
        ◈
      </span>
      <p className={styles.placeholderTitle}>{props.label}</p>
      <p className={styles.placeholderText}>该分节由 DSH 拥有，prototype 不复制。</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Model Supply
// ---------------------------------------------------------------------------

function ModelSupplySection() {
  const { envelope, refreshing, error, refresh } = useProjection<ModelSupplyProjection>('model-supply')

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
        <Spinner /> 正在读取 Model Supply Projection…
      </p>
    )
  }

  const supply = envelope.data

  return (
    <div className={styles.supply}>
      <p className={styles.meta}>
        已确认 · Projection revision {envelope.revision} · {envelope.confirmedAt}
        {refreshing ? (
          <span className={styles.refreshing}>
            <Spinner label="正在刷新" /> 正在刷新
          </span>
        ) : null}
      </p>
      <ProfilesBlock profiles={supply.profiles} />
      <RoutesBlock routes={supply.routes} profiles={supply.profiles} />
      <PoliciesBlock policies={supply.contextPolicies} />
      <JobsBlock jobs={supply.generationJobs} concurrency={supply.generationConcurrency} expectedRevision={envelope.revision} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Provider Account Profiles
// ---------------------------------------------------------------------------

type DeviceFlow = { mode: 'reauth'; profile: ProviderAccountProfile } | { mode: 'add' }

const providerMeta: Record<ProviderAccountProfile['provider'], { label: string; tone: 'accent' | 'purple' }> = {
  codex: { label: 'Codex', tone: 'accent' },
  kimi: { label: 'Kimi', tone: 'purple' },
}

const authStateLabel: Record<ProviderAccountProfile['authState'], string> = {
  authorized: '已授权',
  expired: '已过期需重新授权',
  'needs-reauth': '已过期需重新授权',
  revoked: '已撤销',
}

const healthLabel: Record<ProviderAccountProfile['health'], string> = {
  healthy: '健康',
  degraded: '降级',
  unavailable: '不可用',
}

/** Usage Snapshot text: three distinct states, never rendered as zero. */
function usageText(usage: ProviderAccountProfile['usage']): string {
  switch (usage.state) {
    case 'available':
      return `${usage.windowLabel} · 正常（${usage.remainingLabel}）· 观察于 ${usage.observedAt}`
    case 'temporarily-unavailable': {
      const detail = usage.remainingLabel && usage.remainingLabel !== '用量数据暂时不可用' ? `：${usage.remainingLabel}` : ''
      return `${usage.windowLabel} · 用量数据暂时不可用${detail} · 观察于 ${usage.observedAt}`
    }
    case 'unsupported':
      return `${usage.windowLabel} · 该提供方不支持用量读取 · 观察于 ${usage.observedAt}`
  }
}

function ProfilesBlock(props: { profiles: ProviderAccountProfile[] }) {
  const [flow, setFlow] = useState<DeviceFlow | null>(null)
  const [simNote, setSimNote] = useState<string | null>(null)

  return (
    <section className={styles.block} aria-label="Provider Account Profiles">
      <div className={styles.blockHeader}>
        <h3 className={styles.blockTitle}>Provider Account Profiles</h3>
        <Button variant="primary" onClick={() => setFlow({ mode: 'add' })}>
          添加账号
        </Button>
      </div>
      <p className={styles.caption}>每次登录创建一个 Provider Account Profile；可以为同一提供方登记多个 Profile，额度不合并、不自动轮换。</p>
      {simNote ? (
        <p className={styles.simNote} role="status">
          {simNote}
          <Button variant="ghost" onClick={() => setSimNote(null)}>
            知道了
          </Button>
        </p>
      ) : null}
      <ul className={styles.profileList} role="list" aria-label="账号列表">
        {props.profiles.map((profile) => (
          <ProfileCard key={profile.profileId} profile={profile} onReauth={() => setFlow({ mode: 'reauth', profile })} />
        ))}
      </ul>
      {flow ? (
        <DeviceCodeDialog
          flow={flow}
          onClose={() => setFlow(null)}
          onDone={() => {
            setFlow(null)
            setSimNote('fixture：授权完成；授权结果会刷新 Profile。')
          }}
        />
      ) : null}
    </section>
  )
}

function ProfileCard(props: { profile: ProviderAccountProfile; onReauth: () => void }) {
  const { profile } = props
  const provider = providerMeta[profile.provider]
  const needsReauth = profile.authState === 'needs-reauth' || profile.authState === 'expired'

  return (
    <li className={styles.profileCard}>
      <div className={styles.profileTop}>
        <span className={styles.profileName}>{profile.displayName}</span>
        <Chip tone={provider.tone}>{provider.label}</Chip>
        {profile.isDefault ? <Chip tone="ok">默认</Chip> : null}
      </div>
      <dl className={styles.facts}>
        <div>
          <dt>认证状态</dt>
          <dd>{authStateLabel[profile.authState]}</dd>
        </div>
        <div>
          <dt>健康</dt>
          <dd>{healthLabel[profile.health]}</dd>
        </div>
        <div>
          <dt>凭据保护</dt>
          <dd>
            <span className={styles.protection} title="信任以 Host OS 用户身份运行的进程">
              <span aria-hidden>🔒 </span>
              {profile.protectionLevel === 'local-user-trust' ? 'local-user-trust' : 'unprotected（未保护）'}
            </span>
          </dd>
        </div>
        <div>
          <dt>用量</dt>
          <dd className={profile.usage.state === 'available' ? '' : styles.usageMuted}>{usageText(profile.usage)}</dd>
        </div>
      </dl>
      {needsReauth ? (
        <div className={styles.profileActions}>
          <Button variant="primary" onClick={props.onReauth} aria-label={`重新授权 ${profile.displayName}`}>
            重新授权
          </Button>
        </div>
      ) : null}
    </li>
  )
}

/** Simulated device-code flow: no Intent is wired; completion only closes. */
function DeviceCodeDialog(props: { flow: DeviceFlow; onClose: () => void; onDone: () => void }) {
  const [provider, setProvider] = useState<ProviderAccountProfile['provider'] | null>(
    props.flow.mode === 'reauth' ? props.flow.profile.provider : null,
  )

  const title = props.flow.mode === 'reauth' ? `重新授权 · ${props.flow.profile.displayName}` : '添加账号'

  return (
    <Dialog title={title} onClose={props.onClose}>
      {provider === null ? (
        <div className={styles.deviceBody}>
          <p className={styles.deviceText}>选择要登录的提供方。每次登录会创建一个新的 Provider Account Profile。</p>
          <div className={styles.providerOptions}>
            <Button className={styles.providerOption} onClick={() => setProvider('codex')} aria-label="选择 Codex 提供方">
              Codex
            </Button>
            <Button className={styles.providerOption} onClick={() => setProvider('kimi')} aria-label="选择 Kimi 提供方">
              Kimi
            </Button>
          </div>
        </div>
      ) : (
        <div className={styles.deviceBody}>
          <p className={styles.deviceText}>在浏览器中打开验证地址并输入用户代码：</p>
          <p className={styles.deviceCode}>
            <code className={styles.mono}>K2X4-9QWE</code>
          </p>
          <p className={styles.deviceText}>
            验证地址 <code className={styles.mono}>{provider === 'kimi' ? 'https://auth.kimi.example/device' : 'https://auth.codex.example/device'}</code>
          </p>
          <p className={styles.waiting}>
            <Spinner label="等待授权中" /> 等待授权中…
          </p>
          <p className={styles.caption}>fixture：授权结果会刷新 Profile；prototype 不连接真实 OAuth。</p>
          <div className={styles.deviceActions}>
            <Button variant="primary" onClick={props.onDone}>
              已完成授权
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Model Routes
// ---------------------------------------------------------------------------

function RoutesBlock(props: { routes: ModelRoute[]; profiles: ProviderAccountProfile[] }) {
  return (
    <section className={styles.block} aria-label="Model Routes">
      <h3 className={styles.blockTitle}>Model Routes</h3>
      <ul className={styles.routeList} role="list" aria-label="路由列表">
        {props.routes.map((route) => {
          const profile = props.profiles.find((p) => p.profileId === route.profileId)
          return (
            <li key={route.routeId} className={styles.routeRow}>
              <div className={styles.routeMain}>
                <span className={styles.routeLabel}>{route.label}</span>
                <Chip tone={route.provider === 'kimi' ? 'purple' : 'accent'}>{route.provider}</Chip>
                <code className={styles.mono}>{route.model}</code>
                <span className={styles.routeProfile}>{profile?.displayName ?? route.profileId}</span>
              </div>
              <div className={styles.routeContext}>
                容量 {route.contextCapacity} / 运行时上限 {route.runtimeContextLimit}
              </div>
            </li>
          )
        })}
      </ul>
      <p className={styles.caption}>Context Capacity 与 Runtime Context Limit 二者分开记录。</p>
      <p className={styles.caption}>Work Session 保持已解析 Route；活动请求期间不换账号。</p>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Context Policies
// ---------------------------------------------------------------------------

function PoliciesBlock(props: { policies: ContextPolicy[] }) {
  return (
    <section className={styles.block} aria-label="Context Policy">
      <h3 className={styles.blockTitle}>Context Policy</h3>
      <ul className={styles.policyList} role="list" aria-label="压缩策略列表">
        {props.policies.map((policy) => (
          <li key={policy.policyId} className={styles.policyRow}>
            <div className={styles.policyMain}>
              <span className={styles.policyName}>{policy.name}</span>
              <code className={styles.mono}>{policy.version}</code>
              {policy.isDefault ? <Chip tone="ok">默认</Chip> : null}
            </div>
            <div className={styles.policyDetail}>
              触发：{policy.trigger} · 策略：{policy.strategy}
            </div>
          </li>
        ))}
      </ul>
      <p className={styles.caption}>压缩阈值属于配置，不是模型属性。</p>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Generation Jobs
// ---------------------------------------------------------------------------

const jobStateMeta: Record<GenerationJob['state'], { icon: string; label: string; className: 'jobQueued' | 'jobRunning' | 'jobSucceeded' | 'jobFailed' | 'jobCanceled' }> = {
  queued: { icon: '◌', label: '排队中', className: 'jobQueued' },
  running: { icon: '▶', label: '运行中', className: 'jobRunning' },
  succeeded: { icon: '✓', label: '成功', className: 'jobSucceeded' },
  failed: { icon: '✗', label: '失败', className: 'jobFailed' },
  canceled: { icon: '⊘', label: '已取消', className: 'jobCanceled' },
}

function JobsBlock(props: {
  jobs: GenerationJob[]
  concurrency: ModelSupplyProjection['generationConcurrency']
  expectedRevision: number
}) {
  const { submit } = useSubmitIntent()
  const [pendingJobId, setPendingJobId] = useState<string | null>(null)

  const act = async (jobId: string, kind: 'cancel-generation-job' | 'retry-generation-job') => {
    setPendingJobId(jobId)
    await submit({ kind, jobId }, props.expectedRevision)
    setPendingJobId(null)
  }

  return (
    <section className={styles.block} aria-label="Generation Jobs">
      <h3 className={styles.blockTitle}>Generation Jobs</h3>
      <p className={styles.jobSummary}>
        并发上限 {props.concurrency.limit} · 运行中 {props.concurrency.running} · 排队 {props.concurrency.queued}
      </p>
      <ul className={styles.jobList} role="list" aria-label="生成任务列表">
        {props.jobs.map((job) => {
          const state = jobStateMeta[job.state]
          return (
            <li key={job.jobId} className={styles.jobRow}>
              <div className={styles.jobMain}>
                <span className={[styles.jobState, styles[state.className]].join(' ')}>
                  <span aria-hidden>{state.icon} </span>
                  {state.label}
                </span>
                <span className={styles.jobPrompt} title={job.prompt}>
                  {job.prompt}
                </span>
                {job.state === 'queued' ? (
                  <Button variant="ghost" disabled={pendingJobId === job.jobId} onClick={() => act(job.jobId, 'cancel-generation-job')} aria-label={`取消任务：${job.prompt}`}>
                    {pendingJobId === job.jobId ? '提交中…' : '取消'}
                  </Button>
                ) : null}
                {job.state === 'failed' ? (
                  <Button variant="ghost" disabled={pendingJobId === job.jobId} onClick={() => act(job.jobId, 'retry-generation-job')} aria-label={`重试任务：${job.prompt}`}>
                    {pendingJobId === job.jobId ? '提交中…' : '重试'}
                  </Button>
                ) : null}
              </div>
              <div className={styles.jobMeta}>
                <span>{job.route}</span>
                <span>{job.createdAt}</span>
                <span>{job.provenance}</span>
                {job.output ? <code className={styles.mono}>{job.output}</code> : null}
              </div>
            </li>
          )
        })}
      </ul>
      <p className={styles.caption}>Generation Job 记录 Work Session、已解析 Route、提示词、输入、生命周期、输出与来源；provider 允许时独立 Job 可并发。</p>
    </section>
  )
}
