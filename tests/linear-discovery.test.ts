import { describe, expect, it } from 'vitest';
import { discoverLinearIssues } from '../src/intake/linear-discovery.js';

const contract = {
  draftKey: 'read-linear-contract',
  projectKey: null,
  title: 'Read Linear contract',
  type: 'Feature',
  priority: 'High',
  estimate: 'S',
  complexity: 'low',
  labels: ['web', 'ai-ready'],
  repositories: ['web'],
  blockedByDraftKeys: [],
  externalDependencies: [],
  body: {
    backgroundProblem: 'Discovery needs a contract.', goal: 'Read the issue.', requirements: ['Read JSON'], acceptanceCriteria: ['Contract is parsed'], technicalNotes: 'Read only.', relevantAreas: ['src/intake'], edgeCases: ['Missing branch'], testingValidation: ['Unit tests pass'], outOfScope: ['Writes'],
  },
};

function issue(overrides: Partial<{ branchName: string | null; description: string; labels: string[] }> = {}) {
  return {
    id: 'issue-id', identifier: 'KEL-1', description: `## AI Orchestrator Contract\n\n\`\`\`json\n${JSON.stringify(contract)}\n\`\`\``, branchName: 'copilot/kel-1-read-linear-contract', createdAt: '2026-09-15T10:00:00.000Z', stateType: 'backlog', labels: ['web', 'ai-ready'], blockedByIdentifiers: [], projectDescription: null, ...overrides,
  };
}

describe('Linear discovery', () => {
  it('hydrates a matching contract and filters label-ineligible issues', () => {
    const report = discoverLinearIssues([issue(), issue({ labels: ['web'] })], ['ai-ready'], ['blocked']);
    expect(report.eligible).toHaveLength(1);
    expect(report.eligible[0]?.source?.linearIdentifier).toBe('KEL-1');
    expect(report.ignored).toHaveLength(1);
  });

  it('quarantines candidates with incomplete Linear metadata', () => {
    const report = discoverLinearIssues([issue({ branchName: null })], ['ai-ready'], []);
    expect(report.eligible).toHaveLength(0);
    expect(report.quarantined[0]?.reason).toMatch(/branchName/);
  });
});