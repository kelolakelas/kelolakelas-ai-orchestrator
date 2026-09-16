import { describe, expect, it } from 'vitest';
import { validateConfig } from '../src/config/schema.js';
import { evaluateSandboxRun } from '../src/ops/sandbox-evidence.js';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const detail = (state: string, pullRequestNumber: number | null = 7) => ({
  task: { id: 't', linearIdentifier: 'SBX-1', state, lastError: state === 'BLOCKED' ? 'Required check gate failed' : null, requiresManualIntervention: state === 'BLOCKED' },
  workUnits: [{ repository: 'web', branch: 'sbx-1-change', pullRequestNumber, pullRequestUrl: null, mergeCommit: null }],
  attempts: [],
});

describe('sandbox delivery run evidence', () => {
  it('passes only when the task reaches the target with exactly one pull request per work unit', () => {
    expect(evaluateSandboxRun(detail('READY_FOR_HUMAN_REVIEW'), 'READY_FOR_HUMAN_REVIEW', { web: 1 })).toEqual({ passed: true, problems: [] });
    expect(evaluateSandboxRun(detail('COMPLETED'), 'READY_FOR_HUMAN_REVIEW', { web: 1 }).passed).toBe(true);
    expect(evaluateSandboxRun(detail('READY_FOR_HUMAN_REVIEW'), 'READY_FOR_HUMAN_REVIEW', { web: 2 }).problems).toEqual(['web has 2 pull requests for sbx-1-change; expected exactly 1']);
    expect(evaluateSandboxRun(detail('BLOCKED', null), 'READY_FOR_HUMAN_REVIEW', { web: 0 }).problems).toHaveLength(3);
  });

  it('ships a sandbox configuration that validates and keeps every safety control on', () => {
    const config = validateConfig(parse(readFileSync('ops/sandbox/orchestrator.sandbox.yaml', 'utf8')));
    expect(config.sandbox.kind).toBe('bubblewrap');
    expect(config.workspace?.gitAuthentication).toBe('github-token');
    expect(config.security.acceptCredentialExposure).toBe(false);
    expect(config.orchestrator.rollout).toEqual({ repositories: ['web'], maxNewTasksPerDay: 1 });
    expect(config.linear.teamKey).not.toBe('KEL');
    expect(Object.values(config.repositories).map((repository) => repository?.github)).toEqual(['kelolakelas/orchestrator-sandbox']);
  });
});
