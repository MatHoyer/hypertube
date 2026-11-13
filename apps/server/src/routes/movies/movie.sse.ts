import {
  DownloadState,
  DownloadStates,
  MOVIE_EVENTS,
  TGetMovieSSESchemas,
} from "@hypertube/libs";
import {
  getMovieQueue,
  MOVIE_QUEUE_JOB_NAMES,
  TDownloadJobData,
  TPreviewJobData,
} from "@hypertube/server-core";
import { SSEStreamingApi } from "hono/streaming";
import { SSEClients } from "../../lib/SSEClients";

export const sseClients = new SSEClients();

let downloaderListenersRegistered = false;

export const ensureDownloaderQueueListeners = () => {
  if (downloaderListenersRegistered) return;
  downloaderListenersRegistered = true;

  const movieQueue = getMovieQueue();

  movieQueue.on("completed", (job) => {
    switch (job.name) {
      case MOVIE_QUEUE_JOB_NAMES.DOWNLOAD_MOVIE: {
        const data = job.data as TDownloadJobData;
        sseClients.mapClients(data.movie.tmdbId.toString(), (stream) => {
          sendSSEDownloadStateChange(data, DownloadStates.DOWNLOADED, stream);
        });
        return;
      }
      case MOVIE_QUEUE_JOB_NAMES.PREVIEW_MOVIE: {
        const data = job.data as TPreviewJobData;
        sseClients.mapClients(data.movie.tmdbId.toString(), (stream) => {
          sendSSEPreviewStateChange(stream);
        });
        return;
      }
    }
  });
  movieQueue.on("failed", (job) => {
    switch (job.name) {
      case MOVIE_QUEUE_JOB_NAMES.DOWNLOAD_MOVIE: {
        // QueueEvents only emits 'failed' once BullMQ gives up (attempts
        // exhausted or an UnrecoverableError); a retry emits 'delayed'.
        const data = job.data as TDownloadJobData;
        sseClients.mapClients(data.movie.tmdbId.toString(), (stream) => {
          sendSSEDownloadStateChange(
            data,
            DownloadStates.NOT_DOWNLOADED,
            stream
          );
        });
        return;
      }
    }
  });
  movieQueue.on("waiting", (job) => {
    switch (job.name) {
      case MOVIE_QUEUE_JOB_NAMES.DOWNLOAD_MOVIE: {
        // A retry re-enters 'waiting', but the DB keeps saying DOWNLOADING.
        if (job.attemptsMade > 0) return;
        const data = job.data as TDownloadJobData;
        sseClients.mapClients(data.movie.tmdbId.toString(), (stream) => {
          sendSSEDownloadStateChange(data, DownloadStates.WAITING, stream);
        });
        return;
      }
    }
  });
  movieQueue.on("active", (job) => {
    switch (job.name) {
      case MOVIE_QUEUE_JOB_NAMES.DOWNLOAD_MOVIE: {
        const data = job.data as TDownloadJobData;
        sseClients.mapClients(data.movie.tmdbId.toString(), (stream) => {
          sendSSEDownloadStateChange(data, DownloadStates.DOWNLOADING, stream);
        });
        return;
      }
    }
  });
};

const sendSSEDownloadStateChange = (
  jobData: TDownloadJobData,
  downloadState: DownloadState,
  stream: SSEStreamingApi
) => {
  stream.writeSSE({
    event: MOVIE_EVENTS.RESOLUTION_STATE_CHANGE,
    data: JSON.stringify({
      resolutionId: jobData.resolutionId,
      downloadState: downloadState,
    }),
  });
};

export const sendSSESubtitleStateChange = (
  subtitle: TGetMovieSSESchemas["response"]["subtitleStateChange"],
  stream: SSEStreamingApi
) => {
  stream.writeSSE({
    event: MOVIE_EVENTS.SUBTITLE_STATE_CHANGE,
    data: JSON.stringify(subtitle),
  });
};

const sendSSEPreviewStateChange = (stream: SSEStreamingApi) => {
  stream.writeSSE({
    event: MOVIE_EVENTS.PREVIEW_STATE_CHANGE,
    data: "",
  });
};
