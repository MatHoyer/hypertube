import { hypertubeLogger } from "@hypertube/libs";
import { Job, JobsOptions, Queue, QueueEvents, QueueEventsListener } from "bullmq";
import { getRedisConnectionQueues } from "./Redis.js";
import {
  MOVIE_QUEUE,
  MOVIE_QUEUE_JOB_NAMES,
  TDownloadJobData,
  TPreviewJobData,
  TStopSeedingJobData,
} from "./const.js";

type TQueueName = typeof MOVIE_QUEUE;
type TQueueJobData = {
  [MOVIE_QUEUE]: TDownloadJobData | TPreviewJobData | TStopSeedingJobData;
};
type TQueueJobName = {
  [MOVIE_QUEUE]: (typeof MOVIE_QUEUE_JOB_NAMES)[keyof typeof MOVIE_QUEUE_JOB_NAMES];
};

export class BullMQ<T extends TQueueName> {
  private readonly queue: Queue<TQueueJobData[T]>;
  private readonly events: QueueEvents;

  constructor(queueName: T) {
    const redisConnectionQueues = getRedisConnectionQueues();
    this.queue = new Queue<TQueueJobData[T]>(queueName, {
      connection: redisConnectionQueues,
    });
    this.events = new QueueEvents(queueName, {
      connection: redisConnectionQueues,
    });
  }

  async produce(
    jobName: TQueueJobName[T],
    data: TQueueJobData[T],
    opts?: JobsOptions
  ) {
    // @ts-expect-error bullmq is shit and doesn't support generics :)
    await this.queue.add(jobName, data, opts);
  }

  async on(
    event: keyof QueueEventsListener,
    callback: (job: Job<TQueueJobData[T]>) => void
  ) {
    this.events.on(event, async ({ jobId }: { jobId: string }) => {
      const job = (await this.queue.getJob(jobId)) as Job<TQueueJobData[T]>;
      if (job) {
        callback(job);
      } else {
        hypertubeLogger.error(
          `[${this.queue.name}] Event ${event} - Job ${jobId} not found`
        );
      }
    });
  }

  removeListener(
    event: keyof QueueEventsListener,
    callback: (job: Job<TQueueJobData[T]>) => void
  ) {
    this.events.removeListener(event, callback);
  }
}
