import type { SakiViewAddress } from '../contract/types'
import type { FixtureControlPlane } from './engine'
import {
  PROJECT_SAKI,
  PROJECT_WEB,
  applyMoveWorkItem,
  baseAttention,
  baseAutomation,
  baseBoard,
  baseChanges,
  baseMilestones,
  baseModelSupply,
  baseMyWork,
  baseProjectConfig,
  baseProjects,
  baseSessions,
  baseWorkItemDetail,
  baseWorkspace,
  installDefaultHandlers,
  websiteBoard,
} from './shared'

/**
 * Named, switchable fixtures. Each scenario documents the Projections it
 * simulates, the Intents it accepts, and the results it demonstrates. Fields
 * express the frontend contract only; they are not final wire types.
 */
export interface ScenarioDef {
  id: string
  title: string
  summary: string
  /** What this scenario proves, mapped to K0 acceptance bullets. */
  demonstrates: string[]
  /** Address the prototype opens on when the scenario is selected. */
  startAddress: SakiViewAddress
  install: (engine: FixtureControlPlane) => void
}

function installBase(engine: FixtureControlPlane): void {
  engine.define('my-work', baseMyWork())
  engine.define('projects', baseProjects())
  engine.define(`workspace:${PROJECT_SAKI}`, baseWorkspace())
  engine.define(`workspace:${PROJECT_WEB}`, {
    ...baseWorkspace(),
    projectId: PROJECT_WEB,
    displayPath: 'D:\\sites\\website',
    branch: 'main',
    head: 'f4e5d6c',
    aheadBehind: { ahead: 0, behind: 3 },
    dirtySummary: { staged: 0, unstaged: 0, untracked: 0 },
    primaryWorkSessionId: null,
    activeOperations: [],
  })
  engine.define(`board:${PROJECT_SAKI}`, baseBoard())
  engine.define(`board:${PROJECT_WEB}`, websiteBoard())
  engine.define('work-item:wi-123', baseWorkItemDetail())
  engine.define(`changes:${PROJECT_SAKI}`, baseChanges())
  engine.define(`changes:${PROJECT_WEB}`, { ...baseChanges(), projectId: PROJECT_WEB, branch: 'main', staged: [], unstaged: [], untracked: [], inheritedNotice: null })
  engine.define(`sessions:${PROJECT_SAKI}`, baseSessions())
  engine.define(`sessions:${PROJECT_WEB}`, { ...baseSessions(), projectId: PROJECT_WEB, sessions: [], selected: null })
  engine.define('attention', baseAttention())
  engine.define(`automation:${PROJECT_SAKI}`, baseAutomation())
  engine.define(`automation:${PROJECT_WEB}`, { ...baseAutomation(), projectId: PROJECT_WEB })
  engine.define(`project-config:${PROJECT_SAKI}`, baseProjectConfig(PROJECT_SAKI))
  engine.define(`project-config:${PROJECT_WEB}`, baseProjectConfig(PROJECT_WEB))
  engine.define(`milestones:${PROJECT_SAKI}`, baseMilestones())
  engine.define(`milestones:${PROJECT_WEB}`, [])
  engine.define('model-supply', baseModelSupply())
  installDefaultHandlers(engine)
}

