/**
 * Contract types mirrored from docs/saki/architecture/0.1.0-frontend-contract.zh.md.
 * These express the prototype's understanding of Projections, Intents, Action
 * Offers, states, and view addresses. They are NOT final wire types.
 */

// ---------------------------------------------------------------------------
// View addresses: every navigable state has a typed address built from stable
// ids, never from paths or display names.
// ---------------------------------------------------------------------------

export type SakiViewAddress =
  | { kind: 'conversation'; sessionId: string | null }
  | { kind: 'new-session' }
  | { kind: 'my-work' }
  | { kind: 'projects' }
  | { kind: 'work'; projectId: string; board?: { milestoneId?: string }; workItemId?: string }
  | { kind: 'milestones'; projectId: string; milestoneId?: string }
  | { kind: 'changes'; projectId: string; file?: string }
  | { kind: 'sessions'; projectId: string; workSessionId?: string; agentRunId?: string }
  | { kind: 'trace'; projectId: string; workItemId?: string }
  | { kind: 'project-settings'; projectId: string }
  | { kind: 'settings'; section: string }
  | { kind: 'bootstrap' }

/** The internal destinations of the 「项目」 page; one visible at a time. */
export type ProjectSection = 'work' | 'milestones' | 'changes' | 'sessions' | 'trace' | 'project-settings'

// ---------------------------------------------------------------------------
// Shared domain vocabulary (see docs/contexts/*/CONTEXT.zh.md).
// ---------------------------------------------------------------------------

export type WorkItemStatus = 'inbox' | 'backlog' | 'ready' | 'in-progress' | 'in-review' | 'done' | 'canceled'

export type AgentRunState = 'starting' | 'running' | 'waiting-for-user' | 'succeeded' | 'failed' | 'canceled'

export type BindingHealth = 'active' | 'missing' | 'repair-required' | 'needs-rebind' | 'retired'

export type MappingHealth = 'ok' | 'repair-required'

/** 白话展示分组：My Work projection fact, never derived from WorkItemStatus. */
export type PresentationGroup = 'not-started' | 'in-progress' | 'waiting-on-you' | 'recently-finished'

// ---------------------------------------------------------------------------
// Action Offer: a projection fact with one recommended action and a
// plain-language reason. It is not a Grant; submit re-evaluates eligibility.
// ---------------------------------------------------------------------------

export interface ActionOffer {
  /** Machine-readable reason code from the control plane. */
  reasonCode: string
  /** Plain-language reason shown next to the action. */
  reason: string
  /** The recommended next step; at most one per My Work item. */
  intent: SakiIntent
  label: string
}

// ---------------------------------------------------------------------------
// Intents: every mutating gesture submits a typed Control Intent carrying the
// expected Projection revision. The server re-checks Principal, Grant and
// eligibility before accepting.
// ---------------------------------------------------------------------------

export type InterventionResponse =
  | { kind: 'text'; text: string }
  | { kind: 'decision'; decision: 'approve' | 'reject' }
  | { kind: 'action'; action: string }

export type SakiIntent =
  | { kind: 'claim-work-item'; workItemId: string }
  | { kind: 'move-work-item'; workItemId: string; targetStatus: WorkItemStatus; expectedRemoteFingerprint: string }
  | { kind: 'answer-intervention'; interventionId: string; response: InterventionResponse }
  | { kind: 'accept-deliverable'; workItemId: string }
  | { kind: 'stage-files'; projectId: string; paths: string[] }
  | { kind: 'unstage-files'; projectId: string; paths: string[] }
  | { kind: 'commit'; projectId: string; message: string; expectedIndexTree: string }
  | { kind: 'push'; projectId: string; expectedCommit: string; targetRef: string }
  | { kind: 'create-pr'; projectId: string; workItemId: string; title: string; body: string }
  | { kind: 'register-project'; displayName: string; directory: string }
  | { kind: 'repair-binding'; projectId: string; directory: string }
  | { kind: 'repair-mapping'; projectId: string }
  | {
      kind: 'create-work-item'
      projectId: string
      title: string
      intendedOutcome: string
      acceptanceCriteria: string[]
      expectedProjectRevision: number
      expectedMappingRevision: number
    }
  | { kind: 'complete-bootstrap'; displayName: string }
  | { kind: 'resume-automation'; projectId: string }
  | { kind: 'budget-exception'; projectId: string; note: string }
  | { kind: 'cancel-generation-job'; jobId: string }
  | { kind: 'retry-generation-job'; jobId: string }
  | { kind: 'set-default-agent-profile'; projectId: string; profileId: string }
  | { kind: 'update-automation-policy'; projectId: string; field: string; value: string | boolean | number }
  | { kind: 'update-sync-config'; projectId: string; pollingSeconds: number }

