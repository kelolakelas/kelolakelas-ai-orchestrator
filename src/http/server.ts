import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';
import type { Scheduler } from '../orchestrator/scheduler.js';
import { OperatorActionError, type OperatorRepository } from '../repositories/operator.repository.js';

export interface HttpServerOptions {
  scheduler: Pick<Scheduler, 'isLive' | 'status'>;
  operator: OperatorRepository;
  /** Checks PostgreSQL connectivity. */
  pingDatabase: () => Promise<void>;
  /** Operator endpoints are disabled when no token is configured. */
  operatorToken: string | undefined;
  /** Dry-run mode never writes to PostgreSQL, so operator mutations are rejected. */
  dryRun: boolean;
  log: (event: string, fields?: Record<string, unknown>) => void;
  readinessTimeoutMs?: number;
}

const maxBodyBytes = 16 * 1024;
const operatorContextSchema = z.object({
  actor: z.string().trim().min(1).max(100),
  reason: z.string().trim().min(1).max(500),
}).strict();
const scheduleOverrideSchema = operatorContextSchema.extend({ override: z.enum(['normal', 'enabled', 'disabled']) }).strict();
const taskIdSchema = z.string().uuid();

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function authorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization;
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  return timingSafeEqual(digest(header.slice('Bearer '.length)), digest(token));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > maxBodyBytes) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body must be JSON');
  }
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('timed out')), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Liveness, readiness, status, and audited operator controls.
 * Responses never include contract snapshots, provider payloads, configuration, or credentials.
 */
export function createHttpServer(options: HttpServerOptions): Server {
  const readinessTimeoutMs = options.readinessTimeoutMs ?? 2_000;

  async function readiness(): Promise<{ ready: boolean; checks: Record<string, string> }> {
    const status = options.scheduler.status();
    let database = 'ok';
    try {
      await withTimeout(options.pingDatabase(), readinessTimeoutMs);
    } catch {
      database = 'unavailable';
    }
    const linear = status.lastIntake === null ? 'pending' : status.lastIntake.ok ? 'ok' : 'unavailable';
    const scheduler = status.stopping ? 'stopping' : status.started ? 'ok' : 'starting';
    return { ready: database === 'ok' && linear === 'ok' && scheduler === 'ok', checks: { database, linear, scheduler } };
  }

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = request.method ?? 'GET';

    if (method === 'GET' && path === '/healthz') {
      const live = options.scheduler.isLive();
      sendJson(response, live ? 200 : 503, { status: live ? 'ok' : 'stuck' });
      return;
    }
    if (method === 'GET' && path === '/readyz') {
      const result = await readiness();
      sendJson(response, result.ready ? 200 : 503, result);
      return;
    }
    if (method === 'GET' && path === '/status') {
      const queue = await options.operator.queueSummary();
      sendJson(response, 200, { scheduler: options.scheduler.status(), queue });
      return;
    }

    if (!path.startsWith('/operator/')) throw new HttpError(404, 'Not found');
    if (options.operatorToken === undefined || options.operatorToken === '') throw new HttpError(404, 'Operator API is disabled');
    if (!authorized(request, options.operatorToken)) throw new HttpError(401, 'Unauthorized');

    const segments = path.split('/').filter(Boolean).slice(1);
    if (method === 'GET') {
      if (segments.length === 1 && segments[0] === 'controls') return sendJson(response, 200, await options.operator.getControls());
      if (segments.length === 1 && segments[0] === 'tasks') return sendJson(response, 200, { tasks: await options.operator.listTasks() });
      if (segments.length === 1 && segments[0] === 'actions') return sendJson(response, 200, { actions: await options.operator.listActions() });
      if (segments.length === 2 && segments[0] === 'tasks') {
        const taskId = parseTaskId(segments[1]);
        const task = await options.operator.getTaskStatus(taskId);
        if (!task) throw new HttpError(404, 'Task not found');
        return sendJson(response, 200, { task, actions: await options.operator.listActions(taskId) });
      }
      throw new HttpError(404, 'Not found');
    }
    if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
    if (options.dryRun) throw new HttpError(409, 'Operator mutations are disabled in dry-run mode');

    const body = await readJson(request);
    const action = segments.join('/');
    let result: unknown;
    if (action === 'pause') {
      result = await options.operator.setPauseNewWork(true, operatorContextSchema.parse(body));
    } else if (action === 'resume') {
      result = await options.operator.setPauseNewWork(false, operatorContextSchema.parse(body));
    } else if (action === 'schedule-override') {
      const { override, ...context } = scheduleOverrideSchema.parse(body);
      result = await options.operator.setScheduleOverride(override, context);
    } else if (segments.length === 3 && segments[0] === 'tasks') {
      const taskId = parseTaskId(segments[1]);
      const context = operatorContextSchema.parse(body);
      if (segments[2] === 'retry') result = { task: await options.operator.retryTask(taskId, context) };
      else if (segments[2] === 'cancel') result = await options.operator.cancelTask(taskId, context);
      else if (segments[2] === 'manual-intervention') result = { task: await options.operator.requireManualIntervention(taskId, context) };
      else throw new HttpError(404, 'Not found');
    } else {
      throw new HttpError(404, 'Not found');
    }
    options.log('operator_action_applied', { action, actor: (body as { actor?: unknown }).actor });
    sendJson(response, 200, sanitizeMutationResult(result));
  }

  return createServer((request, response) => {
    route(request, response).catch((error: unknown) => {
      if (error instanceof HttpError) return sendJson(response, error.status, { error: error.message });
      if (error instanceof z.ZodError) return sendJson(response, 400, { error: 'Invalid request', issues: error.issues.map(({ path, message }) => ({ path, message })) });
      if (error instanceof OperatorActionError) return sendJson(response, error.code === 'NOT_FOUND' ? 404 : 409, { error: error.message });
      options.log('http_request_failed', { method: request.method, error: error instanceof Error ? error.name : 'Unknown error' });
      return sendJson(response, 500, { error: 'Internal error' });
    });
  });
}

function parseTaskId(value: string | undefined): string {
  const parsed = taskIdSchema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, 'Task id must be a UUID');
  return parsed.data;
}

/** Drops the contract snapshot from persisted task rows returned by mutations. */
function sanitizeMutationResult(result: unknown): unknown {
  if (result === null || typeof result !== 'object') return result;
  const value = { ...(result as Record<string, unknown>) };
  if (value.task !== null && typeof value.task === 'object') {
    const task = { ...(value.task as Record<string, unknown>) };
    delete task.contractSnapshot;
    value.task = task;
  }
  return value;
}
