import { AgentFault } from './contracts.js';
import type { ToolOutcome } from '../tools/contracts.js';

export function retryableRead(outcome: ToolOutcome, mutates: boolean): boolean { return !mutates && !outcome.ok && outcome.error.category === 'TRANSIENT' && outcome.error.retryability === 'SAFE_READ'; }
export function pauseForBackoff(attempt: number, signal: AbortSignal, random = Math.random): Promise<void> {
  const delay = Math.min(1000, 50 * 2 ** attempt) + Math.floor(random() * 25);
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new AgentFault('CANCELLED', 'Recovery cancelled.', 'CANCELLED')); return; }
    const abort = () => { clearTimeout(timer); reject(new AgentFault('CANCELLED', 'Recovery cancelled.', 'CANCELLED')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delay);
    signal.addEventListener('abort', abort, { once: true });
  });
}