export const scenarios: ScenarioDef[] = [
  {
    id: 'operator-day',
    title: '日常 · 手动模式',
    summary: '两个已登记项目；My Work 覆盖待开始、处理中、等你处理（含等待验收）与最近结束；Changes 可从暂存走到交付。',
    demonstrates: ['My Work 四分组与单一 Action Offer', '手动领取（交给 Agent）', '等待回答 / 等待验收', 'Changes 暂存→提交→推送→创建 PR', 'Done/Canceled 不出现验收操作'],
    startAddress: { kind: 'my-work' },
    install: (engine) => installBase(engine),
  },
  {
    id: 'fresh-install',
    title: '首次启动 · bootstrap 与项目登记',
    summary: '没有本地 Principal：先完成一次性 bootstrap，再把已有本地目录登记为 Development Project，并复核 Git 与重复候选证据。',
    demonstrates: ['一次性 bootstrap', '登记已有目录', 'Git top level / 重复候选 / dirty-state 复核', '登记后进入 Development Workspace'],
    startAddress: { kind: 'bootstrap' },
    install: (engine) => {
      installBase(engine)
      engine.define('projects', [])
      engine.define('my-work', { principalName: '你', items: [] })
      engine.define('attention', [])
      // The newly registered project gets empty projections so its pages load.
      engine.define('board:proj-registered', {
        ...baseBoard(),
        projectId: 'proj-registered',
        checkpoint: { generation: 0, confirmedAt: '尚未完成首次扫描', complete: false },
        columns: baseBoard().columns.map((c) => ({ ...c, cards: [] })),
      })
      engine.define('workspace:proj-registered', {
        ...baseWorkspace(),
        projectId: 'proj-registered',
        displayPath: 'D:\\saki',
        branch: 'master',
        head: 'e3dde79',
        aheadBehind: { ahead: 0, behind: 0 },
        dirtySummary: { staged: 0, unstaged: 4, untracked: 1 },
        primaryWorkSessionId: null,
        activeOperations: [],
      })
      engine.define('changes:proj-registered', { ...baseChanges(), projectId: 'proj-registered', branch: 'master', staged: [], unstaged: [], untracked: [], inheritedNotice: null })
      engine.define('sessions:proj-registered', { projectId: 'proj-registered', sessions: [], selected: null })
      engine.define('automation:proj-registered', { ...baseAutomation(), projectId: 'proj-registered' })
      engine.define('project-config:proj-registered', baseProjectConfig('proj-registered'))
      engine.define('milestones:proj-registered', [])
    },
  },
  {
    id: 'auto-mode',
    title: '自动模式 · 自动领取与预算证据',
    summary: 'Saki 项目启用 Automation Policy：Ready 工作项无需点击即被领取，卡片与运行页展示 policy、Actor、reservation 与 pause 证据。',
    demonstrates: ['自动领取（无点击）', 'policy / Actor / reservation 证据', '预算维度与已结算用量'],
    startAddress: { kind: 'work', projectId: PROJECT_SAKI },
    install: (engine) => {
      installBase(engine)
      engine.define(`automation:${PROJECT_SAKI}`, {
        ...baseAutomation(),
        enabled: true,
        triggerMode: 'auto',
      })
      engine.define('my-work', {
        ...baseMyWork(),
        items: baseMyWork().items.map((item) =>
          item.workItemId === 'wi-128'
            ? { ...item, offer: null, currentActor: 'Agent 正在处理', group: 'in-progress' as const, offerUnavailableReason: '自动模式：Automation Policy 已自动领取' }
            : item,
        ),
      })
    },
  },
  {
    id: 'board-conflict',
    title: '看板 · 远端指纹冲突',
    summary: '拖动卡片时远端状态已被其他人改变：乐观更新先生效，mutation 返回冲突后恢复已确认状态并显示可见 conflict。',
    demonstrates: ['乐观 overlay', 'expected-fingerprint mutation', '冲突恢复与文字语义'],
    startAddress: { kind: 'work', projectId: PROJECT_SAKI },
    install: (engine) => {
      installBase(engine)
      let conflictsLeft = 1
      engine.onIntent('move-work-item', (intent, api) => {
        if (intent.kind !== 'move-work-item') return { type: 'failed' as const, message: 'intent 类型不匹配' }
        if (conflictsLeft > 0) {
          conflictsLeft -= 1
          return { type: 'conflict' as const, message: '远端状态已变化：产品同学刚把这张卡片移回了 Backlog，已恢复为最新确认状态' }
        }
        return applyMoveWorkItem(api, intent.workItemId, intent.targetStatus, intent.expectedRemoteFingerprint)
      })
    },
  },
  {
    id: 'binding-repair',
    title: '恢复 · Resource Binding 修复',
    summary: '官网改版项目的目录被移动：Resource Binding 进入 repair-required，项目保持只读，历史可读，只提供带归因修复操作。',
    demonstrates: ['Repair required 状态', '只读项目与历史可读', '带归因修复 operation'],
    startAddress: { kind: 'projects' },
    install: (engine) => {
      installBase(engine)
      engine.define('projects', baseProjects().map((p) => (p.projectId === PROJECT_WEB ? { ...p, bindingHealth: 'repair-required' as const } : p)))
      engine.define(`workspace:${PROJECT_WEB}`, {
        ...baseWorkspace(),
        projectId: PROJECT_WEB,
        displayPath: 'D:\\sites\\website（已移动）',
        bindingHealth: 'repair-required',
        blockedRecovery: ['目录不存在或不再匹配 worktree 观察'],
      })
    },
  },
  {
    id: 'mapping-repair',
    title: '恢复 · GitHub mapping 修复',
    summary: 'GitHub Project 的 Status 字段被重建：看板进入只读修复模式并指出缺失字段，修复带归因，写入在完整扫描前不可用。',
    demonstrates: ['mapping health', '只读修复模式', '修复后完整扫描恢复读写'],
    startAddress: { kind: 'work', projectId: PROJECT_SAKI },
    install: (engine) => {
      installBase(engine)
      engine.define(`board:${PROJECT_SAKI}`, {
        ...baseBoard(),
        mappingHealth: 'repair-required',
        mappingRepairDetail: 'GitHub Project 的 Status 字段缺失或被重建：已确认扫描无法映射固定状态',
      })
      engine.define('projects', baseProjects().map((p) => (p.projectId === PROJECT_SAKI ? { ...p, mappingHealth: 'repair-required' as const } : p)))
    },
  },
  {
    id: 'budget-paused',
    title: '自动模式 · 预算耗尽暂停',
    summary: '模型请求预算耗尽：自动化暂停并创建 Intervention Request；绝不意味着 Done，恢复需要一次性预算例外。',
    demonstrates: ['预算维度耗尽', 'pause 证据与 Intervention Request', '一次性例外恢复（高风险确认）'],
    startAddress: { kind: 'my-work' },
    install: (engine) => {
      installBase(engine)
      engine.define(`automation:${PROJECT_SAKI}`, {
        ...baseAutomation(),
        enabled: true,
        triggerMode: 'auto' as const,
        paused: true,
        pauseReason: '模型请求 / 天 已达到 200 上限；提供方额度观察未知，policy 选择 pause-on-unknown',
        limits: baseAutomation().limits.map((l) => (l.dimension === '模型请求 / 天' ? { ...l, used: '200' } : l)),
        unknownObservations: ['提供方全局 quota 未知'],
      })
      engine.define('projects', baseProjects().map((p) => (p.projectId === PROJECT_SAKI ? { ...p, automationPaused: true, automationPauseReason: '预算耗尽' } : p)))
      engine.define('attention', [
        {
          attentionId: 'att-budget',
          projectId: PROJECT_SAKI,
          projectName: 'Saki',
          severity: 'urgent' as const,
          kind: 'intervention' as const,
          title: '自动化已暂停：模型请求预算耗尽',
          detail: '授权一次性预算例外，或等待额度周期重置',
          age: '12 分钟前',
          interventionId: 'iv-budget',
          interventionKind: 'approval' as const,
          question: '模型请求 / 天 已达上限。要授权一次性预算例外（24 小时）还是保持暂停？',
          returnAddress: { kind: 'project-settings', projectId: PROJECT_SAKI },
        },
        ...baseAttention(),
      ])
    },
  },
  {
    id: 'offline',
    title: '离线 · GitHub 不可达',
    summary: 'GitHub 暂时不可达：看板与项目显示缓存与离线状态，本地 Git、会话与终端仍可用，绝不伪造远端写入成功。',
    demonstrates: ['Stale / offline 文字语义', '本地功能保留', '失败来源说明'],
    startAddress: { kind: 'work', projectId: PROJECT_SAKI },
    install: (engine) => {
      installBase(engine)
      engine.define(`board:${PROJECT_SAKI}`, { ...baseBoard(), freshness: 'offline', checkpoint: { generation: 14, confirmedAt: '08:12', complete: true } })
      engine.define('projects', baseProjects().map((p) => ({ ...p, githubFreshness: 'offline' as const, githubConfirmedAt: '08:12' })))
    },
  },
  {
    id: 'reconnect-recovery',
    title: '重连恢复 · 结果不明与对账',
    summary: '重启后：一条 Dispatch 结果不明进入 reconciliation-required，开放 Intervention 仍可回答，会话可恢复但终端进程不可恢复。',
    demonstrates: ['Reconciliation required', '重连后可回答 Intervention', '恢复入口与不可恢复终端的区分'],
    startAddress: { kind: 'my-work' },
    install: (engine) => {
      installBase(engine)
      engine.define('attention', [
        {
          attentionId: 'att-recon',
          projectId: PROJECT_SAKI,
          projectName: 'Saki',
          severity: 'urgent' as const,
          kind: 'dispatch-unknown' as const,
          title: '一条 Dispatch 结果不明，需要对账',
          detail: '推送 operation 的 acknowledgement 丢失；inspection 无法证明成功或失败',
          age: '3 分钟前',
          interventionId: null,
          interventionKind: null,
          question: null,
          returnAddress: { kind: 'sessions', projectId: PROJECT_SAKI, workSessionId: 'ws-2298' },
        },
        ...baseAttention(),
      ])
    },
  },
  {
    id: 'empty-states',
    title: '空状态 · 新项目首日',
    summary: '刚登记的项目没有任何工作项、会话或注意事项：每个空视图解释是不存在、被筛选排除，还是首次扫描尚未完成。',
    demonstrates: ['Empty 三种语义（不存在 / 筛选 / 未扫描）', '从零创建第一个工作项'],
    startAddress: { kind: 'work', projectId: PROJECT_WEB },
    install: (engine) => {
      installBase(engine)
      engine.define(`board:${PROJECT_WEB}`, {
        ...baseBoard(),
        projectId: PROJECT_WEB,
        checkpoint: { generation: 0, confirmedAt: '尚未完成首次扫描', complete: false },
        columns: baseBoard().columns.map((c) => ({ ...c, cards: [] })),
        freshness: 'fresh',
      })
      engine.define('my-work', { principalName: '你', items: [] })
      engine.define('attention', [])
    },
  },
  {
    id: 'create-item-outcomes',
    title: '新建工作项 · 部分失败与结果不明',
    summary: 'CreateWorkItem 的非快乐路径：第一次提交只完成一半（Issue 已创建但未加入 Project，给出修复动作）；第二次提交 acknowledgement 丢失，对账检查后安全重试，绝不盲目重复创建。',
    demonstrates: ['CreateWorkItem partial GitHub result', 'acknowledgement lost → reconciliation', '修复 / 对账后安全重试', '未收敛不关窗'],
    startAddress: { kind: 'my-work' },
    install: (engine) => {
      installBase(engine)
      // Outcome scripting is driven by the submitted title so the checklist
      // stays readable: “见证” → partial first; “合规” → ack lost first; any
      // repeat of an already-created title confirms idempotently.
      const partialDone = new Set<string>()
      const ackLostDone = new Set<string>()
      const createdTitles = new Set<string>()
      engine.onIntent('create-work-item', (intent, api) => {
        if (intent.kind !== 'create-work-item') return { type: 'failed' as const, message: 'intent 类型不匹配' }
        const config = api.read<{ revision: number }>(`project-config:${intent.projectId}`)
        if (!config) return { type: 'failed' as const, message: '找不到目标 Project 的配置 Projection' }
        if (config.revision !== intent.expectedProjectRevision) {
          return { type: 'conflict' as const, message: 'Project 配置已变化；已刷新表单，请复核后重新提交' }
        }
        // Idempotency: re-submitting an already-created title confirms instead
        // of duplicating the Issue.
        if (createdTitles.has(intent.title)) {
          return { type: 'confirmed' as const, message: '对账完成：该 Issue 已创建，未重复创建' }
        }
        if (intent.title.includes('见证') && !partialDone.has(intent.title)) {
          // Partial: the Issue exists on GitHub but joining the Project failed.
          partialDone.add(intent.title)
          createdTitles.add(intent.title)
          const issueNumber = 141
          api.update(`board:${intent.projectId}`, (b: { columns: { status: string; cards: unknown[] }[] }) => ({
            ...b,
            columns: b.columns.map((c) =>
              c.status === 'inbox'
                ? { ...c, cards: [...c.cards, { workItemId: `wi-${issueNumber}`, issueNumber, title: intent.title, status: 'inbox', labels: [], assignee: '你', updatedAt: api.now(), blocked: false, notInProject: true, milestone: null, runSummary: null, prRef: null, ciState: null, remoteFingerprint: `fp-wi-${issueNumber}-1` }] }
                : c,
            ),
          }))
          return {
            type: 'reconciliation-required' as const,
            message: '部分完成：Issue #141 已创建，但加入 Project 失败。已完成事实已展示；使用修复动作完成加入，不会重复创建 Issue',
          }
        }
        if (intent.title.includes('合规') && !ackLostDone.has(intent.title)) {
          // Acknowledgement lost: outcome unknown until the operator reconciles.
          ackLostDone.add(intent.title)
          return {
            type: 'reconciliation-required' as const,
            message: 'acknowledgement 丢失：无法证明 Issue 是否已创建。请先对账检查，再安全重试',
          }
        }
        createdTitles.add(intent.title)
        const issueNumber = 142 + createdTitles.size
        api.update(`board:${intent.projectId}`, (b: { columns: { status: string; cards: unknown[] }[] }) => ({
          ...b,
          columns: b.columns.map((c) =>
            c.status === 'inbox'
              ? { ...c, cards: [...c.cards, { workItemId: `wi-${issueNumber}`, issueNumber, title: intent.title, status: 'inbox', labels: [], assignee: '你', updatedAt: api.now(), blocked: false, notInProject: false, milestone: null, runSummary: null, prRef: null, ciState: null, remoteFingerprint: `fp-wi-${issueNumber}-1` }] }
              : c,
          ),
        }))
        return { type: 'confirmed' as const, message: `已创建 Issue #${issueNumber} 并加入 Project 的 Inbox` }
      })
    },
  },
  {
    id: 'model-supply',
    title: 'Model Supply · 账号、路由与生成任务',
    summary: 'Settings 的 Model Supply 分节：多个 Codex 与 Kimi Provider Account Profile、认证与用量状态、Model Route、Context Policy 与 Generation Job 队列。',
    demonstrates: ['多账号 Profile 与保护等级', 'Usage Snapshot 三态（可用 / 暂时不可用 / 不支持）', 'Route 与 Context Policy', 'Generation Job 队列、取消与重试'],
    startAddress: { kind: 'settings', section: 'model-supply' },
    install: (engine) => installBase(engine),
  },
]

export function getScenario(id: string | null): ScenarioDef {
  return scenarios.find((s) => s.id === id) ?? scenarios[0]
}
