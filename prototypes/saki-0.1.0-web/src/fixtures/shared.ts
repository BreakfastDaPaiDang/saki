import type {
  ActionOffer,
  AgentRunState,
  AttentionEntry,
  AutomationProjection,
  BoardCard,
  BoardProjection,
  ChangesProjection,
  MilestoneEntry,
  ModelSupplyProjection,
  MyWorkProjection,
  ProjectIndexEntry,
  SakiIntent,
  SessionViewProjection,
  WorkItemDetail,
  WorkItemStatus,
  WorkspaceProjection,
} from '../contract/types'
import type { EngineMutator, FixtureControlPlane } from './engine'

/**
 * Shared fixture data and default Intent handlers. Each scenario composes
 * these builders, then overrides the slices it demonstrates. Fixture fields
 * express the frontend contract; they are not final wire types.
 */

export const PROJECT_SAKI = 'proj-saki'
export const PROJECT_WEB = 'proj-website'

const SAKI = 'Saki'
const WEB = '官网改版'

export const columnOrder: { status: WorkItemStatus; title: string }[] = [
  { status: 'inbox', title: 'Inbox' },
  { status: 'backlog', title: 'Backlog' },
  { status: 'ready', title: 'Ready' },
  { status: 'in-progress', title: 'In Progress' },
  { status: 'in-review', title: 'Review' },
  { status: 'done', title: 'Done' },
]

export function offer(intent: SakiIntent, label: string, reasonCode: string, reason: string): ActionOffer {
  return { intent, label, reasonCode, reason }
}

// ---------------------------------------------------------------------------
// Project index
// ---------------------------------------------------------------------------

export function baseProjects(): ProjectIndexEntry[] {
  return [
    {
      projectId: PROJECT_SAKI,
      name: SAKI,
      directory: 'D:\\saki',
      bindingHealth: 'active',
      mappingHealth: 'ok',
      attentionCount: 2,
      activeRuns: 1,
      githubFreshness: 'fresh',
      githubConfirmedAt: '10:15',
      automationPaused: false,
      automationPauseReason: null,
    },
    {
      projectId: PROJECT_WEB,
      name: WEB,
      directory: 'D:\\sites\\website',
      bindingHealth: 'active',
      mappingHealth: 'ok',
      attentionCount: 1,
      activeRuns: 0,
      githubFreshness: 'stale',
      githubConfirmedAt: '08:47',
      automationPaused: false,
      automationPauseReason: null,
    },
  ]
}

// ---------------------------------------------------------------------------
// My Work
// ---------------------------------------------------------------------------