export type IntentOutcome =
  | { type: 'confirmed'; message: string }
  | { type: 'conflict'; message: string }
  | { type: 'failed'; message: string }
  | { type: 'reconciliation-required'; message: string }

export interface IntentReceipt {
  receiptId: string
  intent: SakiIntent
  submittedAt: string
  outcome: IntentOutcome | null
}

// ---------------------------------------------------------------------------
// Projection snapshots: complete read models with a revision. The client never
// joins backend records in the browser.
// ---------------------------------------------------------------------------

export interface ProjectionEnvelope<T> {
  /** Monotonic per-key revision; intents carry it as the expected revision. */
  revision: number
  /** When the control plane last confirmed these facts. */
  confirmedAt: string
  data: T
}

export interface MyWorkItem {
  workItemId: string
  projectId: string
  projectName: string
  issueNumber: number
  title: string
  subtitle: string
  group: PresentationGroup
  status: WorkItemStatus
  currentActor: string
  updatedAt: string
  blocked: boolean
  /** At most one recommended offer; null means "no action available to you". */
  offer: ActionOffer | null
  /** Plain-language unavailability when the expected action is not eligible. */
  offerUnavailableReason: string | null
}

export interface MyWorkProjection {
  principalName: string
  items: MyWorkItem[]
}

export interface ProjectIndexEntry {
  projectId: string
  name: string
  directory: string
  bindingHealth: BindingHealth
  mappingHealth: MappingHealth
  attentionCount: number
  activeRuns: number
  githubFreshness: 'fresh' | 'stale' | 'offline'
  githubConfirmedAt: string
  automationPaused: boolean
  automationPauseReason: string | null
  /** Monotonic revision of the Project's configuration record. */
  configRevision: number
}

export interface WorkspaceProjection {
  projectId: string
  bindingRevision: number
  bindingHealth: BindingHealth
  displayPath: string
  branch: string
  head: string
  aheadBehind: { ahead: number; behind: number }
  dirtySummary: { staged: number; unstaged: number; untracked: number }
  primaryWorkSessionId: string | null
  activeOperations: string[]
  blockedRecovery: string[]
}

export interface BoardCard {
  workItemId: string
  issueNumber: number
  title: string
  status: WorkItemStatus
  labels: { name: string; tone: 'accent' | 'ok' | 'warn' | 'danger' | 'info' | 'purple' }[]
  assignee: string
  updatedAt: string
  blocked: boolean
  notInProject: boolean
  milestone: string | null
  runSummary: string | null
  prRef: string | null
  ciState: 'passing' | 'failing' | 'pending' | null
  /** Confirmed remote fingerprint used by move-work-item preconditions. */
  remoteFingerprint: string
}

export interface BoardColumn {
  status: WorkItemStatus
  cards: BoardCard[]
}

export interface BoardProjection {
  projectId: string
  checkpoint: { generation: number; confirmedAt: string; complete: boolean }
  columns: BoardColumn[]
  mappingHealth: MappingHealth
  mappingRepairDetail: string | null
  freshness: 'fresh' | 'stale' | 'offline'
}

export interface WorkItemDetail {
  workItemId: string
  projectId: string
  issueNumber: number
  title: string
  body: string
  status: WorkItemStatus
  labels: BoardCard['labels']
  assignee: string
  creator: string
  createdAt: string
  updatedAt: string
  blocked: boolean
  acceptance: string[]
  milestone: string | null
  sessionRef: string | null
  agentRun: { runId: string; state: AgentRunState; summary: string; startedAt: string } | null
  prRef: string | null
  ciState: BoardCard['ciState']
  evidence: { kind: string; label: string; ref: string }[]
  interventions: { interventionId: string; kind: 'clarification' | 'approval' | 'repair-link'; question: string; status: 'open' | 'answered' }[]
  activity: { at: string; actor: string; text: string }[]
  offer: ActionOffer | null
  offerUnavailableReason: string | null
}

export interface ChangesFile {
  path: string
  changeKind: 'modified' | 'added' | 'deleted'
  additions: number
  deletions: number
  diffPreview: string[]
}

export interface ChangesProjection {
  projectId: string
  branch: string
  head: string
  staged: ChangesFile[]
  unstaged: ChangesFile[]
  untracked: ChangesFile[]
  inheritedNotice: string | null
  eligibility: { canCommit: boolean; canPush: boolean; reason: string | null }
}

export interface RunTimelineEvent {
  at: string
  kind: 'claimed' | 'session-created' | 'started' | 'waiting' | 'committed' | 'pr-created' | 'ci' | 'finished' | 'failed'
  text: string
}

