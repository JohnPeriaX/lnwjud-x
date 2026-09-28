import { engineeringGoalMetadata, type EngineeringWorkflowPlan } from '@lnwjud/application';
import { appError, err, ok, type EngineeringGoalMetadata } from '@lnwjud/domain';
import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import { engineeringGetStatusSchema, engineeringPrepareTaskSchema, engineeringStartTaskSchema } from './schemas.js';

export function engineeringTools(context: McpToolContext): McpToolDefinition[] {
  return [
    defineTool({
      name: 'engineering_prepare_task',
      description: 'Read-only Engineering Harness preparation. Assess the registered workspace, applicable project instructions, effective Engineering policy, and policy digest without creating a goal, starting a process, scheduling work, or writing repository files.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: engineeringPrepareTaskSchema,
      handler: async (input) => {
        if (context.services.engineeringPreparation === undefined) return missingService();
        const prepared = await context.services.engineeringPreparation.prepare(input.workspaceId, input.objective, input.scopedPath);
        if (!prepared.ok) return prepared;
        return ok({
          ...prepared.value,
          engineeringTask: {
            objective: prepared.value.objective,
            ...(input.scopedPath === undefined ? {} : { scopedPath: input.scopedPath }),
            policyDigest: prepared.value.policy.policyDigest,
            primaryTaskKind: prepared.value.workflow.primaryTaskKind,
            riskTier: prepared.value.workflow.riskTier,
            deliveryScope: prepared.value.workflow.deliveryScope,
            ...(context.actor.sessionId === undefined ? {} : { sessionId: context.actor.sessionId }),
          },
        });
      },
    }),
    defineTool({
      name: 'engineering_start_task',
      description: 'Start or resume a substantive Engineering Harness task by reusing the existing durable Goal authority. This operation does not create or authorize a scheduled continuation.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: engineeringStartTaskSchema,
      handler: async (input) => {
        if (context.services.goals === undefined || context.services.engineeringPreparation === undefined) return missingService();
        const existing = await context.services.goals.getGoal(context.actor, { workspaceId: input.workspaceId, goalKey: input.goalKey });
        const persistedEngineering = existing.ok ? existing.value.engineering : undefined;
        if (existing.ok && persistedEngineering === undefined) return err(appError('INVALID_INPUT', 'Existing goal is not an Engineering Harness task'));
        const effectiveScopedPath = existing.ok ? input.scopedPath ?? persistedEngineering?.scopedPath : input.scopedPath;
        const prepared = await context.services.engineeringPreparation.prepare(input.workspaceId, input.objective, effectiveScopedPath);
        if (!prepared.ok) return prepared;
        const continuingThroughProjectOptOut = existing.ok && !prepared.value.policy.enabled && prepared.value.policy.source === 'project';
        if (!prepared.value.policy.enabled && !continuingThroughProjectOptOut) {
          return err(appError('INVALID_INPUT', `Engineering Harness is inactive: ${prepared.value.policy.reasons.join(' ')}`));
        }
        if (continuingThroughProjectOptOut && input.scopedPath !== undefined && input.scopedPath !== persistedEngineering?.scopedPath) {
          return err(appError('INVALID_INPUT', 'Project Engineering Harness is disabled for new scope preparation; resume the active task with its existing scopedPath.'));
        }
        if (existing.ok) {
          const existingEngineering = persistedEngineering;
          if (existingEngineering === undefined) return err(appError('INVALID_INPUT', 'Existing goal is not an Engineering Harness task'));
          const resumed = await context.services.goals.runGoal(context.actor, {
            workspaceId: input.workspaceId,
            goalKey: input.goalKey,
            objective: input.objective,
            ...(input.leaseSeconds === undefined ? {} : { leaseSeconds: input.leaseSeconds }),
          });
          if (!resumed.ok) return resumed;
          if (!resumed.value.acquired || resumed.value.leaseToken === undefined) return ok(resumed.value);
          let current = resumed.value;
          if (!continuingThroughProjectOptOut && (existingEngineering.policyDigest !== prepared.value.policy.policyDigest || existingEngineering.scopedPath !== effectiveScopedPath)) {
            const reconciled = reconcileEngineeringMetadata(existingEngineering, prepared.value.policy.policyDigest, prepared.value.workflow, resumed.value.userIntentRevision, effectiveScopedPath);
            const checkpointed = await context.services.goals.checkpointGoal(context.actor, {
              goalId: resumed.value.goalId,
              leaseToken: resumed.value.leaseToken,
              expectedRevision: resumed.value.revision,
              expectedUserIntentRevision: resumed.value.userIntentRevision,
              currentPhase: resumed.value.currentPhase,
              summary: 'Reconciled changed Engineering Harness policy before resume.',
              stepUpdates: [],
              nextAction: resumed.value.nextAction,
              blockers: resumed.value.blockers,
              evidence: [{ kind: 'note', value: 'Engineering policy digest changed; dependent required gates were invalidated for revalidation.' }],
              trackedTasks: resumed.value.trackedTasks,
              engineering: reconciled,
            });
            if (!checkpointed.ok) return checkpointed;
            current = { ...resumed.value, ...checkpointed.value };
          }
          return ok({
            ...current,
            acquired: true,
            leaseToken: resumed.value.leaseToken,
            engineeringTask: {
              goalId: current.goalId,
              policyDigest: current.engineering?.policyDigest ?? prepared.value.policy.policyDigest,
              goalRevision: current.revision,
              userIntentRevision: current.userIntentRevision,
              ...(effectiveScopedPath === undefined ? {} : { scopedPath: effectiveScopedPath }),
              ...(context.actor.sessionId === undefined ? {} : { sessionId: context.actor.sessionId }),
            },
          });
        }
        if (existing.error.code !== 'INVALID_INPUT') return existing;
        const started = await context.services.goals.runGoal(context.actor, {
          workspaceId: input.workspaceId,
          goalKey: input.goalKey,
          objective: input.objective,
          plan: { steps: prepared.value.workflow.workflow.map((step) => ({ id: step.id, title: step.title })) },
          engineering: engineeringGoalMetadata(prepared.value.policy.policyDigest, prepared.value.workflow, effectiveScopedPath),
          ...(input.leaseSeconds === undefined ? {} : { leaseSeconds: input.leaseSeconds }),
        });
        if (!started.ok) return started;
        if (!started.value.acquired || started.value.leaseToken === undefined) return ok(started.value);
        return ok({
          ...started.value,
          engineeringTask: {
            goalId: started.value.goalId,
            policyDigest: prepared.value.policy.policyDigest,
            goalRevision: started.value.revision,
            userIntentRevision: started.value.userIntentRevision,
            ...(effectiveScopedPath === undefined ? {} : { scopedPath: effectiveScopedPath }),
            ...(context.actor.sessionId === undefined ? {} : { sessionId: context.actor.sessionId }),
          },
        });
      },
    }),
    defineTool({
      name: 'engineering_get_status',
      description: 'Read the current Engineering Harness task projection, effective policy, required gates, blockers, and truthful delivery boundary without changing goal state.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: engineeringGetStatusSchema,
      handler: async (input) => {
        if (context.services.goals === undefined || context.services.engineeringPreparation === undefined) return missingService();
        const goal = await context.services.goals.getGoal(context.actor, { goalId: input.goalId });
        if (!goal.ok) return goal;
        if (goal.value.engineering === undefined) return err(appError('INVALID_INPUT', 'Goal is not an Engineering Harness task'));
        const prepared = await context.services.engineeringPreparation.prepare(goal.value.workspaceId, goal.value.objective, goal.value.engineering.scopedPath);
        if (!prepared.ok) return prepared;
        const unresolvedGateIds = goal.value.engineering.gates
          .filter((gate) => gate.applicability === 'required' && gate.status !== 'passed' && gate.status !== 'not_applicable')
          .map((gate) => gate.id);
        const deliveryBoundary = goal.value.status !== 'active'
          ? goal.value.status
          : goal.value.blockers.length > 0
            ? 'blocked'
            : unresolvedGateIds.length > 0
              ? 'checks_pending'
              : goal.value.engineering.deliveryScope === 'local'
                ? 'ready_locally'
                : `${goal.value.engineering.deliveryScope}_ready`;
        return ok({
          goalId: goal.value.goalId,
          workspaceId: goal.value.workspaceId,
          status: goal.value.status,
          currentPhase: goal.value.currentPhase,
          nextAction: goal.value.nextAction,
          blockers: goal.value.blockers,
          primaryTaskKind: goal.value.engineering.primaryTaskKind,
          riskTier: goal.value.engineering.riskTier,
          deliveryScope: goal.value.engineering.deliveryScope,
          gates: goal.value.engineering.gates,
          unresolvedGateIds,
          deliveryBoundary,
          effectivePolicy: prepared.value.policy,
          policyChanged: prepared.value.policy.policyDigest !== goal.value.engineering.policyDigest,
          engineeringTask: {
            goalId: goal.value.goalId,
            policyDigest: goal.value.engineering.policyDigest,
            goalRevision: goal.value.revision,
            userIntentRevision: goal.value.userIntentRevision,
            ...(goal.value.engineering.scopedPath === undefined ? {} : { scopedPath: goal.value.engineering.scopedPath }),
            ...(context.actor.sessionId === undefined ? {} : { sessionId: context.actor.sessionId }),
          },
        });
      },
    }),
  ];
}

function reconcileEngineeringMetadata(
  current: EngineeringGoalMetadata,
  policyDigest: string,
  workflow: EngineeringWorkflowPlan,
  userIntentRevision: number,
  scopedPath?: string,
): EngineeringGoalMetadata {
  const next = engineeringGoalMetadata(policyDigest, workflow, scopedPath);
  const previousGateIds = new Set(current.gates.map((gate) => gate.id));
  return {
    ...next,
    gates: next.gates.map((gate) => gate.applicability === 'not_applicable'
      ? { ...gate, basedOnUserIntentRevision: userIntentRevision }
      : {
          ...gate,
          status: previousGateIds.has(gate.id) ? 'stale' : 'pending',
          reason: previousGateIds.has(gate.id) ? `Engineering policy changed; revalidate. ${gate.reason}` : gate.reason,
          basedOnUserIntentRevision: userIntentRevision,
        }),
    ...(current.reviewFindings === undefined ? {} : { reviewFindings: current.reviewFindings }),
  };
}
