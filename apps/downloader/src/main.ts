import { formatUnknownError, hypertubeLogger } from "@hypertube/libs";
import {
  env,
  IStorageService,
  MOVIE_QUEUE,
  MOVIE_QUEUE_JOB_NAMES,
  S3StorageService,
  TDownloadJobData,
  TStopSeedingJobData,
} from "@hypertube/server-core";
import { Job, Worker } from "bullmq";
import { Redis } from "ioredis";
import { downloadMoviePreviews } from "./handlers/movie/download-movie-previews.js";
import {
  downloadMovieFailureHandler,
  downloadMovieHandler,
  downloadMovieSuccessHandler,
} from "./handlers/movie/download-movie.handler.js";
import { reconcileSeeds } from "./handlers/movie/seed-reconciliation.js";
import * as engine from "./handlers/movie/torrent/engine.js";
import { gracefulShutdown } from "./shutdown.js";

export const storageService: IStorageService = new S3StorageService();

const connection = new Redis({
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  maxRetriesPerRequest: null,
});

// Tracked so a fatal (uncaught) error can still fail *this* job explicitly
// instead of leaving it stuck "active" until BullMQ's stalled-job timeout
// (lockDuration, see DOWNLOAD_JOB_LOCK_DURATION) notices the worker is gone.
// Cleared once the job settles normally, so it's only non-null while
// genuinely in-flight.
let activeJob: { job: Job; token: string } | null = null;

// Movie downloads can run for hours, but the lock itself stays short: rather
// than a single multi-hour lockDuration (which left a job unreclaimable for
// up to an hour if the worker died mid-download — a container restart during
// a real download orphaned the job with no way to resume until that expired),
// downloadMovie explicitly extends the lock every PROGRESS_LOG_INTERVAL tick
// via job.extendLock(token, ...). A crashed/killed worker stops ticking, so
// the lock naturally expires within this window and BullMQ's stalled-job
// detection (stalledInterval, default 30s) can reclaim it quickly instead of
// waiting up to lockDuration.
export const DOWNLOAD_JOB_LOCK_DURATION = 90000;

const worker = new Worker<TDownloadJobData>(
  MOVIE_QUEUE,
  async (job: Job, token?: string) => {
    activeJob = token ? { job, token } : null;
    try {
      switch (job.name) {
        case MOVIE_QUEUE_JOB_NAMES.DOWNLOAD_MOVIE:
          return await downloadMovieHandler(job, token);
        case MOVIE_QUEUE_JOB_NAMES.PREVIEW_MOVIE:
          return await downloadMoviePreviews(job);
        case MOVIE_QUEUE_JOB_NAMES.STOP_SEEDING:
          return engine.destroy((job.data as TStopSeedingJobData).infoHash);
        default:
          throw new Error(`Unknown job name: ${job.name}`);
      }
    } finally {
      activeJob = null;
    }
  },
  { connection, concurrency: 1, lockDuration: DOWNLOAD_JOB_LOCK_DURATION }
);

hypertubeLogger.info(`Downloader worker started`);

/**
 * Some errors (e.g. a chunk-store constructor throwing synchronously inside
 * webtorrent's internal event dispatch) happen outside any promise chain a
 * try/catch in our own code can reach — Node has no way to catch them except
 * process-wide. Rather than let that silently kill the process while
 * bull-board still shows the job "active", explicitly fail the in-flight job
 * first, then exit — Node's own guidance is not to keep running after an
 * uncaught exception, since process state may be corrupted.
 */
const handleFatalError = (error: unknown) => {
  hypertubeLogger.error(`Fatal error, exiting: ${formatUnknownError(error)}`);
  const job = activeJob;

  (async () => {
    if (job) {
      try {
        await job.job.moveToFailed(
          error instanceof Error ? error : new Error(formatUnknownError(error)),
          job.token,
          false
        );
      } catch (moveError) {
        hypertubeLogger.error(
          `Failed to mark job ${job.job.id} as failed: ${formatUnknownError(moveError)}`
        );
      }
    }
    process.exit(1);
  })();
};

process.on("uncaughtException", handleFatalError);
process.on("unhandledRejection", handleFatalError);

// Non-blocking: resume seeding whatever's still within retention without
// delaying the worker's ability to pick up new jobs.
reconcileSeeds().catch((err) => {
  hypertubeLogger.error(`Seed reconciliation failed: ${formatUnknownError(err)}`);
});

// Handle graceful shutdown
process
  .on("SIGINT", () => gracefulShutdown("SIGINT", worker))
  .on("SIGTERM", () => gracefulShutdown("SIGTERM", worker));

// Handle completed jobs
worker.on("completed", async (job) => {
  switch (job.name) {
    case MOVIE_QUEUE_JOB_NAMES.DOWNLOAD_MOVIE:
      return downloadMovieSuccessHandler(job);
    case MOVIE_QUEUE_JOB_NAMES.PREVIEW_MOVIE:
      hypertubeLogger.info(`[${job.data.movie.id}] Movie preview success`);
      return;
    case MOVIE_QUEUE_JOB_NAMES.STOP_SEEDING:
      return;
    default:
      throw new Error(`Unknown job name: ${job.name}`);
  }
});

worker.on("failed", async (job, err) => {
  if (!job) {
    hypertubeLogger.error("Job not found");
    return;
  }

  switch (job.name) {
    case MOVIE_QUEUE_JOB_NAMES.DOWNLOAD_MOVIE:
      return downloadMovieFailureHandler(job, err);
    case MOVIE_QUEUE_JOB_NAMES.PREVIEW_MOVIE:
      hypertubeLogger.info(
        `[${job.data.movie.id}] Movie preview failed: ${err}`
      );
      return;
    case MOVIE_QUEUE_JOB_NAMES.STOP_SEEDING:
      hypertubeLogger.error(`Stop-seeding job failed: ${err}`);
      return;
    default:
      throw new Error(`Unknown job name: ${job.name}`);
  }
});
