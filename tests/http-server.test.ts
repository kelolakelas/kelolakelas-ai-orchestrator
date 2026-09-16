import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpServer, type HttpServerOptions } from '../src/http/server.js';
import type { SchedulerStatus } from '../src/orchestrator/scheduler.js';
import { OperatorActionError, type OperatorRepository } from '../src/repositories/operator.repository.js';

const taskId = '5d0b7c52-7f55-4bf1-9d4f-3d2b3f0ae001';
const servers: Server[] = [];

function status(overrides: Partial<SchedulerStatus> = {}): SchedulerStatus {
  return {
    workerId: 'worker-test', dryRun: false, started: true, stopping: false,
    lastTick: { startedAt: null, completedAt: null, error: null },
    lastIntake: { at: new Date(), ok: true, eligible: 0, quarantined: 0, ignored: 0 },
    controls: null, inFlight: [],
    ...overrides,
  };
}

async function serve(overrides: Partial<HttpServerOptions> = {}) {
  const operator = {
    queueSummary: vi.fn().mockResolvedValue({ byState: { QUEUED: 2 }, leased: 0, manualIntervention: 0 }),
    getControls: vi.fn(),
    setPauseNewWork: vi.fn().mockResolvedValue({ pauseNewWork: true, scheduleOverride: 'normal' }),
    setScheduleOverride: vi.fn().mockResolvedValue({ pauseNewWork: false, scheduleOverride: 'disabled' }),
    retryTask: vi.fn().mockResolvedValue({ id: taskId, state: 'QUEUED', contractSnapshot: { secret: 'contract body' } }),
    cancelTask: vi.fn().mockRejectedValue(new OperatorActionError('Task cannot be cancelled from COMPLETED', 'CONFLICT')),
    requireManualIntervention: vi.fn(),
    listTasks: vi.fn().mockResolvedValue([]),
    getTaskStatus: vi.fn().mockResolvedValue(undefined),
    listActions: vi.fn().mockResolvedValue([]),
    listAttempts: vi.fn().mockResolvedValue([]),
    listWorkUnits: vi.fn().mockResolvedValue([]),
  };
  const server = createHttpServer({
    scheduler: { isLive: () => true, status: () => status() },
    operator: operator as unknown as OperatorRepository,
    pingDatabase: vi.fn().mockResolvedValue(undefined),
    operatorToken: 'operator-secret',
    dryRun: false,
    log: vi.fn(),
    readinessTimeoutMs: 50,
    ...overrides,
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, init: { method?: string; token?: string; body?: unknown } = {}) => fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers: { ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), 'content-type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return { operator, request };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe('HTTP server', () => {
  it('reports liveness and readiness with dependency checks', async () => {
    const { request } = await serve();
    expect((await request('/healthz')).status).toBe(200);
    const ready = await request('/readyz');
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ ready: true, checks: { database: 'ok', linear: 'ok', scheduler: 'ok' } });
  });

  it('fails readiness when PostgreSQL is unavailable or slow', async () => {
    const unavailable = await serve({ pingDatabase: vi.fn().mockRejectedValue(new Error('ECONNREFUSED postgres://user:password@db')) });
    const response = await unavailable.request('/readyz');
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain('"database":"unavailable"');
    expect(body).not.toContain('password');

    const slow = await serve({ pingDatabase: () => new Promise(() => undefined) });
    expect((await slow.request('/readyz')).status).toBe(503);
  });

  it('fails readiness when Linear access failed or the worker is stopping', async () => {
    const linearDown = await serve({ scheduler: { isLive: () => true, status: () => status({ lastIntake: { at: new Date(), ok: false, error: 'Linear request failed: 401' } }) } });
    expect(await (await linearDown.request('/readyz')).json()).toMatchObject({ ready: false, checks: { linear: 'unavailable' } });
    const stopping = await serve({ scheduler: { isLive: () => true, status: () => status({ stopping: true }) } });
    expect((await stopping.request('/readyz')).status).toBe(503);
  });

  it('exposes queue status without authentication', async () => {
    const { request } = await serve();
    expect(await (await request('/status')).json()).toMatchObject({ queue: { byState: { QUEUED: 2 } }, scheduler: { workerId: 'worker-test' } });
  });

  it('disables operator endpoints without a token and rejects a wrong token', async () => {
    const disabled = await serve({ operatorToken: undefined });
    expect((await disabled.request('/operator/tasks', { token: 'anything' })).status).toBe(404);
    const enabled = await serve();
    expect((await enabled.request('/operator/tasks')).status).toBe(401);
    expect((await enabled.request('/operator/tasks', { token: 'wrong' })).status).toBe(401);
    expect((await enabled.request('/operator/tasks', { token: 'operator-secret' })).status).toBe(200);
  });

  it('validates operator requests and requires an actor and reason', async () => {
    const { operator, request } = await serve();
    expect((await request('/operator/pause', { method: 'POST', token: 'operator-secret', body: { actor: 'ops' } })).status).toBe(400);
    expect((await request('/operator/tasks/not-a-uuid/retry', { method: 'POST', token: 'operator-secret', body: { actor: 'ops', reason: 'x' } })).status).toBe(400);
    expect((await request('/operator/schedule-override', { method: 'POST', token: 'operator-secret', body: { actor: 'ops', reason: 'x', override: 'always' } })).status).toBe(400);
    expect(operator.setPauseNewWork).not.toHaveBeenCalled();
  });

  it('applies operator actions and maps domain conflicts', async () => {
    const { operator, request } = await serve();
    const context = { actor: 'ops@example.test', reason: 'Incident 42' };
    expect((await request('/operator/pause', { method: 'POST', token: 'operator-secret', body: context })).status).toBe(200);
    expect(operator.setPauseNewWork).toHaveBeenCalledWith(true, context);
    await request('/operator/schedule-override', { method: 'POST', token: 'operator-secret', body: { ...context, override: 'disabled' } });
    expect(operator.setScheduleOverride).toHaveBeenCalledWith('disabled', context);

    const retried = await request(`/operator/tasks/${taskId}/retry`, { method: 'POST', token: 'operator-secret', body: context });
    expect(retried.status).toBe(200);
    expect(await retried.text()).not.toContain('contract body');

    const cancelled = await request(`/operator/tasks/${taskId}/cancel`, { method: 'POST', token: 'operator-secret', body: context });
    expect(cancelled.status).toBe(409);
    expect((await request(`/operator/tasks/${taskId}`, { token: 'operator-secret' })).status).toBe(404);
  });

  it('rejects operator mutations in dry-run mode', async () => {
    const { operator, request } = await serve({ dryRun: true });
    expect((await request('/operator/pause', { method: 'POST', token: 'operator-secret', body: { actor: 'ops', reason: 'x' } })).status).toBe(409);
    expect(operator.setPauseNewWork).not.toHaveBeenCalled();
  });
});
