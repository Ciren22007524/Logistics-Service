import { Queue } from 'bullmq';
import { newRedisConnection } from '../redis.js';

export const QUEUE = {
  submitShipment: 'submit-shipment',
  fetchLabel: 'fetch-label',
  processCallback: 'process-callback',
  pollTracking: 'poll-tracking',
  scheduled: 'scheduled',
} as const;

export interface SubmitShipmentJob { shipmentId: string }
export interface FetchLabelJob { shipmentId: string }
export interface ProcessCallbackJob { callbackId: string }
export interface PollTrackingJob { shipmentId: string }

const queues = new Map<string, Queue>();

export function queue<T = unknown>(name: string): Queue<T> {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, {
      connection: newRedisConnection(),
      defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 5000 },
    });
    queues.set(name, q);
  }
  return q as Queue<T>;
}

/**
 * jobId 固定：同一筆 shipment 的同類任務在佇列中只會有一個（可重入、不重複）。
 * BullMQ 的 jobId 不可含冒號。
 */
export async function enqueueSubmit(shipmentId: string, delayMs = 0, attempt = 0): Promise<void> {
  await queue<SubmitShipmentJob>(QUEUE.submitShipment).add(
    'submit',
    { shipmentId },
    { jobId: `submit-${shipmentId}-${attempt}`, delay: delayMs, attempts: 1 },
  );
}

export async function enqueueFetchLabel(shipmentId: string, attempt = 0, delayMs = 0): Promise<void> {
  await queue<FetchLabelJob>(QUEUE.fetchLabel).add(
    'label',
    { shipmentId },
    {
      jobId: `label-${shipmentId}-${attempt}`,
      delay: delayMs,
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
    },
  );
}

/** 後台「重新取標籤」：強制重抓並覆蓋 */
export async function enqueueFetchLabelForce(shipmentId: string): Promise<void> {
  await queue<FetchLabelJob>(QUEUE.fetchLabel).add(
    'label-force',
    { shipmentId },
    { jobId: `label-force-${shipmentId}-${Date.now()}`, attempts: 3, backoff: { type: 'exponential', delay: 30_000 } },
  );
}

export async function enqueueCallback(callbackId: string): Promise<void> {
  await queue<ProcessCallbackJob>(QUEUE.processCallback).add(
    'callback',
    { callbackId },
    { jobId: `cb-${callbackId}`, attempts: 8, backoff: { type: 'exponential', delay: 10_000 } },
  );
}

export async function enqueuePoll(shipmentId: string, bucket: string): Promise<void> {
  await queue<PollTrackingJob>(QUEUE.pollTracking).add(
    'poll',
    { shipmentId },
    { jobId: `poll-${shipmentId}-${bucket}`, attempts: 2, backoff: { type: 'fixed', delay: 60_000 } },
  );
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
}