export function baseMyWork(): MyWorkProjection {
  return {
    principalName: '你',
    items: [
      {
        workItemId: 'wi-128',
        projectId: PROJECT_WEB,
        projectName: WEB,
        issueNumber: 128,
        title: '官网改版',
        subtitle: '补充产品截图并优化落地页文案',
        group: 'not-started',
        status: 'ready',
        currentActor: '你',
        updatedAt: '昨天 16:42',
        blocked: false,
        offer: offer({ kind: 'claim-work-item', workItemId: 'wi-128' }, '交给 Agent', 'ready-complete', '已就绪：验收条件完整，没有阻塞'),
        offerUnavailableReason: null,
      },
      {
        workItemId: 'wi-125',
        projectId: PROJECT_SAKI,
        projectName: SAKI,
        issueNumber: 125,
        title: 'API 文档完善',
        subtitle: '补充错误码说明与示例请求',
        group: 'in-progress',
        status: 'in-progress',
        currentActor: 'Agent 正在处理',
        updatedAt: '今天 10:15',
        blocked: false,
        offer: offer({ kind: 'claim-work-item', workItemId: 'wi-125' }, '打开', 'open-active', 'Agent 正在处理，打开查看进展'),
        offerUnavailableReason: null,
      },
      {
        workItemId: 'wi-123',
        projectId: PROJECT_SAKI,
        projectName: SAKI,
        issueNumber: 123,
        title: '用户反馈收集',
        subtitle: '确认导出报表字段是否齐全',
        group: 'waiting-on-you',
        status: 'in-progress',
        currentActor: '产品同学',
        updatedAt: '今天 09:30',
        blocked: false,
        offer: offer({ kind: 'answer-intervention', interventionId: 'iv-123', response: '' }, '回答', 'intervention-open', 'Agent 等待你的回答才能继续'),
        offerUnavailableReason: null,
      },
      {
        workItemId: 'wi-121',
        projectId: PROJECT_WEB,
        projectName: WEB,
        issueNumber: 121,
        title: '登录体验优化',
        subtitle: '一键登录支持邮箱格式校验',
        group: 'waiting-on-you',
        status: 'in-review',
        currentActor: '你',
        updatedAt: '昨天 11:20',
        blocked: false,
        offer: offer({ kind: 'accept-deliverable', workItemId: 'wi-121' }, '验收', 'review-ci-passed', 'PR #432 已通过 CI，等待你验收'),
        offerUnavailableReason: null,
      },
      {
        workItemId: 'wi-119',
        projectId: PROJECT_SAKI,
        projectName: SAKI,
        issueNumber: 119,
        title: '新手引导流程优化',
        subtitle: '减少首次启动的步骤',
        group: 'recently-finished',
        status: 'done',
        currentActor: '你',
        updatedAt: '5月9日',
        blocked: false,
        offer: null,
        offerUnavailableReason: null,
      },
      {
        workItemId: 'wi-117',
        projectId: PROJECT_SAKI,
        projectName: SAKI,
        issueNumber: 117,
        title: '修复会话导出格式问题',
        subtitle: '导出内容缺少代码块',
        group: 'recently-finished',
        status: 'canceled',
        currentActor: '你',
        updatedAt: '5月7日',
        blocked: false,
        offer: null,
        offerUnavailableReason: null,
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

function card(partial: Partial<BoardCard> & Pick<BoardCard, 'workItemId' | 'issueNumber' | 'title' | 'status'>): BoardCard {
  return {
    labels: [],
    assignee: '你',
    updatedAt: '今天 09:10',
    blocked: false,
    notInProject: false,
    milestone: null,
    runSummary: null,
    prRef: null,
    ciState: null,
    remoteFingerprint: `fp-${partial.workItemId}-1`,
    ...partial,
  }
}

export function baseBoard(): BoardProjection {
  const cards: BoardCard[] = [
    card({ workItemId: 'wi-128', issueNumber: 128, title: '支持批量上传知识库文件', status: 'inbox', labels: [{ name: 'enhancement', tone: 'purple' }], assignee: '产品同学', notInProject: true }),
    card({ workItemId: 'wi-127', issueNumber: 127, title: '优化移动端对话输入体验', status: 'inbox', labels: [{ name: 'ux', tone: 'info' }], assignee: '产品同学', updatedAt: '昨天 17:08' }),
    card({ workItemId: 'wi-126', issueNumber: 126, title: '会话列表支持关键词搜索', status: 'ready', labels: [{ name: 'enhancement', tone: 'purple' }], updatedAt: '昨天 16:42' }),
    card({ workItemId: 'wi-125', issueNumber: 125, title: 'API 文档完善与示例补充', status: 'ready', labels: [{ name: 'documentation', tone: 'info' }], assignee: 'Agent', updatedAt: '昨天 15:20', milestone: 'v0.2.0' }),
    card({ workItemId: 'wi-124', issueNumber: 124, title: '错误码体系梳理与返回', status: 'ready', labels: [{ name: 'backend', tone: 'ok' }], updatedAt: '5月10日', milestone: 'v0.2.0' }),
    card({ workItemId: 'wi-123', issueNumber: 123, title: '用户反馈收集与分析看板', status: 'in-progress', labels: [{ name: 'enhancement', tone: 'purple' }], assignee: 'Agent', runSummary: 'Agent 正在处理', updatedAt: '今天 10:15', milestone: 'v0.2.0' }),
    card({ workItemId: 'wi-122', issueNumber: 122, title: '登录体验优化', status: 'in-progress', labels: [{ name: 'backend', tone: 'ok' }], updatedAt: '昨天 11:20' }),
    card({ workItemId: 'wi-121', issueNumber: 121, title: '官网改版：定价模块优化', status: 'in-review', labels: [{ name: 'enhancement', tone: 'purple' }], runSummary: 'Agent 已提交', prRef: '#432', ciState: 'passing', updatedAt: '昨天 16:42', milestone: 'v0.2.0' }),
    card({ workItemId: 'wi-120', issueNumber: 120, title: '补充产品截图与落地页文案', status: 'in-review', labels: [{ name: 'documentation', tone: 'info' }], runSummary: 'Agent 已提交', prRef: '#428', ciState: 'pending', updatedAt: '昨天 14:05' }),
    card({ workItemId: 'wi-119', issueNumber: 119, title: '新手引导流程优化', status: 'done', labels: [{ name: 'ux', tone: 'info' }], runSummary: 'Agent 已合并', updatedAt: '5月9日' }),
    card({ workItemId: 'wi-118', issueNumber: 118, title: '支持深色模式切换', status: 'done', labels: [{ name: 'frontend', tone: 'accent' }], runSummary: '你已合并', updatedAt: '5月8日' }),
    card({ workItemId: 'wi-117', issueNumber: 117, title: '修复会话导出格式问题', status: 'done', labels: [{ name: 'bugfix', tone: 'danger' }], runSummary: 'Agent 已合并', updatedAt: '5月7日', prRef: '#415', ciState: 'passing' }),
  ]
  return {
    projectId: PROJECT_SAKI,
    checkpoint: { generation: 14, confirmedAt: '10:15', complete: true },
    columns: columnOrder.map(({ status }) => ({ status, cards: cards.filter((c) => c.status === status) })),
    mappingHealth: 'ok',
    mappingRepairDetail: null,
    freshness: 'fresh',
  }
}

// ---------------------------------------------------------------------------
// Work item detail
// ---------------------------------------------------------------------------

export function baseWorkItemDetail(): WorkItemDetail {
  return {
    workItemId: 'wi-123',
    projectId: PROJECT_SAKI,
    issueNumber: 123,
    title: '用户反馈收集与分析看板',
    body: '在数据看板中新增用户反馈收集入口，支持按来源、关键字、时间维度筛选与导出分析。',
    status: 'in-progress',
    labels: [{ name: 'enhancement', tone: 'purple' }],
    assignee: 'Agent',
    creator: '产品同学',
    createdAt: '5月10日 14:32',
    updatedAt: '今天 10:15',
    blocked: false,
    acceptance: ['反馈列表可按来源与时间筛选', '导出 CSV 包含全部字段', '空状态有引导文案'],
    milestone: 'v0.2.0',
    sessionRef: '#2310',
    agentRun: { runId: 'run-7f1c9e2a', state: 'waiting-for-user', summary: 'Agent 运行中 · 已进行 8 分钟', startedAt: '今天 10:15' },
    prRef: '#432',
    ciState: 'passing',
    evidence: [
      { kind: 'commit', label: '提交', ref: 'a1b2c3d' },
      { kind: 'pr', label: 'PR', ref: '#432' },
      { kind: 'ci', label: 'CI', ref: '通过' },
    ],
    interventions: [{ interventionId: 'iv-123', question: '导出报表需要包含哪些字段？当前实现包含来源、关键字、时间、满意度评分。', status: 'open' }],
    activity: [
      { at: '10:19:45', actor: '系统', text: 'CI 检查全部通过' },
      { at: '10:19:02', actor: 'Agent', text: '已创建 PR #432' },
      { at: '10:18:27', actor: 'Agent', text: '提交 2 个 commit 到 feature/saki-123-feedback' },
      { at: '10:15:06', actor: 'Agent', text: 'Agent 开始执行任务' },
      { at: '10:15:03', actor: '你', text: '已领取：Agent 在 Ready 列自动领取' },
    ],
    offer: offer({ kind: 'answer-intervention', interventionId: 'iv-123', response: '' }, '回答', 'intervention-open', 'Agent 等待你的回答才能继续'),
    offerUnavailableReason: null,
  }
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

export function baseChanges(): ChangesProjection {
  return {
    projectId: PROJECT_SAKI,
    branch: 'feature/saki-123-feedback',
    head: 'a1b2c3d',
    staged: [
      {
        path: 'src/feedback/FeedbackBoard.tsx',
        changeKind: 'added',
        additions: 182,
        deletions: 0,
        diffPreview: ['+ export function FeedbackBoard() {', '+   const [filter, setFilter] = useState<Filter>({})', '+   // ...', '+ }'],
      },
      {
        path: 'src/feedback/export.ts',
        changeKind: 'modified',
        additions: 46,
        deletions: 12,
        diffPreview: ['- const FIELDS = [\'source\', \'time\']', '+ const FIELDS = [\'source\', \'keyword\', \'time\', \'score\']'],
      },
    ],
    unstaged: [
      {
        path: 'src/feedback/FeedbackBoard.module.css',
        changeKind: 'modified',
        additions: 21,
        deletions: 4,
        diffPreview: ['- .row { padding: 4px }', '+ .row { padding: 8px 12px }'],
      },
    ],
    untracked: [
      { path: 'docs/feedback-fields.md', changeKind: 'added', additions: 38, deletions: 0, diffPreview: ['+ # 反馈导出字段说明', '+ 来源 / 关键字 / 时间 / 满意度评分'] },
    ],
    inheritedNotice: null,
    eligibility: { canCommit: true, canPush: true, reason: null },
  }
}

// ---------------------------------------------------------------------------
// Sessions & runs
// ---------------------------------------------------------------------------

export function baseSessions(): SessionViewProjection {
  return {
    projectId: PROJECT_SAKI,
    sessions: [
      { workSessionId: 'ws-2310', workItemId: 'wi-123', title: '#123 用户反馈收集与分析看板', state: 'active', updatedAt: '10:15', runState: 'running' },
      { workSessionId: 'ws-2298', workItemId: 'wi-117', title: '#117 修复会话导出格式问题', state: 'waiting', updatedAt: '09:52', runState: 'waiting-for-user' },
      { workSessionId: 'ws-2280', workItemId: 'wi-121', title: '#121 官网改版：定价模块优化', state: 'finished', updatedAt: '昨天 16:42', runState: 'succeeded' },
      { workSessionId: 'ws-2264', workItemId: 'wi-126', title: '#126 会话列表支持关键词搜索', state: 'finished', updatedAt: '昨天 16:42', runState: 'succeeded' },
      { workSessionId: 'ws-2241', workItemId: 'wi-125', title: '#125 API 文档完善与示例补充', state: 'finished', updatedAt: '昨天 15:20', runState: 'succeeded' },
    ],
    selected: {
      workSessionId: 'ws-2310',
      dshSessionRef: 'sess-2310',
      title: '#123 用户反馈收集与分析看板',
      workItemId: 'wi-123',
      runId: 'run-7f1c9e2a',
      runState: 'running',
      runStartedAt: '今天 10:15',
      automationNote: '自动模式：Ready 后自动领取',
      timeline: [
        { at: '10:15:03', kind: 'claimed', text: '已领取 · Agent 在 Ready 列自动领取' },
        { at: '10:15:04', kind: 'session-created', text: '创建会话 · 已创建会话 #2310' },
        { at: '10:15:06', kind: 'started', text: 'Agent 开始 · Agent 开始执行任务' },
        { at: '10:18:27', kind: 'committed', text: '提交变更 · 提交 2 个 commit 到 feature/saki-123-feedback' },
        { at: '10:19:02', kind: 'pr-created', text: 'PR 已创建 · 已创建 PR #432' },
        { at: '10:19:45', kind: 'ci', text: 'CI 通过 · CI 检查全部通过' },
      ],
      related: [
        { label: '工作项', value: '#123 用户反馈收集与分析看板', state: 'enhancement' },
        { label: '会话', value: '#2310', state: '进行中' },
        { label: 'Agent 运行', value: '今天 10:15 开始', state: '运行中' },
        { label: '提交', value: '2 个 commit', state: 'a1b2c3d' },
        { label: 'PR', value: '#432', state: '已创建' },
        { label: 'CI', value: '检查全部通过', state: '通过' },
      ],
    },
  }
}

// ---------------------------------------------------------------------------
// Attention inbox
// ---------------------------------------------------------------------------

export function baseAttention(): AttentionEntry[] {
  return [
    {
      attentionId: 'att-1',
      projectId: PROJECT_SAKI,
      projectName: SAKI,
      severity: 'action-needed',
      kind: 'intervention',
      title: '#123 用户反馈收集：等待你回答',
      detail: '导出报表需要包含哪些字段？',
      age: '45 分钟前',
      interventionId: 'iv-123',
      question: '导出报表需要包含哪些字段？当前实现包含来源、关键字、时间、满意度评分。',
      returnAddress: { kind: 'work', projectId: PROJECT_SAKI, workItemId: 'wi-123' },
    },
    {
      attentionId: 'att-2',
      projectId: PROJECT_WEB,
      projectName: WEB,
      severity: 'info',
      kind: 'assignment',
      title: '#128 官网改版：已分配给你',
      detail: '已就绪：验收条件完整，可以交给 Agent',
      age: '昨天',
      interventionId: null,
      question: null,
      returnAddress: { kind: 'work', projectId: PROJECT_WEB },
    },
    {
      attentionId: 'att-3',
      projectId: PROJECT_WEB,
      projectName: WEB,
      severity: 'action-needed',
      kind: 'intervention',
      title: '#121 登录体验优化：等待验收',
      detail: 'PR #432 已通过 CI，等待你验收',
      age: '昨天',
      interventionId: null,
      question: null,
      returnAddress: { kind: 'work', projectId: PROJECT_WEB, workItemId: 'wi-121' },
    },
  ]
}

// ---------------------------------------------------------------------------
// Automation
// ---------------------------------------------------------------------------

export function baseAutomation(): AutomationProjection {
  return {
    projectId: PROJECT_SAKI,
    policyRevision: 7,
    enabled: false,
    enabledActions: ['领取 Ready 工作项', '创建或继续会话', '提交与推送', '创建 PR'],
    limits: [
      { dimension: '并发 Agent Run', limit: '1', used: '1' },
      { dimension: 'Run 时长', limit: '45 分钟', used: '8 分钟' },
      { dimension: '模型请求 / 天', limit: '200', used: '37' },
      { dimension: 'Generation Job / 天', limit: '10', used: '2' },
      { dimension: 'GitHub mutation / 小时', limit: '60', used: '11' },
    ],
    reservations: [{ id: 'rsv-8842', scope: 'run-7f1c9e2a', dimensions: '模型请求 ×12 · token ×48k' }],
    paused: false,
    pauseReason: null,
    unknownObservations: [],
  }
}

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

export function baseMilestones(): MilestoneEntry[] {
  return [
    {
      milestoneId: 'ms-020',
      title: 'v0.2.0',
      phase: 'in-progress',
      dueDate: '9月1日',
      counts: { 'in-progress': 2, 'in-review': 2, ready: 2, done: 0 },
      blockedCount: 0,
      release: null,
    },
    {
      milestoneId: 'ms-010',
      title: 'v0.1.0',
      phase: 'released',
      dueDate: null,
      counts: { done: 9, canceled: 1 },
      blockedCount: 0,
      release: { tag: 'saki-v0.1.0', commit: 'e3dde79' },
    },
  ]
}

// ---------------------------------------------------------------------------
// Model supply
// ---------------------------------------------------------------------------

export function baseModelSupply(): ModelSupplyProjection {
  return {
    profiles: [
      {
        profileId: 'pap-codex-1',
        provider: 'codex',
        displayName: 'Codex Pro（个人）',
        authState: 'authorized',
        health: 'healthy',
        protectionLevel: 'local-user-trust',
        usage: { state: 'available', windowLabel: '本周额度', remainingLabel: '剩余 42%', observedAt: '10:12' },
        capabilities: ['文本', '工具调用', '生图'],
        isDefault: true,
      },
      {
        profileId: 'pap-codex-2',
        provider: 'codex',
        displayName: 'Codex Pro（团队）',
        authState: 'authorized',
        health: 'healthy',
        protectionLevel: 'local-user-trust',
        usage: { state: 'temporarily-unavailable', windowLabel: '本周额度', remainingLabel: '用量数据暂时不可用', observedAt: '09:58' },
        capabilities: ['文本', '工具调用'],
        isDefault: false,
      },
      {
        profileId: 'pap-kimi-1',
        provider: 'kimi',
        displayName: 'Kimi 订阅（个人）',
        authState: 'authorized',
        health: 'healthy',
        protectionLevel: 'local-user-trust',
        usage: { state: 'available', windowLabel: '本月额度', remainingLabel: '剩余 68%', observedAt: '10:10' },
        capabilities: ['文本', '工具调用', '前端见长'],
        isDefault: false,
      },
      {
        profileId: 'pap-kimi-2',
        provider: 'kimi',
        displayName: 'Kimi 订阅（备用）',
        authState: 'needs-reauth',
        health: 'unavailable',
        protectionLevel: 'local-user-trust',
        usage: { state: 'temporarily-unavailable', windowLabel: '本月额度', remainingLabel: '授权已过期', observedAt: '08:31' },
        capabilities: ['文本', '工具调用'],
        isDefault: false,
      },
    ],
    routes: [
      { routeId: 'route-codex-gpt5', label: 'Codex · GPT-5（个人 Pro）', provider: 'codex', model: 'gpt-5', profileId: 'pap-codex-1', contextCapacity: '400k', runtimeContextLimit: '272k' },
      { routeId: 'route-kimi-k2', label: 'Kimi · K2（个人订阅）', provider: 'kimi', model: 'kimi-k2', profileId: 'pap-kimi-1', contextCapacity: '256k', runtimeContextLimit: '200k' },
    ],
    contextPolicies: [
      { policyId: 'cp-standard', name: '标准压缩', version: 'v3', trigger: '达到 Runtime Context Limit 的 85%', strategy: '保留指令与决定，压缩工具输出', isDefault: true },
      { policyId: 'cp-conservative', name: '保守裁剪', version: 'v1', trigger: '达到 Runtime Context Limit 的 70%', strategy: '更早压缩，保留更多余量（实验性）', isDefault: false },
    ],
    generationJobs: [
      { jobId: 'gj-301', projectName: SAKI, prompt: '为反馈看板生成空状态插画', route: 'Codex · GPT-5（个人 Pro）', state: 'running', createdAt: '10:11', output: null, provenance: 'Work Session #2310' },
      { jobId: 'gj-300', projectName: SAKI, prompt: '官网首页横幅参考图编辑', route: 'Codex · GPT-5（个人 Pro）', state: 'queued', createdAt: '10:09', output: null, provenance: 'Work Item #128' },
      { jobId: 'gj-299', projectName: WEB, prompt: '定价模块示意图', route: 'Kimi · K2（个人订阅）', state: 'queued', createdAt: '09:55', output: null, provenance: 'Work Item #121' },
      { jobId: 'gj-298', projectName: SAKI, prompt: '新手引导第 2 步截图重绘', route: 'Codex · GPT-5（个人 Pro）', state: 'succeeded', createdAt: '昨天 16:20', output: 'onboarding-step2.png', provenance: 'Work Item #119' },
      { jobId: 'gj-297', projectName: SAKI, prompt: '错误页插画', route: 'Kimi · K2（个人订阅）', state: 'failed', createdAt: '昨天 15:02', output: null, provenance: 'Work Session #2280' },
    ],
    generationConcurrency: { limit: 2, running: 1, queued: 2 },
  }
}

// ---------------------------------------------------------------------------
// Workspace (Development Workspace projection for the selected project)
// ---------------------------------------------------------------------------

export function baseWorkspace(): WorkspaceProjection {
  return {
    projectId: PROJECT_SAKI,
    bindingRevision: 3,
    bindingHealth: 'active',
    displayPath: 'D:\\saki',
    branch: 'feature/saki-123-feedback',
    head: 'a1b2c3d',
    aheadBehind: { ahead: 2, behind: 0 },
    dirtySummary: { staged: 2, unstaged: 1, untracked: 1 },
    primaryWorkSessionId: 'ws-2310',
    activeOperations: ['Agent Run 运行中（8 分钟）'],
    blockedRecovery: [],
  }
}

// ---------------------------------------------------------------------------
// Default Intent handlers. Scenarios override individual handlers.
// ---------------------------------------------------------------------------

export function installDefaultHandlers(engine: FixtureControlPlane): void {
  engine.onIntent('claim-work-item', (intent, api) => {
    if (intent.kind !== 'claim-work-item') return { type: 'failed', message: 'intent 类型不匹配' }
    moveCardBetweenColumns(api, intent.workItemId, 'in-progress')
    updateMyWorkItem(api, intent.workItemId, (item) => ({
      ...item,
      group: 'in-progress',
      status: 'in-progress',
      currentActor: 'Agent 正在处理',
      updatedAt: api.now(),
      offer: null,
      offerUnavailableReason: 'Agent 正在处理；新的操作会在它需要你时出现',
    }))
    return { type: 'confirmed', message: '已交给 Agent：已创建 Work Assignment，Dispatch 已持久化' }
  })

  engine.onIntent('move-work-item', (intent, api) => {
    if (intent.kind !== 'move-work-item') return { type: 'failed', message: 'intent 类型不匹配' }
    return applyMoveWorkItem(api, intent.workItemId, intent.targetStatus, intent.expectedRemoteFingerprint)
  })

  engine.onIntent('answer-intervention', (_intent, api) => {
    resolveIntervention(api)
    return { type: 'confirmed', message: '回答已提交，Agent 将继续执行' }
  })

  engine.onIntent('accept-deliverable', (intent, api) => {
    if (intent.kind !== 'accept-deliverable') return { type: 'failed', message: 'intent 类型不匹配' }
    updateMyWorkItem(api, intent.workItemId, (item) => ({
      ...item,
      group: 'recently-finished',
      status: 'done',
      updatedAt: api.now(),
      offer: null,
      offerUnavailableReason: null,
    }))
    return { type: 'confirmed', message: '已验收：Outcome Evidence 满足，Issue 已关闭' }
  })

  engine.onIntent('stage-files', (intent, api) => {
    if (intent.kind !== 'stage-files') return { type: 'failed', message: 'intent 类型不匹配' }
    moveFiles(api, intent.projectId, intent.paths, 'staged')
    return { type: 'confirmed', message: `已暂存 ${intent.paths.length} 个文件` }
  })

  engine.onIntent('unstage-files', (intent, api) => {
    if (intent.kind !== 'unstage-files') return { type: 'failed', message: 'intent 类型不匹配' }
    moveFiles(api, intent.projectId, intent.paths, 'unstaged')
    return { type: 'confirmed', message: `已取消暂存 ${intent.paths.length} 个文件` }
  })

  engine.onIntent('commit', (_intent, api) => {
    api.update<ChangesProjection>(`changes:${PROJECT_SAKI}`, (c) => ({ ...c, staged: [], head: 'b2c3d4e' }))
    return { type: 'confirmed', message: '已提交：commit b2c3d4e' }
  })

  engine.onIntent('push', (_intent, api) => {
    api.update<WorkspaceProjection>(`workspace:${PROJECT_SAKI}`, (w) => ({ ...w, aheadBehind: { ahead: 0, behind: 0 } }))
    return { type: 'confirmed', message: '已推送到 origin/feature/saki-123-feedback' }
  })

  engine.onIntent('create-pr', (_intent, api) => {
    void api
    return { type: 'confirmed', message: '已创建 PR #433 并关联到工作项' }
  })

  engine.onIntent('register-project', (intent, api) => {
    if (intent.kind !== 'register-project') return { type: 'failed', message: 'intent 类型不匹配' }
    api.update<ProjectIndexEntry[]>('projects', (projects) => [
      ...projects,
      {
        projectId: 'proj-registered',
        name: intent.displayName,
        directory: intent.directory,
        bindingHealth: 'active',
        mappingHealth: 'ok',
        attentionCount: 0,
        activeRuns: 0,
        githubFreshness: 'fresh',
        githubConfirmedAt: api.now(),
        automationPaused: false,
        automationPauseReason: null,
      },
    ])
    return { type: 'confirmed', message: `已登记 Development Project「${intent.displayName}」` }
  })

  engine.onIntent('repair-binding', (intent, api) => {
    if (intent.kind !== 'repair-binding') return { type: 'failed', message: 'intent 类型不匹配' }
    api.update<ProjectIndexEntry[]>('projects', (projects) =>
      projects.map((p) => (p.projectId === intent.projectId ? { ...p, bindingHealth: 'active' as const } : p)),
    )
    return { type: 'confirmed', message: 'Resource Binding 已重新验证，项目恢复可写' }
  })

  engine.onIntent('repair-mapping', (intent, api) => {
    if (intent.kind !== 'repair-mapping') return { type: 'failed', message: 'intent 类型不匹配' }
    api.update<BoardProjection>(`board:${intent.projectId}`, (b) => ({ ...b, mappingHealth: 'ok', mappingRepairDetail: null }))
    return { type: 'confirmed', message: 'GitHub Status 字段映射已修复，看板恢复读写' }
  })

  engine.onIntent('create-work-item', (intent, api) => {
    if (intent.kind !== 'create-work-item') return { type: 'failed', message: 'intent 类型不匹配' }
    const workItemId = `wi-${130 + Math.floor(Math.random() * 60)}`
    api.update<BoardProjection>(`board:${intent.projectId}`, (b) => ({
      ...b,
      columns: b.columns.map((c) =>
        c.status === 'inbox'
          ? { ...c, cards: [...c.cards, { workItemId, issueNumber: 130, title: intent.title, status: 'inbox' as const, labels: [], assignee: '你', updatedAt: api.now(), blocked: false, notInProject: false, milestone: null, runSummary: null, prRef: null, ciState: null, remoteFingerprint: `fp-${workItemId}-1` }] }
          : c,
      ),
    }))
    return { type: 'confirmed', message: '已创建 Issue 并加入 Project 的 Inbox' }
  })

  engine.onIntent('complete-bootstrap', (_intent, api) => {
    void api
    return { type: 'confirmed', message: '已完成 bootstrap：本地 Principal 已创建并获得 Host Operator Grant' }
  })

  engine.onIntent('resume-automation', (intent, api) => {
    if (intent.kind !== 'resume-automation') return { type: 'failed', message: 'intent 类型不匹配' }
    api.update<AutomationProjection>(`automation:${intent.projectId}`, (a) => ({ ...a, paused: false, pauseReason: null }))
    return { type: 'confirmed', message: '自动化已恢复' }
  })

  engine.onIntent('budget-exception', (_intent, api) => {
    void api
    return { type: 'confirmed', message: '已记录一次性预算例外（24 小时后过期），自动化已恢复' }
  })

  engine.onIntent('cancel-generation-job', (intent, api) => {
    if (intent.kind !== 'cancel-generation-job') return { type: 'failed', message: 'intent 类型不匹配' }
    api.update<ModelSupplyProjection>('model-supply', (m) => ({
      ...m,
      generationJobs: m.generationJobs.map((j) => (j.jobId === intent.jobId ? { ...j, state: 'canceled' as const } : j)),
      generationConcurrency: { ...m.generationConcurrency, queued: Math.max(0, m.generationConcurrency.queued - 1) },
    }))
    return { type: 'confirmed', message: '已取消排队中的 Generation Job' }
  })

  engine.onIntent('retry-generation-job', (intent, api) => {
    if (intent.kind !== 'retry-generation-job') return { type: 'failed', message: 'intent 类型不匹配' }
    api.update<ModelSupplyProjection>('model-supply', (m) => ({
      ...m,
      generationJobs: m.generationJobs.map((j) => (j.jobId === intent.jobId ? { ...j, state: 'queued' as const } : j)),
    }))
    return { type: 'confirmed', message: '已重新排队该 Generation Job' }
  })
}

/**
 * Default move-work-item semantics, exported so scenario overrides (e.g. a
 * scripted conflict on the first attempt) can delegate after their script.
 */
export function applyMoveWorkItem(
  api: EngineMutator,
  workItemId: string,
  targetStatus: WorkItemStatus,
  expectedRemoteFingerprint: string,
): { type: 'confirmed' | 'conflict' | 'failed'; message: string } {
  const board = api.read<BoardProjection>(`board:${PROJECT_SAKI}`)
  const current = board?.data.columns.flatMap((c) => c.cards).find((c) => c.workItemId === workItemId)
  if (!current) return { type: 'failed', message: '找不到该工作项' }
  if (current.remoteFingerprint !== expectedRemoteFingerprint) {
    return { type: 'conflict', message: '远端状态已变化：卡片被其他操作移动过，已恢复为最新确认状态' }
  }
  moveCardBetweenColumns(api, workItemId, targetStatus)
  return { type: 'confirmed', message: `已移动到 ${targetStatus}，GitHub 已确认` }
}

function moveCardBetweenColumns(api: EngineMutator, workItemId: string, target: WorkItemStatus): void {
  api.update<BoardProjection>(`board:${PROJECT_SAKI}`, (b) => {
    const found = b.columns.flatMap((c) => c.cards).find((c) => c.workItemId === workItemId)
    if (!found) return b
    const moved = { ...found, status: target, remoteFingerprint: `${found.remoteFingerprint}+` }
    return {
      ...b,
      columns: b.columns.map((c) => ({
        ...c,
        cards: c.status === target ? [...c.cards.filter((x) => x.workItemId !== workItemId), moved] : c.cards.filter((x) => x.workItemId !== workItemId),
      })),
    }
  })
}

function updateMyWorkItem(api: EngineMutator, workItemId: string, mutate: (item: MyWorkProjection['items'][number]) => MyWorkProjection['items'][number]): void {
  api.update<MyWorkProjection>('my-work', (mw) => ({
    ...mw,
    items: mw.items.map((item) => (item.workItemId === workItemId ? mutate(item) : item)),
  }))
}

function resolveIntervention(api: EngineMutator): void {
  api.update<MyWorkProjection>('my-work', (mw) => ({
    ...mw,
    items: mw.items.map((item) =>
      item.workItemId === 'wi-123'
        ? { ...item, group: 'in-progress', currentActor: 'Agent 正在处理', updatedAt: api.now(), offer: null, offerUnavailableReason: 'Agent 正在处理；新的操作会在它需要你时出现' }
        : item,
    ),
  }))
  api.update<AttentionEntry[]>('attention', (entries) => entries.filter((e) => e.interventionId !== 'iv-123'))
  api.update<WorkItemDetail>('work-item:wi-123', (d) => ({
    ...d,
    interventions: d.interventions.map((iv) => ({ ...iv, status: 'answered' as const })),
    agentRun: d.agentRun ? { ...d.agentRun, state: 'running' as AgentRunState, summary: 'Agent 运行中 · 已继续执行' } : null,
    offer: null,
    offerUnavailableReason: 'Agent 正在处理；新的操作会在它需要你时出现',
    activity: [{ at: api.now(), actor: '你', text: '已回答 Intervention，Agent 继续执行' }, ...d.activity],
  }))
}

function moveFiles(api: EngineMutator, projectId: string, paths: string[], target: 'staged' | 'unstaged'): void {
  api.update<ChangesProjection>(`changes:${projectId}`, (c) => {
    const source = target === 'staged' ? [...c.unstaged, ...c.untracked] : c.staged
    const moving = source.filter((f) => paths.includes(f.path))
    if (target === 'staged') {
      return {
        ...c,
        staged: [...c.staged, ...moving],
        unstaged: c.unstaged.filter((f) => !paths.includes(f.path)),
        untracked: c.untracked.filter((f) => !paths.includes(f.path)),
      }
    }
    return { ...c, staged: c.staged.filter((f) => !paths.includes(f.path)), unstaged: [...c.unstaged, ...moving] }
  })
}
