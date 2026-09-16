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

export interface LinearComment {
  id: string;
  body: string;
}

/**
 * Linear writes used by delivery. Mutations are not retried inside the adapter because a lost response can hide a
 * created record; callers reconcile through `listComments` markers or rely on attachment URLs being unique per issue.
 * Nothing here changes an issue's workflow state.
 */
export interface LinearIssueWriter {
  listComments(issueId: string): Promise<LinearComment[]>;
  createComment(issueId: string, body: string): Promise<{ id: string }>;
  /** Creates or updates the attachment for `url` on the issue; Linear keys attachments by issue and URL. */
  attachLink(issueId: string, input: { url: string; title: string; subtitle: string }): Promise<{ id: string }>;
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

const commentsQuery = `query IssueComments($issueId: String!, $after: String) {
  issue(id: $issueId) { comments(first: 100, after: $after) { nodes { id body } pageInfo { hasNextPage endCursor } } }
}`;

const commentCreateMutation = `mutation CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id } }
}`;

const attachmentCreateMutation = `mutation AttachmentCreate($input: AttachmentCreateInput!) {
  attachmentCreate(input: $input) { success attachment { id } }
}`;

export class LinearGraphqlProvider implements LinearProvider, LinearIssueWriter {
  constructor(
    private readonly config: OrchestratorConfig['linear'],
    private readonly apiKey: string,
    private readonly request: FetchLike = fetch,
  ) {}

  async listIssues(): Promise<LinearIssue[]> {
    const issues: LinearIssue[] = [];
    let after: string | null = null;
    do {
      const response: LinearResponse['data'] = await this.execute<LinearResponse['data']>(issueQuery, { teamKey: this.config.teamKey, after });
      const connection: IssuesConnection | undefined = response?.issues;
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

  async listComments(issueId: string): Promise<LinearComment[]> {
    const comments: LinearComment[] = [];
    let after: string | null = null;
    do {
      const data: CommentsData | undefined = await this.execute<CommentsData>(commentsQuery, { issueId, after });
      const connection: CommentsConnection | undefined = data?.issue?.comments;
      if (!connection || !Array.isArray(connection.nodes)) throw new Error('Linear response did not contain issue comments');
      comments.push(...connection.nodes.map((comment) => ({ id: String(comment.id), body: typeof comment.body === 'string' ? comment.body : '' })));
      after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
    } while (after !== null);
    return comments;
  }

  async createComment(issueId: string, body: string): Promise<{ id: string }> {
    const data = await this.execute<{ commentCreate?: { success?: boolean; comment?: { id?: string } } }>(commentCreateMutation, { input: { issueId, body } }, false);
    const id = data?.commentCreate?.comment?.id;
    if (data?.commentCreate?.success !== true || typeof id !== 'string') throw new Error('Linear commentCreate did not succeed');
    return { id };
  }

  async attachLink(issueId: string, input: { url: string; title: string; subtitle: string }): Promise<{ id: string }> {
    const data = await this.execute<{ attachmentCreate?: { success?: boolean; attachment?: { id?: string } } }>(attachmentCreateMutation, { input: { issueId, ...input } }, false);
    const id = data?.attachmentCreate?.attachment?.id;
    if (data?.attachmentCreate?.success !== true || typeof id !== 'string') throw new Error('Linear attachmentCreate did not succeed');
    return { id };
  }

  private async execute<T>(query: string, variables: Record<string, unknown>, retry = true): Promise<T | undefined> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= (retry ? this.config.maxRetries : 0); attempt += 1) {
      try {
        const response = await this.request(this.config.apiUrl, {
          method: 'POST',
          headers: { authorization: this.apiKey, 'content-type': 'application/json' },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        });
        if (!response.ok) throw new Error(`Linear request failed: ${response.status}`);
        const payload = await response.json() as { data?: T; errors?: Array<{ message?: string }> };
        if (payload.errors && payload.errors.length > 0) throw new Error(`Linear GraphQL error: ${payload.errors[0]?.message ?? 'unknown error'}`);
        return payload.data;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Linear request failed');
      }
    }
    throw lastError ?? new Error('Linear request failed');
  }
}

interface CommentsConnection {
  nodes: Array<{ id: unknown; body?: unknown }>;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

interface CommentsData {
  issue?: { comments?: CommentsConnection };
}

type IssuesConnection = NonNullable<NonNullable<LinearResponse['data']>['issues']>;

interface LinearResponse {
  data?: { issues?: { nodes: Array<{ id: string; identifier: string; description?: string; branchName?: string; createdAt: string; state?: { type?: string }; labels?: { nodes: Array<{ name: string }> }; blockedBy?: { nodes: Array<{ identifier: string }> }; project?: { description?: string } }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
  errors?: Array<{ message?: string }>;
}