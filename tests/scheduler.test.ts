import { afterEach, describe, expect, it, vi } from 'vitest';
import { Scheduler, type SchedulerOptions } from '../src/orchestrator/scheduler.js';
import type { LinearProvider } from '../src/providers/linear.js';
import type { OperatorRepository, OrchestratorControls } from '../src/repositories/operator.repository.js';
import type { TaskRepository } from '../src/repositories/task.repository.js';
import { insideHours, outsideHours, testConfig } from './support/config.js';

function fakes(controls: Partial<OrchestratorControls> = {}) {
  const linear = { listIssues: vi.fn().mockResolvedValue([]) } satisfies LinearProvider;
  const tasks = {
    recoverExpiredLeases: vi.fn().mockResolvedValue([]),
    recoverLeasesOwnedBy: vi.fn().mockResolvedValue([]),
    claimNextTask: vi.fn().mockResolvedValue(undefined),
    replaceDependencies: vi.fn(),
    upsertDiscoveredTask: vi.fn(),
    quarantineIntake: vi.fn(),
  };
  const operator = {
    getControls: vi.fn().mockResolvedValue({ pauseNewWork: false, scheduleOverride: 'normal', updatedBy: null, updatedAt: new Date(0), ...controls }),
  };
  return { linear, tasks, operator };
}

function scheduler(parts: ReturnType<typeof fakes>, options: Partial<SchedulerOptions> = {}) {
  const log = vi.fn();
  const instance = new Scheduler({
    config: testConfig(),
    linear: parts.linear,
    tasks: parts.tasks as unknown as TaskRepository,
    operator: parts.operator as unknown as OperatorRepository,
    workerId: 'worker-test',
    dryRun: false,
    log,
    clock: () => insideHours,
    ...options,
  });
  return { instance, log };
}

const noopHandler = { run: vi.fn().mockResolvedValue({ kind: 'interrupted' }) };

afterEach(() => {
  vi.useRealTimers();
});

describe('scheduler', () => {
  it('runs a dry-run tick without recovery, persistence, or claims', async () => {
    const parts = fakes();
    const { instance, log } = scheduler(parts, { dryRun: true, handlers: { ANALYZING: noopHandler } });
    await instance.runOnce();
    expect(parts.linear.listIssues).toHaveBeenCalledOnce();
    expect(parts.tasks.recoverExpiredLeases).not.toHaveBeenCalled();
    expect(parts.tasks.claimNextTask).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('linear_intake_dry_run_report', expect.objectContaining({ eligible: [] }));
    expect(log).toHaveBeenCalledWith('scheduler_tick_completed', expect.objectContaining({ dryRun: true, intakeOk: true }));
  });

  it('recovers expired leases and polls intake but does not claim while new work is paused', async () => {
    const parts = fakes({ pauseNewWork: true });
    const { instance } = scheduler(parts, { handlers: { ANALYZING: noopHandler } });
    await instance.runOnce();
    expect(parts.tasks.recoverExpiredLeases).toHaveBeenCalledWith(insideHours);
    expect(parts.linear.listIssues).toHaveBeenCalledOnce();
    expect(parts.tasks.claimNextTask).not.toHaveBeenCalled();
  });

  it('records an intake failure without failing the tick and still claims', async () => {
    const parts = fakes();
    parts.linear.listIssues.mockRejectedValueOnce(new Error('Linear request failed: 503'));
    const { instance } = scheduler(parts, { handlers: { ANALYZING: noopHandler } });
    await instance.runOnce();
    expect(instance.status().lastIntake).toMatchObject({ ok: false, error: 'Error: Linear request failed: 503' });
    expect(instance.status().lastTick.error).toBeNull();
    expect(parts.tasks.claimNextTask).toHaveBeenCalledOnce();
  });

  it('claims nothing when no stage handler is registered', async () => {
    const parts = fakes();
    const { instance } = scheduler(parts);
    expect(instance.claimableWork({ scheduleOverride: 'normal' })).toEqual({ queued: false, parkedStates: [], scheduleResumeStates: [], limitResumeStates: [] });
  });

  it('derives claimable work from handlers, the schedule, and the override', () => {
    const parts = fakes();
    const handlers = { ANALYZING: noopHandler, IMPLEMENTING: noopHandler, WAITING_CI: noopHandler };
    const open = scheduler(parts, { handlers }).instance;
    expect(open.claimableWork({ scheduleOverride: 'normal' })).toEqual({
      queued: true,
      parkedStates: ['ANALYZING', 'IMPLEMENTING', 'WAITING_CI'],
      scheduleResumeStates: ['ANALYZING', 'IMPLEMENTING'],
      limitResumeStates: ['ANALYZING', 'IMPLEMENTING'],
    });

    const closed = scheduler(parts, { handlers, clock: () => outsideHours }).instance;
    expect(closed.claimableWork({ scheduleOverride: 'normal' })).toEqual({ queued: false, parkedStates: ['WAITING_CI'], scheduleResumeStates: [], limitResumeStates: [] });
    expect(closed.claimableWork({ scheduleOverride: 'enabled' }).queued).toBe(true);
    expect(open.claimableWork({ scheduleOverride: 'disabled' })).toEqual({ queued: false, parkedStates: ['WAITING_CI'], scheduleResumeStates: [], limitResumeStates: [] });
  });

  it('waits for the polling interval between ticks instead of busy polling', async () => {
    vi.useFakeTimers();
    const parts = fakes();
    const { instance } = scheduler(parts);
    await instance.start();
    expect(parts.linear.listIssues).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(parts.linear.listIssues).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(parts.linear.listIssues).toHaveBeenCalledTimes(2);
    await instance.stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(parts.linear.listIssues).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recovers its own previous leases on start only when asked to', async () => {
    const parts = fakes();
    const ephemeral = scheduler(parts).instance;
    await ephemeral.start();
    await ephemeral.stop();
    expect(parts.tasks.recoverLeasesOwnedBy).not.toHaveBeenCalled();
    const stable = scheduler(parts, { recoverOwnLeasesOnStart: true }).instance;
    await stable.start();
    expect(parts.tasks.recoverLeasesOwnedBy).toHaveBeenCalledWith('worker-test');
    await stable.stop();
  });

  it('reports a tick that runs past the stuck threshold as not live', async () => {
    const parts = fakes();
    let now = insideHours;
    let release: (() => void) | undefined;
    parts.linear.listIssues.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve([]); }));
    const { instance } = scheduler(parts, { clock: () => now, timing: { stuckTickMs: 1_000 } });
    const tick = instance.runOnce();
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(instance.isLive()).toBe(true);
    now = new Date(insideHours.getTime() + 2_000);
    expect(instance.isLive()).toBe(false);
    release?.();
    await tick;
    expect(instance.isLive()).toBe(true);
  });
});
