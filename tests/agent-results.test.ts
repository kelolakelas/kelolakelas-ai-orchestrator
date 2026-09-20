import { describe, expect, it } from 'vitest';
import {
  analysisProblems, analysisResultSchema, effectiveVerdict, implementationResultSchema, implementationResultVersion,
  isSafeRepositoryPath, reviewProblems, reviewResultSchema, reviewResultVersion, toStrictJsonSchema, type ReviewResult,
} from '../src/execution/agent-results.js';
import { analysisResult } from './support/agent-fixtures.js';

function reviewResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return { schemaVersion: reviewResultVersion, verdict: 'approve', summary: 'Looks good', findings: [], ...overrides };
}

describe('agent result schemas', () => {
  it('accepts a valid versioned analysis and rejects fields that could select a command, tool, or model', () => {
    expect(analysisResultSchema.parse(analysisResult())).toMatchObject({ decision: 'proceed' });
    expect(analysisResultSchema.safeParse({ ...analysisResult(), model: 'other-model' }).success).toBe(false);
    expect(analysisResultSchema.safeParse({ ...analysisResult(), commands: ['rm -rf /'] }).success).toBe(false);
    expect(analysisResultSchema.safeParse({ ...analysisResult(), schemaVersion: 'kelolakelas.agent.analysis/v0' }).success).toBe(false);
    const withTool = analysisResult();
    expect(analysisResultSchema.safeParse({ ...withTool, repositories: [{ ...withTool.repositories[0], tool: 'shell' }] }).success).toBe(false);
  });

  it('rejects implementation results with the wrong version or an undeclared repository name', () => {
    const valid = { schemaVersion: implementationResultVersion, status: 'completed', summary: 'Done', blockedReason: null, repositories: [{ repository: 'web', summary: 'Done' }], validation: [] };
    expect(implementationResultSchema.safeParse(valid).success).toBe(true);
    expect(implementationResultSchema.safeParse({ ...valid, schemaVersion: 'kelolakelas.agent.fix/v1' }).success).toBe(false);
    expect(implementationResultSchema.safeParse({ ...valid, repositories: [{ repository: 'secrets', summary: 'x' }] }).success).toBe(false);
    expect(implementationResultSchema.safeParse({ ...valid, summary: '' }).success).toBe(false);
  });

  it('converts result schemas to strict structured-output JSON schemas', () => {
    const schema = toStrictJsonSchema(reviewResultSchema) as { required: string[]; additionalProperties: boolean; properties: Record<string, unknown> };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['schemaVersion', 'verdict', 'summary', 'findings']);
    expect(schema.properties.schemaVersion).toEqual({ type: 'string', enum: [reviewResultVersion] });
    expect(schema.properties.findings).toMatchObject({
      type: 'array',
      items: { type: 'object', additionalProperties: false, properties: { line: { anyOf: [{ type: 'integer' }, { type: 'null' }] } } },
    });
    for (const resultSchema of [analysisResultSchema, implementationResultSchema, reviewResultSchema]) {
      expect(JSON.stringify(toStrictJsonSchema(resultSchema))).not.toContain('"required":[]');
    }
  });

  it('requires plans to cover exactly the declared repositories with safe paths', () => {
    expect(analysisProblems(analysisResult(), ['web'])).toEqual([]);
    expect(analysisProblems(analysisResult(), ['web', 'academic'])).toEqual([expect.stringContaining('must equal contract repositories')]);
    const unsafe = analysisResult({ repositories: [{ repository: 'web', summary: 's', changes: [{ path: '../identity/secret.ts', action: 'modify', rationale: 'r' }] }] });
    expect(analysisProblems(unsafe, ['web'])).toEqual([expect.stringContaining('unsafe path')]);
    expect(analysisProblems(analysisResult({ decision: 'needs-clarification' }), ['web'])).toEqual([expect.stringContaining('at least one clarification')]);
  });

  it('classifies repository paths', () => {
    expect(isSafeRepositoryPath('src/app.ts')).toBe(true);
    expect(isSafeRepositoryPath('src/')).toBe(true);
    for (const path of ['/etc/passwd', '../x', 'src/../../x', './src', 'a\\b', '.', '']) expect(isSafeRepositoryPath(path)).toBe(false);
  });

  it('never lets an approval contradict its own blocking findings', () => {
    const finding = { repository: 'web' as const, path: 'a.ts', line: 3, severity: 'major' as const, description: 'Bug' };
    expect(effectiveVerdict(reviewResult({ findings: [finding] }))).toBe('request-changes');
    expect(effectiveVerdict(reviewResult({ findings: [{ ...finding, severity: 'minor' }] }))).toBe('approve');
    expect(reviewProblems(reviewResult({ findings: [{ ...finding, repository: 'billing' }] }), ['web'])).toEqual([expect.stringContaining('undeclared repository')]);
  });
});
