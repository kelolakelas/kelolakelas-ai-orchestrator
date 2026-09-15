import { describe, expect, it } from 'vitest';
import { validatePlanningBacklog } from '../src/intake/planning-contract.js';

function validBacklog(): Record<string, unknown> {
  const issueBody = {
    backgroundProblem: 'Tenant cannot safely publish classes yet.',
    goal: 'A tenant can publish a validated class offering.',
    requirements: ['Validate publication readiness', 'Keep draft behavior unchanged'],
    acceptanceCriteria: ['A complete class can be published', 'An incomplete class is rejected'],
    technicalNotes: 'Use the existing class ownership boundary.',
    relevantAreas: ['kelolakelas-academic-service/internal/usecase'],
    edgeCases: ['A class has no schedule'],
    testingValidation: ['Relevant unit tests pass'],
    outOfScope: ['Payment checkout'],
  };

  return {
    schemaVersion: 'kelolakelas.planning-backlog/v1',
    projects: [{
      key: 'class-commerce-foundation',
      name: 'Class commerce foundation',
      outcome: 'Tenants can publish sellable classes.',
      problem: 'Class publication readiness is not enforced.',
      valueAndPriority: 'High impact, high confidence, medium effort.',
      scope: ['Class publication'],
      outOfScope: ['Payment settlement'],
      successMetrics: ['Valid classes are publicly discoverable'],
      dependenciesAndRisks: [],
    }],
    issues: [
      {
        draftKey: 'validate-class-publication',
        projectKey: 'class-commerce-foundation',
        title: 'Validate class publication readiness',
        type: 'Improvement',
        priority: 'High',
        estimate: 'S',
        complexity: 'medium',
        labels: ['academic', 'ai-ready'],
        repositories: ['academic'],
        blockedByDraftKeys: [],
        externalDependencies: [],
        body: issueBody,
      },
      {
        draftKey: 'show-published-class',
        projectKey: 'class-commerce-foundation',
        title: 'Show published classes to buyers',
        type: 'Feature',
        priority: 'High',
        estimate: 'M',
        complexity: 'high',
        labels: ['web', 'academic', 'ai-ready'],
        repositories: ['web', 'academic'],
        blockedByDraftKeys: ['validate-class-publication'],
        externalDependencies: [],
        body: { ...issueBody, goal: 'Buyers can view a published class.' },
      },
    ],
  };
}

describe('planning backlog contract', () => {
  it('accepts a valid multi-repository dependency graph', () => {
    expect(validatePlanningBacklog(validBacklog()).issues).toHaveLength(2);
  });

  it('requires ai-ready and exact repository labels', () => {
    const backlog = validBacklog();
    const issues = backlog.issues as Array<Record<string, unknown>>;
    issues[0]!.labels = ['web', 'academic'];

    expect(() => validatePlanningBacklog(backlog)).toThrow(/ai-ready|exactly match/);
  });

  it('requires a supported execution complexity', () => {
    const backlog = validBacklog();
    const issues = backlog.issues as Array<Record<string, unknown>>;
    delete issues[0]!.complexity;
    expect(() => validatePlanningBacklog(backlog)).toThrow(/complexity/);

    issues[0]!.complexity = 'large';
    expect(() => validatePlanningBacklog(backlog)).toThrow(/complexity/);
  });

  it('rejects unknown dependencies', () => {
    const backlog = validBacklog();
    const issues = backlog.issues as Array<Record<string, unknown>>;
    issues[1]!.blockedByDraftKeys = ['missing-issue'];

    expect(() => validatePlanningBacklog(backlog)).toThrow(/unknown dependency key/);
  });

  it('rejects dependency cycles', () => {
    const backlog = validBacklog();
    const issues = backlog.issues as Array<Record<string, unknown>>;
    issues[0]!.blockedByDraftKeys = ['show-published-class'];

    expect(() => validatePlanningBacklog(backlog)).toThrow(/dependency graph contains a cycle/);
  });

  it('rejects hydrated contracts whose native Linear relations disagree', () => {
    const backlog = validBacklog();
    const issues = backlog.issues as Array<Record<string, unknown>>;
    issues[0]!.source = {
      linearIssueId: 'linear-id-1',
      linearIdentifier: 'KEL-1',
      linearCreatedAt: '2026-09-15T08:00:00.000Z',
      gitBranchName: 'farid/kel-1-validate-class-publication',
      linearBlockedByIdentifiers: [],
    };
    issues[1]!.source = {
      linearIssueId: 'linear-id-2',
      linearIdentifier: 'KEL-2',
      linearCreatedAt: '2026-09-15T08:01:00.000Z',
      gitBranchName: 'farid/kel-2-show-published-class',
      linearBlockedByIdentifiers: [],
    };

    expect(() => validatePlanningBacklog(backlog)).toThrow(/Linear blockedBy relations do not match/);
  });
});