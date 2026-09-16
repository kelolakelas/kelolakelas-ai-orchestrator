import { describe, expect, it } from 'vitest';
import { LinearGraphqlProvider } from '../src/providers/linear.js';

const config = { teamKey: 'KEL', requiredLabels: ['ai-ready'], excludedLabels: [], apiUrl: 'https://linear.test/graphql', requestTimeoutMs: 1_000, maxRetries: 1 };
const response = (nodes: unknown[], hasNextPage = false, endCursor: string | null = null) => new Response(JSON.stringify({ data: { issues: { nodes, pageInfo: { hasNextPage, endCursor } } } }), { status: 200 });
const node = { id: 'id-1', identifier: 'KEL-1', description: '', branchName: 'branch', createdAt: '2026-09-15T10:00:00.000Z', state: { type: 'backlog' }, labels: { nodes: [] }, blockedBy: { nodes: [] }, project: null };

describe('Linear GraphQL provider', () => {
  it('retries failed requests and follows cursors', async () => {
    let calls = 0;
    const provider = new LinearGraphqlProvider(config, 'secret', async () => {
      calls += 1;
      if (calls === 1) return new Response('', { status: 429 });
      return calls === 2 ? response([node], true, 'cursor-1') : response([{ ...node, id: 'id-2', identifier: 'KEL-2' }]);
    });
    const issues = await provider.listIssues();
    expect(issues.map((issue) => issue.identifier)).toEqual(['KEL-1', 'KEL-2']);
    expect(calls).toBe(3);
  });
});