import type { SpoClient } from '../spo/client.js';
import type { EventInput } from './events.js';
import type { TaskRow } from './queue.js';

export type TaskResult =
  /** One-shot work finished. */
  | { outcome: 'done' }
  /** Same task again after afterMs (0 = next page right away, >0 = recurring schedule). */
  | { outcome: 'again'; afterMs: number; payload?: unknown };

export interface TaskContext<P = unknown> {
  task: TaskRow;
  payload: P;
  /** Aborted when the lease is lost, the task times out or the engine stops. */
  signal: AbortSignal;
  spo: SpoClient;
  /** Counts processed items (files, sites, versions) for throughput and the watchdog. */
  progress(items: number): void;
  /** Tells the UI what this slot is doing right now (Spanish, short). */
  status(text: string): void;
  event(e: Omit<EventInput, 'siteId' | 'libraryId'> & { siteId?: number | null; libraryId?: number | null }): Promise<void>;
}

export type TaskHandler<P = unknown> = (ctx: TaskContext<P>) => Promise<TaskResult>;

export type HandlerRegistry = Record<string, TaskHandler<never>>;
