/** Current Saki control-plane domain assembly. @module @breakfastdapaidang/saki-control-plane/src/domain-spec */

import { runModelSwitchIntentRecordSchema, currentAgentRunRecordSchema as agentRunRecordSchema } from './run-model-switch-spec.ts'
import type { RunModelSwitchIntentRecord, CurrentAgentRunRecord as AgentRunRecord } from './run-model-switch-spec.ts'
import { agentProfileModelRouteRecordSchema, projectModelRouteIntentRecordSchema } from './model-routing-spec.ts'
import type { AgentProfileModelRouteRecord, ProjectModelRouteIntentRecord } from './model-routing-spec.ts'
import type { SakiAgentProfileId } from './types.ts'
import type { ModelAccountProfileId } from '@breakfastdapaidang/saki-model-account'
import { modelAccountRecordSchema, modelAccountIntentRecordSchema, type ModelAccountRecord, type ModelAccountIntentRecord } from './model-supply-spec.ts'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import {
  branchDeliveryIntentRecordSchema,
  branchDeliveryRecordSchema,
  type BranchDeliveryIntentRecord,
  type BranchDeliveryRecord,
  type SakiBranchDeliveryId,
} from './branch-delivery.ts'
import {
  milestoneDeliveryIntentRecordSchema,
  milestoneDeliveryRecordSchema,
  type MilestoneDeliveryIntentRecord,
  type MilestoneDeliveryRecord,
  type SakiMilestoneDeliveryId,
} from './milestone-delivery.ts'
import {
  CONTROL_STATE_KEY,
  DEVELOPMENT_PROJECT_REGISTRY_KEY,
  agentOperationIntentRecordSchema,
  bindingWriteAdmissionRecordSchema,
  controlStateRecordSchema,
  developmentProjectRegistryRecordSchema,
  executionDispatchRecordSchema,
  gitOperationIntentRecordSchema,
  githubProjectSyncRecordSchema,
  githubSynchronizationConfigurationIntentRecordSchema,
  githubWorkItemIntentRecordSchema,
  githubWorkItemRecoveryRecordSchema,
  grantRecordSchema,
  hostRecordSchema,
  installationAccessRecordSchema,
  installationRecordSchema,
  interventionRequestRecordSchema,
  principalRecordSchema,
  registrationIntentRecordSchema,
  workAssignmentRecordSchema,
  workSessionRecordSchema,
  type AgentOperationIntentRecord,
  type BindingWriteAdmissionRecord,
  type ControlStateRecord,
  type DevelopmentProjectRegistryRecord,
  type ExecutionDispatchRecord,
  type GitHubProjectSyncRecord,
  type GitHubSynchronizationConfigurationIntentRecord,
  type GitHubWorkItemIntentRecord,
  type GitHubWorkItemRecoveryRecord,
  type GitOperationIntentRecord,
  type GrantRecord,
  type HostRecord,
  type InstallationAccessRecord,
  type InstallationRecord,
  type InterventionRequestRecord,
  type PrincipalRecord,
  type RegistrationIntentRecord,
  type WorkAssignmentRecord,
  type WorkSessionRecord,
} from './spec.ts'
import type {
  SakiAgentRunId,
  SakiControlIntentId,
  SakiDevelopmentProjectId,
  SakiExecutionDispatchId,
  SakiGrantId,
  SakiHostId,
  SakiInstallationAccessId,
  SakiInstallationId,
  SakiInterventionRequestId,
  SakiPrincipalId,
  SakiResourceBindingId,
  SakiWorkAssignmentId,
  SakiWorkItemRecoveryId,
  SakiWorkSessionId,
} from './types.ts'

