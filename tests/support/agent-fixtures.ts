import { analysisResultVersion, type AnalysisResult } from '../../src/execution/agent-results.js';

export function analysisResult(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    schemaVersion: analysisResultVersion,
    decision: 'proceed',
    summary: 'Add the feature flag',
    clarifications: [],
    repositories: [{ repository: 'web', summary: 'Update feature', changes: [{ path: 'feature.txt', action: 'modify', rationale: 'Implements it' }] }],
    acceptanceCriteria: [{ criterion: 'Criterion', approach: 'Test it' }],
    testPlan: ['Run check'],
    risks: [],
    ...overrides,
  };
}
