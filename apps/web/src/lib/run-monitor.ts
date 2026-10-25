import type { RunSnapshot, RunTimelineEvent } from '@centralign/shared';
import { ApiError, runsApi } from './runs-api.js';
import type { RunsApi } from './runs-api.js';

export const isTerminal = (status: string) => ['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'].includes(status);
export interface MonitorState { snapshot: RunSnapshot | null; events: RunTimelineEvent[]; cursor: number; loading: boolean; error: ApiError | null; retryMs: number; historyLimited: boolean }
export class RunMonitor {
  state: MonitorState = { snapshot: null, events: [], cursor: 0, loading: true, error: null, retryMs: 0, historyLimited: false };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller = new AbortController();
  private pending: Promise<void> | null = null;
  private stopped = false;
  private again = false;
  private failures = 0;
  constructor(private readonly id: string, private readonly notify: (state: MonitorState) => void, private readonly api: Pick<RunsApi, 'get' | 'events'> = runsApi) {}
  private publish() { if (!this.stopped) this.notify({ ...this.state }); }
  start() { void this.refresh(); }
  stop() { this.stopped = true; this.controller.abort(); clearTimeout(this.timer); }
  async sync(): Promise<boolean> {
    const snapshot = await this.api.get(this.id, this.controller.signal); if (this.stopped) return false; if (snapshot.run.id !== this.id) throw new ApiError('The response belongs to a different run.', 0, 'INVALID_RESPONSE');
    let cursor = this.state.cursor; const collection = new Map(this.state.events.map((event) => [event.id, event])); let more = false;
    for (let pageCount = 0; pageCount < 40; pageCount++) {
      const page = await this.api.events(this.id, cursor, this.controller.signal);
      if (page.cursor < cursor || page.events.some((event) => event.runId !== this.id) || page.nextCursor !== null && page.nextCursor <= cursor) throw new ApiError('The service returned an invalid event cursor.', 0, 'INVALID_RESPONSE');
      for (const event of page.events) collection.set(event.id, event);
      cursor = page.cursor; more = page.nextCursor !== null; if (!more) break;
    }
    const final = isTerminal(snapshot.run.status) && !more ? await this.api.get(this.id, this.controller.signal) : snapshot;
    if (this.stopped) return false;
    if (final.run.id !== this.id) throw new ApiError('The response belongs to a different run.', 0, 'INVALID_RESPONSE');
    const all = [...collection.values()]; this.state = { snapshot: final, events: all.slice(-2000), cursor, loading: false, error: null, retryMs: 0, historyLimited: this.state.historyLimited || all.length > 2000 };
    this.publish(); return more;
  }
  async refresh(): Promise<void> {
    if (this.stopped) return;
    if (this.pending) { this.again = true; return this.pending; }
    clearTimeout(this.timer);
    this.pending = (async () => {
      let delay: number | null = null;
      try { const more = await this.sync(); this.failures = 0; if (more) delay = 100; else if (this.state.snapshot && !isTerminal(this.state.snapshot.run.status)) delay = 2000; }
      catch (error) {
        if (this.stopped) return;
        const failure = error instanceof ApiError ? error : new ApiError('Unable to refresh run state.', 0, 'NETWORK_ERROR', true);
        delay = failure.retryable ? Math.min(15000, 2000 * 2 ** Math.min(this.failures++, 3)) : null;
        this.state = { ...this.state, loading: false, error: failure, retryMs: delay ?? 0 }; this.publish();
      } finally {
        this.pending = null;
        if (!this.stopped) { if (this.again) { this.again = false; delay = 0; } if (delay !== null) this.timer = setTimeout(() => { void this.refresh(); }, delay); }
      }
    })();
    return this.pending;
  }
}
