import { afterEach, expect, it, vi } from 'vitest';
import { RunSnapshotSchema } from '@centralign/shared';
import { ApiError } from './runs-api.js';
import { RunMonitor } from './run-monitor.js';
import { eventTitle } from '../components/RunWork.js';

const at = '2026-10-26T00:00:00.000Z';
const snapshot = (terminal = false) => RunSnapshotSchema.parse({ run: { id: 'run-1', objective: 'Inspect sources', status: terminal ? 'COMPLETED' : 'RUNNING', createdAt: at, updatedAt: at, completedAt: terminal ? at : null, metadata: {}, version: 1 }, goal: null, plan: null, planRevision: 0, steps: [], currentStepId: null, pendingQuestions: [], pendingApprovals: [], verification: [], finalResult: null, artifacts: [], budgets: { modelCalls: 1, toolCalls: 0, recoveries: 0, replans: 0, deadlineAt: at }, resolvedCustomerId: null, cancelRequested: false, actions: [], milestones: [] });
const event = (id: string) => ({ id, runId: 'run-1', stepId: null, type: 'RUN_CREATED', payload: {}, createdAt: at });
afterEach(() => vi.useRealTimers());
it('drains cursor pages in sequence, preserves final cursor and deduplicates repeated events', async () => {
  const events = vi.fn().mockResolvedValueOnce({ events: [event('e1')], cursor: 1, nextCursor: 1 }).mockResolvedValueOnce({ events: [event('e2')], cursor: 2, nextCursor: null }).mockResolvedValueOnce({ events: [event('e2'), event('e3')], cursor: 3, nextCursor: null }); const monitor = new RunMonitor('run-1', () => {}, { get: vi.fn().mockResolvedValue(snapshot()), events });
  await monitor.sync(); await monitor.sync(); expect(events.mock.calls.map((call) => call[1])).toEqual([0, 1, 2]); expect(monitor.state.events.map((item) => item.id)).toEqual(['e1', 'e2', 'e3']); expect(monitor.state.cursor).toBe(3); monitor.stop();
});
it('never moves the cursor backwards or admits another run’s events', async () => {
  const events = vi.fn().mockResolvedValueOnce({ events: [event('e1')], cursor: 4, nextCursor: null }).mockResolvedValueOnce({ events: [], cursor: 2, nextCursor: null }).mockResolvedValueOnce({ events: [{ ...event('wrong'), runId: 'another-run' }], cursor: 5, nextCursor: null }); const monitor = new RunMonitor('run-1', () => {}, { get: vi.fn().mockResolvedValue(snapshot()), events }); await monitor.sync(); await expect(monitor.sync()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' }); await expect(monitor.sync()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' }); expect(monitor.state.cursor).toBe(4); monitor.stop();
});
it('retains waiting state during empty polls and stops after final authoritative refresh', async () => {
  vi.useFakeTimers(); const waiting = snapshot(); waiting.run.status = 'WAITING_APPROVAL'; const get = vi.fn().mockResolvedValueOnce(waiting).mockResolvedValue(snapshot(true)); const events = vi.fn().mockResolvedValue({ events: [], cursor: 0, nextCursor: null }); const monitor = new RunMonitor('run-1', () => {}, { get, events });
  await monitor.refresh(); expect(monitor.state.snapshot?.run.status).toBe('WAITING_APPROVAL'); await vi.advanceTimersByTimeAsync(2000); expect(get).toHaveBeenCalledTimes(3); expect(monitor.state.snapshot?.run.status).toBe('COMPLETED'); await vi.advanceTimersByTimeAsync(30000); expect(get).toHaveBeenCalledTimes(3); monitor.stop();
});
it('backs off transient network failures and reconnects without duplicating history', async () => {
  vi.useFakeTimers(); const get = vi.fn().mockRejectedValueOnce(new ApiError('Offline', 0, 'NETWORK_ERROR', true)).mockResolvedValue(snapshot()); const events = vi.fn().mockResolvedValue({ events: [event('e1')], cursor: 1, nextCursor: null }); const monitor = new RunMonitor('run-1', () => {}, { get, events }); await monitor.refresh(); expect(monitor.state.retryMs).toBe(2000); await vi.advanceTimersByTimeAsync(2000); expect(monitor.state.error).toBeNull(); expect(monitor.state.events).toHaveLength(1); monitor.stop(); await vi.advanceTimersByTimeAsync(30000); expect(get).toHaveBeenCalledTimes(2);
});
it('aborts in-flight reads and suppresses late publications after navigation', async () => {
  let resolve!: (value: ReturnType<typeof snapshot>) => void; const get = vi.fn().mockImplementation(() => new Promise((done) => { resolve = done; })); const notify = vi.fn(); const monitor = new RunMonitor('run-1', notify, { get, events: vi.fn().mockResolvedValue({ events: [], cursor: 0, nextCursor: null }) }); const work = monitor.refresh(); monitor.stop(); resolve(snapshot()); await work; expect(get.mock.calls[0]?.[1].aborted).toBe(true); expect(notify).not.toHaveBeenCalled();
});
it('provides a readable fallback title for unfamiliar future event types', () => { expect(eventTitle('FUTURE_EVENT')).toBe('Recorded event: future event'); expect(eventTitle('VERIFICATION_FAILED')).toContain('verification failed'); });
