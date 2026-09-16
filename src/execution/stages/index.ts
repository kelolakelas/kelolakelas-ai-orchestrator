import { DeliveryObservationStage } from '../../delivery/observation-stage.js';
import type { DeliveryDependencies } from '../../delivery/delivery-support.js';
import { PullRequestStage } from '../../delivery/pull-request-stage.js';
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
 * fix, and review. Delivery handlers (push, pull requests, and CI, review, and merge observation) are registered only
 * when `delivery` is given; without them a reviewed branch stays local.
 */
export function createExecutionHandlers(
  deps: ExecutionDependencies,
  preparation: { remoteRetryMs: number },
  delivery?: Pick<DeliveryDependencies, 'delivery' | 'github' | 'linear'>,
): StageHandlers {
  const handlers: StageHandlers = {
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
    REVIEWING: new ReviewStage(deps, { deliver: delivery !== undefined }),
  };
  if (delivery !== undefined) {
    const deliveryDeps: DeliveryDependencies = { ...deps, ...delivery };
    const observation = new DeliveryObservationStage(deliveryDeps);
    handlers.PR_CREATED = new PullRequestStage(deliveryDeps);
    handlers.WAITING_CI = observation;
    handlers.READY_FOR_HUMAN_REVIEW = observation;
  }
  return handlers;
}