export interface SessionListEntry {
  workSessionId: string
  workItemId: string | null
  title: string
  state: 'active' | 'waiting' | 'finished'
  updatedAt: string
  runState: AgentRunState | null
}

export interface SessionViewProjection {
  projectId: string
  sessions: SessionListEntry[]
  selected: {
    workSessionId: string
    dshSessionRef: string
    title: string
    workItemId: string | null
    runId: string | null
    runState: AgentRunState | null
    runStartedAt: string | null
    automationNote: string | null
    timeline: RunTimelineEvent[]
    related: { label: string; value: string; state: string }[]
  } | null
}

export interface AttentionEntry {
  attentionId: string
  projectId: string
  projectName: string
  severity: 'info' | 'action-needed' | 'urgent'
  kind: 'intervention' | 'dispatch-unknown' | 'recovery' | 'assignment'
  title: string
  detail: string
  age: string
  interventionId: string | null
  /** Structured response shape the Intervention requires. */
  interventionKind: 'clarification' | 'approval' | 'repair-link' | null
  question: string | null
  returnAddress: SakiViewAddress
}

export interface AutomationProjection {
  projectId: string
  policyRevision: number
  enabled: boolean
  triggerMode: 'manual' | 'auto'
  enabledActions: string[]
  availableActions: { id: string; label: string }[]
  /** Evidence required before automatic delivery / automatic Done. */
  evidenceRules: string[]
  limits: { dimension: string; limit: string; used: string }[]
  reservations: { id: string; scope: string; dimensions: string }[]
  paused: boolean
  pauseReason: string | null
  unknownObservations: string[]
}

/**
 * Editable Project configuration. Every edit Intent is field-scoped and
 * carries the expected configRevision.
 */
export interface ProjectConfigProjection {
  projectId: string
  configRevision: number
  defaultAgentProfileId: string
  availableProfiles: { profileId: string; label: string; route: string }[]
  sync: {
    pollingSeconds: number
    /** saved → revalidating → scanning → checkpointed → activated; saved ≠ activated. */
    state: 'idle' | 'saved' | 'revalidating' | 'scanning' | 'checkpointed' | 'activated'
    lastActivatedAt: string | null
  }
}

export interface MilestoneEntry {
  milestoneId: string
  title: string
  phase: 'planned' | 'in-progress' | 'ready-to-release' | 'released' | 'canceled'
  dueDate: string | null
  counts: Partial<Record<WorkItemStatus, number>>
  blockedCount: number
  release: { tag: string; commit: string } | null
}

// ---------------------------------------------------------------------------
// Model Supply (installation level; lives in the Settings dialog).
// ---------------------------------------------------------------------------

export interface ProviderAccountProfile {
  profileId: string
  provider: 'codex' | 'kimi'
  displayName: string
  authState: 'authorized' | 'expired' | 'needs-reauth' | 'revoked'
  health: 'healthy' | 'degraded' | 'unavailable'
  protectionLevel: 'local-user-trust' | 'unprotected'
  usage: {
    state: 'available' | 'temporarily-unavailable' | 'unsupported'
    windowLabel: string
    remainingLabel: string
    observedAt: string
  }
  capabilities: string[]
  isDefault: boolean
}

export interface ModelRoute {
  routeId: string
  label: string
  provider: string
  model: string
  profileId: string
  contextCapacity: string
  runtimeContextLimit: string
}

export interface ContextPolicy {
  policyId: string
  name: string
  version: string
  trigger: string
  strategy: string
  isDefault: boolean
}

export interface GenerationJob {
  jobId: string
  projectName: string | null
  prompt: string
  route: string
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'
  createdAt: string
  output: string | null
  provenance: string
}

export interface ModelSupplyProjection {
  profiles: ProviderAccountProfile[]
  routes: ModelRoute[]
  contextPolicies: ContextPolicy[]
  generationJobs: GenerationJob[]
  generationConcurrency: { limit: number; running: number; queued: number }
}

// ---------------------------------------------------------------------------
// View state semantics: every data view distinguishes these with text, never
// by color alone.
// ---------------------------------------------------------------------------

export type ViewCondition =
  | { kind: 'confirmed'; confirmedAt: string }
  | { kind: 'refreshing'; confirmedAt: string }
  | { kind: 'optimistic'; receiptId: string; confirmedAt: string }
  | { kind: 'stale'; confirmedAt: string; source: string }
  | { kind: 'offline'; source: string }
  | { kind: 'conflict'; requested: string; confirmed: string }
  | { kind: 'unavailable'; capability: string; reason: string }
  | { kind: 'repair-required'; detail: string }
  | { kind: 'reconciliation-required'; detail: string }
  | { kind: 'intervention-required'; question: string }
  | { kind: 'empty'; reason: 'none-exist' | 'filtered' | 'not-scanned' }
