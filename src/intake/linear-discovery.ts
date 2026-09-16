import type { LinearIssue } from '../providers/linear.js';
import type { TaskRepository } from '../repositories/task.repository.js';
import { ContractChangedError } from '../repositories/task.repository.js';
import { planningBacklogSchema, planningIssueSchema, planningProjectSchema, type PlanningIssue } from './planning-contract.js';

export interface IntakeReport {
  eligible: PlanningIssue[];
  quarantined: Array<{ id: string; identifier: string; reason: string; payload: Record<string, unknown> }>;
  ignored: Array<{ identifier: string; reason: string }>;
}

function extractContract(description: string, heading: string): unknown {
  const expression = new RegExp(`^## ${heading}\\s*\\n` + '```json\\s*\\n([\\s\\S]*?)\\n```', 'm');
  const match = description.match(expression);
  if (!match?.[1]) throw new Error(`Missing ${heading} JSON contract`);
  return JSON.parse(match[1]);
}

export function discoverLinearIssues(issues: LinearIssue[], requiredLabels: readonly string[], excludedLabels: readonly string[]): IntakeReport {
  const eligible: PlanningIssue[] = [];
  const quarantined: IntakeReport['quarantined'] = [];
  const ignored: IntakeReport['ignored'] = [];
  const projects = new Map<string, unknown>();

  for (const issue of issues) {
    if (issue.stateType === 'completed' || issue.stateType === 'canceled') {
      ignored.push({ identifier: issue.identifier, reason: `Linear state is ${issue.stateType}` });
      continue;
    }
    if (!requiredLabels.every((label) => issue.labels.includes(label))) {
      ignored.push({ identifier: issue.identifier, reason: 'Missing required label' });
      continue;
    }
    if (excludedLabels.some((label) => issue.labels.includes(label))) {
      ignored.push({ identifier: issue.identifier, reason: 'Has excluded label' });
      continue;
    }
    try {
      if (!issue.branchName) throw new Error('Linear issue has no branchName');
      const contract = extractContract(issue.description, 'AI Orchestrator Contract');
      const hydrated = planningIssueSchema.parse({
        ...(contract as Record<string, unknown>),
        source: {
          linearIssueId: issue.id,
          linearIdentifier: issue.identifier,
          linearCreatedAt: issue.createdAt,
          gitBranchName: issue.branchName,
          linearBlockedByIdentifiers: issue.blockedByIdentifiers,
        },
      });
      if (hydrated.projectKey !== null) {
        if (!issue.projectDescription) throw new Error('Linear issue project has no description');
        const project = planningProjectSchema.parse(extractContract(issue.projectDescription, 'AI Orchestrator Project Contract'));
        if (project.key !== hydrated.projectKey) throw new Error('Project contract key does not match issue projectKey');
        projects.set(project.key, project);
      }
      eligible.push(hydrated);
    } catch (error) {
      quarantined.push({ id: issue.id, identifier: issue.identifier, reason: error instanceof Error ? error.message : 'Invalid contract', payload: { description: issue.description, branchName: issue.branchName } });
    }
  }

  try {
    planningBacklogSchema.parse({ schemaVersion: 'kelolakelas.planning-backlog/v1', projects: [...projects.values()], issues: eligible });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Invalid dependency graph';
    for (const issue of eligible) quarantined.push({ id: issue.source?.linearIssueId ?? issue.draftKey, identifier: issue.source?.linearIdentifier ?? issue.draftKey, reason, payload: issue as Record<string, unknown> });
    return { eligible: [], quarantined, ignored };
  }
  return { eligible, quarantined, ignored };
}

export async function persistLinearIntake(repository: TaskRepository, report: IntakeReport): Promise<void> {
  const taskIds = new Map<string, string>();
  for (const issue of report.eligible) {
    if (!issue.source) continue;
    try {
      const persisted = await repository.upsertDiscoveredTask({
        linearIssueId: issue.source.linearIssueId,
        linearIdentifier: issue.source.linearIdentifier,
        contractSnapshot: issue as unknown as Record<string, unknown>,
        complexity: issue.complexity,
        workUnits: issue.repositories.map((repositoryName) => ({ repository: repositoryName })),
      });
      taskIds.set(issue.draftKey, persisted.task.id);
    } catch (error) {
      if (error instanceof ContractChangedError) {
        report.quarantined.push({ id: issue.source.linearIssueId, identifier: issue.source.linearIdentifier, reason: error.message, payload: issue as unknown as Record<string, unknown> });
      } else throw error;
    }
  }
  for (const issue of report.eligible) {
    const taskId = taskIds.get(issue.draftKey);
    if (!taskId) continue;
    const blockers = issue.blockedByDraftKeys.map((key) => taskIds.get(key)).filter((id): id is string => id !== undefined);
    await repository.replaceDependencies(taskId, blockers);
  }
  await Promise.all(report.quarantined.map((candidate) => repository.quarantineIntake({
    linearIssueId: candidate.id,
    linearIdentifier: candidate.identifier,
    reason: candidate.reason,
    payload: candidate.payload,
  })));
}