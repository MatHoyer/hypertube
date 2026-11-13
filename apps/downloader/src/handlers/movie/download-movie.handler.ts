import {
  DownloadStates,
  formatUnknownError,
  hypertubeLogger,
} from "@hypertube/libs";
import {
  getMovieQueue,
  MOVIE_QUEUE_JOB_NAMES,
  prisma,
  TDownloadJobData,
} from "@hypertube/server-core";
import { Job, UnrecoverableError } from "bullmq";
import { notifySubscribers } from "../../notifications/notifySubscriber.js";
import { downloadMovie } from "./movie-downloader.js";

export const downloadMovieHandler = async (
  job: Job<TDownloadJobData>,
  token?: string
) => {
  hypertubeLogger.info(`[${job.data.movie.id}] Download torrent job started`);

  const { count } = await prisma.resolution.updateMany({
    where: { id: job.data.resolutionId },
    data: { downloadState: DownloadStates.DOWNLOADING },
  });
  if (count === 0) {
    // Deleted while queued (e.g. movie cleanup cron): no retry can fix that.
    throw new UnrecoverableError(
      `Resolution ${job.data.resolutionId} not found`
    );
  }

  return downloadMovie(job, token);
};

export const downloadMovieSuccessHandler = async (
  job: Job<TDownloadJobData>
) => {
  hypertubeLogger.info(`[${job.data.movie.id}] Moviedownload success`);

  // updateMany: the row may have been deleted mid-download (movie cleanup
  // cron); update() would throw P2025 out of an async event listener.
  const { count } = await prisma.resolution.updateMany({
    where: {
      id: job.data.resolutionId,
    },
    data: {
      downloadState: DownloadStates.DOWNLOADED,
    },
  });
  if (count === 0) {
    hypertubeLogger.warn(
      `[${job.data.movie.id}] Resolution ${job.data.resolutionId} no longer exists, skipping post-download steps`
    );
    return;
  }
  try {
    await notifySubscribers(job.data.movie.id, DownloadStates.DOWNLOADED);
  } catch (error) {
    hypertubeLogger.error(
      `Error sending movie downloaded notification: ${formatUnknownError(error)}`
    );
  }

  await getMovieQueue().produce(MOVIE_QUEUE_JOB_NAMES.PREVIEW_MOVIE, {
    movie: job.data.movie,
    resolutionId: job.data.resolutionId,
  });
};

export const downloadMovieFailureHandler = async (
  job: Job<TDownloadJobData>,
  err: Error
) => {
  hypertubeLogger.error(
    `[${job?.data.movie.id}] Movie download failed (attempt ${job?.attemptsMade}/${job?.opts.attempts ?? 1}): ${formatUnknownError(err)}`
  );
  if (!job?.data.movie.id || !job?.data.resolutionId) {
    hypertubeLogger.error(
      `[${job?.data.movie.id}] Can't update movie resolution download state : No movieId or resolutionId`
    );
    return;
  }

  // BullMQ retries (see downloadTorrent.ts's producer opts) resume from the
  // S3 piece store rather than restarting, so an intermediate attempt
  // failing isn't a real "not downloaded" state — only flip the DB once
  // BullMQ actually gave up. moveToFailed sets finishedOn only on a final
  // failure (attempts exhausted, or an UnrecoverableError), not on a retry.
  if (!job.finishedOn) {
    hypertubeLogger.info(
      `[${job.data.movie.id}] Attempt ${job.attemptsMade}/${job.opts.attempts ?? 1} failed, BullMQ will retry`
    );
    return;
  }

  await prisma.resolution.updateMany({
    where: {
      id: job.data.resolutionId,
    },
    data: {
      downloadState: DownloadStates.NOT_DOWNLOADED,
    },
  });
};
