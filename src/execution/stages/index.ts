import type { StageHandlers } from '../../orchestrator/stage-handler.js';
import { WorkspacePreparationStage } from '../../workspaces/preparation-stage.js';
import { AnalysisStage } from './analysis-stage.js';
import { FixingStage } from './fixing-stage.js';
import { ImplementationStage } from './implementation-stage.js';
import { ReadyStage } from './ready-stage.js';
import { ReviewStage } from './review-stage.js';
import type { ExecutionDependencies } from './stage-support.js';
import { TestingStage } from './testing-stage.js';

/**
 * Stage handlers for supervised agent execution: prepare workspaces and analyze, set up, implement, run quality gates,
 * fix, and review. There is deliberately no handler for delivery states, so nothing is pushed.
 */
export function createExecutionHandlers(deps: ExecutionDependencies, preparation: { remoteRetryMs: number }): StageHandlers {
  return {
    ANALYZING: new WorkspacePreparationStage(deps.workspaces, deps.tasks, {
      workerId: deps.workerId,
      remoteRetryMs: preparation.remoteRetryMs,
      clock: deps.clock,
      next: new AnalysisStage(deps),
    }),
    READY: new ReadyStage(deps),
    IMPLEMENTING: new ImplementationStage(deps),
    TESTING: new TestingStage(deps),
    FIXING: new FixingStage(deps),
    REVIEWING: new ReviewStage(deps),
  };
}