/** Exact current Saki control-plane domain declaration. */
export const sakiControlPlaneDomainSpec = defineDomain({
  name: 'saki_control_plane',
  version: 12,
  tables: {
    run_model_switch_intents: domainTable<SakiControlIntentId, RunModelSwitchIntentRecord>(runModelSwitchIntentRecordSchema),
    agent_profile_model_routes: domainTable<SakiAgentProfileId, AgentProfileModelRouteRecord>(agentProfileModelRouteRecordSchema),
    project_model_route_intents: domainTable<SakiControlIntentId, ProjectModelRouteIntentRecord>(projectModelRouteIntentRecordSchema),
    model_accounts: domainTable<ModelAccountProfileId, ModelAccountRecord>(modelAccountRecordSchema),
    model_account_intents: domainTable<SakiControlIntentId, ModelAccountIntentRecord>(modelAccountIntentRecordSchema),
    control_state: domainTable<typeof CONTROL_STATE_KEY, ControlStateRecord>(controlStateRecordSchema),
    installations: domainTable<SakiInstallationId, InstallationRecord>(installationRecordSchema),
    hosts: domainTable<SakiHostId, HostRecord>(hostRecordSchema),
    principals: domainTable<SakiPrincipalId, PrincipalRecord>(principalRecordSchema),
    grants: domainTable<SakiGrantId, GrantRecord>(grantRecordSchema),
    installation_access: domainTable<SakiInstallationAccessId, InstallationAccessRecord>(installationAccessRecordSchema),
    development_project_registry: domainTable<
      typeof DEVELOPMENT_PROJECT_REGISTRY_KEY,
      DevelopmentProjectRegistryRecord
    >(developmentProjectRegistryRecordSchema),
    registration_intents: domainTable<SakiControlIntentId, RegistrationIntentRecord>(registrationIntentRecordSchema),
    github_project_sync: domainTable<SakiDevelopmentProjectId, GitHubProjectSyncRecord>(githubProjectSyncRecordSchema),
    github_sync_configuration_intents: domainTable<
      SakiControlIntentId,
      GitHubSynchronizationConfigurationIntentRecord
    >(githubSynchronizationConfigurationIntentRecordSchema),
    git_operation_intents: domainTable<SakiControlIntentId, GitOperationIntentRecord>(gitOperationIntentRecordSchema),
    binding_write_admissions: domainTable<
      SakiResourceBindingId,
      BindingWriteAdmissionRecord
    >(bindingWriteAdmissionRecordSchema),
    github_work_item_intents: domainTable<SakiControlIntentId, GitHubWorkItemIntentRecord>(
      githubWorkItemIntentRecordSchema,
    ),
    github_work_item_recovery: domainTable<SakiWorkItemRecoveryId, GitHubWorkItemRecoveryRecord>(
      githubWorkItemRecoveryRecordSchema,
    ),
    agent_operation_intents: domainTable<SakiControlIntentId, AgentOperationIntentRecord>(
      agentOperationIntentRecordSchema,
    ),
    work_assignments: domainTable<SakiWorkAssignmentId, WorkAssignmentRecord>(workAssignmentRecordSchema),
    work_sessions: domainTable<SakiWorkSessionId, WorkSessionRecord>(workSessionRecordSchema),
    agent_runs: domainTable<SakiAgentRunId, AgentRunRecord>(agentRunRecordSchema),
    execution_dispatches: domainTable<SakiExecutionDispatchId, ExecutionDispatchRecord>(
      executionDispatchRecordSchema,
    ),
    intervention_requests: domainTable<SakiInterventionRequestId, InterventionRequestRecord>(
      interventionRequestRecordSchema,
    ),
    branch_deliveries: domainTable<SakiBranchDeliveryId, BranchDeliveryRecord>(branchDeliveryRecordSchema),
    branch_delivery_intents: domainTable<SakiControlIntentId, BranchDeliveryIntentRecord>(
      branchDeliveryIntentRecordSchema,
    ),
    milestone_deliveries: domainTable<SakiMilestoneDeliveryId, MilestoneDeliveryRecord>(
      milestoneDeliveryRecordSchema,
    ),
    milestone_delivery_intents: domainTable<SakiControlIntentId, MilestoneDeliveryIntentRecord>(
      milestoneDeliveryIntentRecordSchema,
    ),
  },
})
