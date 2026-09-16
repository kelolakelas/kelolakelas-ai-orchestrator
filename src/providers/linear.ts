import type { OrchestratorConfig } from '../config/schema.js';

export interface LinearIssue {
  id: string;
  identifier: string;
  description: string;
  branchName: string | null;
  createdAt: string;
  stateType: string;
  labels: string[];
  blockedByIdentifiers: string[];
  projectDescription: string | null;
}

export interface LinearProvider {
  listIssues(): Promise<LinearIssue[]>;
}

interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

const issueQuery = `query Issues($teamKey: String!, $after: String) {
  issues(first: 50, after: $after, filter: { team: { key: { eq: $teamKey } } }) {
    nodes { id identifier description branchName createdAt state { type } labels { nodes { name } } blockedBy { nodes { identifier } } project { description } }
    pageInfo { hasNextPage endCursor }
  }
}`;

export class LinearGraphqlProvider implements LinearProvider {
  constructor(
    private readonly config: OrchestratorConfig['linear'],
    private readonly apiKey: string,
    private readonly request: FetchLike = fetch,
  ) {}

  async listIssues(): Promise<LinearIssue[]> {
    const issues: LinearIssue[] = [];
    let after: string | null = null;
    do {
      const response = await this.execute({ teamKey: this.config.teamKey, after });
      const connection = response.data?.issues;
      if (!connection) throw new Error('Linear response did not contain issues');
      issues.push(...connection.nodes.map((issue) => ({
        id: issue.id,
        identifier: issue.identifier,
        description: issue.description ?? '',
        branchName: issue.branchName ?? null,
        createdAt: issue.createdAt,
        stateType: issue.state?.type ?? 'unknown',
        labels: issue.labels?.nodes.map((label) => label.name) ?? [],
        blockedByIdentifiers: issue.blockedBy?.nodes.map((blocker) => blocker.identifier) ?? [],
        projectDescription: issue.project?.description ?? null,
      })));
      after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
    } while (after !== null);
    return issues;
  }

  private async execute(variables: Record<string, string | null>): Promise<LinearResponse> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      try {
        const response = await this.request(this.config.apiUrl, {
          method: 'POST',
          headers: { authorization: this.apiKey, 'content-type': 'application/json' },
          body: JSON.stringify({ query: issueQuery, variables }),
          signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        });
        if (!response.ok) throw new Error(`Linear request failed: ${response.status}`);
        const payload = await response.json() as LinearResponse;
        if (payload.errors && payload.errors.length > 0) throw new Error(`Linear GraphQL error: ${payload.errors[0]?.message ?? 'unknown error'}`);
        return payload;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Linear request failed');
      }
    }
    throw lastError ?? new Error('Linear request failed');
  }
}

interface LinearResponse {
  data?: { issues?: { nodes: Array<{ id: string; identifier: string; description?: string; branchName?: string; createdAt: string; state?: { type?: string }; labels?: { nodes: Array<{ name: string }> }; blockedBy?: { nodes: Array<{ identifier: string }> }; project?: { description?: string } }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
  errors?: Array<{ message?: string }>;
}