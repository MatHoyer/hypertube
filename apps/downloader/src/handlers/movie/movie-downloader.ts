import {
  DownloadStates,
  formatUnknownError,
  hypertubeLogger,
  TMovieSchema,
} from "@hypertube/libs";
import {
  BUCKETS,
  env,
  getStoragePath,
  prisma,
  TDownloadJobData,
} from "@hypertube/server-core";
import { Job } from "bullmq";
import ffmpeg from "fluent-ffmpeg";
import * as fs from "fs";
import * as os from "os";
import { PassThrough } from "node:stream";
import { buffer } from "node:stream/consumers";
import path from "path";
import { DOWNLOAD_JOB_LOCK_DURATION, storageService } from "../../main.js";
import { notifySubscribers } from "../../notifications/notifySubscriber.js";
import {
  convertSubtitleFileToVtt,
  FFPROBE_LOW_MEM,
  formatSidecarSubtitleLanguage,
  handleEmbeddedSubtitles,
  VideoMetadata,
} from "./download-torrent-subtitles.js";
import * as engine from "./torrent/engine.js";
import type { TargetFile } from "./torrent/piece-manager.js";
import { selectTargetFiles, VIDEO_EXTENSIONS } from "./torrent/select-target-files.js";

const WAIT_FILE_DONE_TIMEOUT = 24 * 60 * 60 * 1000; // safety net; real bound is the stall watchdog
const WAIT_SUBTITLE_TIMEOUT = 10000;
const STALL_TIMEOUT = 180000;
const PROGRESS_LOG_INTERVAL = 30000;

// BullMQ job progress (visible in bull-board): torrent download is the bulk
// of the wait, conversion is comparatively quick.
const DOWNLOAD_PROGRESS_WEIGHT = 90;
const CONVERT_PROGRESS_WEIGHT = 10;

const reportJobProgress = (job: Job<TDownloadJobData>, percent: number) => {
  job.updateProgress(Math.round(percent)).catch((error: unknown) => {
    hypertubeLogger.error(
      `Failed to update job progress: ${formatUnknownError(error)}`
    );
  });
};

/** Surfaces a message in bull-board's job Logs tab (job.log), separate from hypertubeLogger's stdout output. */
const reportJobLog = (job: Job<TDownloadJobData>, message: string) => {
  job.log(message).catch((error: unknown) => {
    hypertubeLogger.error(`Failed to write job log: ${formatUnknownError(error)}`);
  });
};

const BROWSER_COMPATIBLE_VIDEO_CODECS = ["h264"];
const BROWSER_COMPATIBLE_AUDIO_CODECS = ["aac"];

const probeVideoMetadata = (filePath: string): Promise<VideoMetadata> => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, FFPROBE_LOW_MEM, (err, metadata) => {
      if (err) {
        reject(
          new Error(
            `Failed to probe video metadata: ${formatUnknownError(err)}`
          )
        );
        return;
      }

      const duration = metadata?.format?.duration;
      if (
        typeof duration !== "number" ||
        !Number.isFinite(duration) ||
        duration <= 0
      ) {
        reject(
          new Error(`Invalid or missing video duration: ${String(duration)}`)
        );
        return;
      }

      const videoStream = metadata.streams?.find(
        (stream) => stream.codec_type === "video"
      );
      const audioStream = metadata.streams?.find(
        (stream) => stream.codec_type === "audio"
      );
      const bitrate = metadata.format?.bit_rate;

      resolve({
        duration,
        videoCodec: videoStream?.codec_name,
        audioCodec: audioStream?.codec_name,
        width: videoStream?.width,
        height: videoStream?.height,
        bitrate:
          typeof bitrate === "string"
            ? Number.parseInt(bitrate, 10)
            : typeof bitrate === "number"
              ? bitrate
              : undefined,
        formatName: metadata.format?.format_name,
      });
    });
  });
};

/**
 * Decision A (apps/downloader/TORRENT_ENGINE_ARCHITECTURE.md): prefer a fast
 * remux over a full transcode whenever the source is already browser
 * compatible, only paying for libx264 when the source video codec itself
 * isn't playable in-browser.
 */
type TConversionDecision = { options: string[]; description: string };

const decideConversionCodecOptions = (
  source: VideoMetadata
): TConversionDecision => {
  const videoCompatible =
    source.videoCodec != null &&
    BROWSER_COMPATIBLE_VIDEO_CODECS.includes(source.videoCodec);
  const audioCompatible =
    source.audioCodec == null ||
    BROWSER_COMPATIBLE_AUDIO_CODECS.includes(source.audioCodec);

  if (videoCompatible && audioCompatible) {
    const description = `Remuxing (source already browser-compatible): video=${source.videoCodec} audio=${source.audioCodec ?? "none"}`;
    hypertubeLogger.info(description);
    return { options: ["-c:v", "copy", "-c:a", "copy"], description };
  }
  if (videoCompatible) {
    const description = `Remuxing video, transcoding audio: video=${source.videoCodec} audio=${source.audioCodec}`;
    hypertubeLogger.info(description);
    return { options: ["-c:v", "copy", "-c:a", "aac"], description };
  }
  const description = `Full transcode required: video=${source.videoCodec ?? "unknown"} audio=${source.audioCodec ?? "none"}`;
  hypertubeLogger.info(description);
  return { options: ["-c:v", "libx264", "-c:a", "aac"], description };
};

const buildMovieObjectMetadata = ({
  videoMetadata,
  movie,
  resolutionId,
  resolution,
  sourceFilename,
  sourceSizeBytes,
}: {
  videoMetadata: VideoMetadata;
  movie: TMovieSchema;
  resolutionId: string;
  resolution: {
    resolution: string;
    indexerName: string;
    infoHash: string | null;
  };
  sourceFilename: string;
  sourceSizeBytes: number;
}): Record<string, string> => {
  const metadata: Record<string, string> = {
    "Content-Type": "video/mp4",
    duration: videoMetadata.duration.toFixed(3),
    "tmdb-id": String(movie.tmdbId),
    "resolution-id": resolutionId,
    resolution: resolution.resolution,
    "indexer-name": resolution.indexerName,
    "source-filename": sourceFilename,
    "source-size-bytes": String(sourceSizeBytes),
  };

  if (movie.imdbId) {
    metadata["imdb-id"] = movie.imdbId;
  }
  if (resolution.infoHash) {
    metadata["info-hash"] = resolution.infoHash;
  }
  if (videoMetadata.videoCodec) {
    metadata["video-codec"] = videoMetadata.videoCodec;
  }
  if (videoMetadata.audioCodec) {
    metadata["audio-codec"] = videoMetadata.audioCodec;
  }
  if (videoMetadata.width) {
    metadata.width = String(videoMetadata.width);
  }
  if (videoMetadata.height) {
    metadata.height = String(videoMetadata.height);
  }
  if (videoMetadata.bitrate) {
    metadata["bitrate-bps"] = String(videoMetadata.bitrate);
  }
  if (videoMetadata.formatName) {
    metadata["source-format"] = videoMetadata.formatName;
  }

  return metadata;
};

/**
 * Decision B (apps/downloader/TORRENT_ENGINE_ARCHITECTURE.md): faststart requires
 * a seekable output, so ffmpeg writes to this local scratch file, and only
 * the finished, faststart file is streamed to S3.
 */
const convertMovie = (
  input: { path: string },
  output: string,
  codecOptions: string[],
  handler?: {
    onStart?: () => Promise<void>;
    onProgress?: (progress: { percent: number }) => Promise<void>;
    onEnd?: () => Promise<void>;
    onError?: (error: Error) => Promise<void>;
  }
): Promise<void> => {
  return new Promise((resolvePromise, rejectPromise) => {
    ffmpeg(input.path)
      .inputOptions(["-fflags", "+genpts", "-threads", "1", ...FFPROBE_LOW_MEM])
      .outputOptions([
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        ...codecOptions,
        "-threads",
        "1",
        "-max_muxing_queue_size",
        "256",
        "-movflags",
        "+faststart",
      ])
      .format("mp4")
      .on("start", async (commandLine) => {
        hypertubeLogger.info(`Conversion started: ${commandLine}`);
        await handler?.onStart?.();
      })
      .on("progress", async (progress) => {
        hypertubeLogger.info(
          `Conversion progress: ${progress.percent?.toFixed(2) || 0}%`
        );
        await handler?.onProgress?.({ percent: progress.percent || 0 });
      })
      .on("end", async () => {
        hypertubeLogger.info(`Conversion ended`);
        await handler?.onEnd?.();
        resolvePromise();
      })
      .on("error", async (error) => {
        hypertubeLogger.error(`Conversion error: ${formatUnknownError(error)}`);
        await handler?.onError?.(error);
        rejectPromise(
          error instanceof Error ? error : new Error(String(error))
        );
      })
      .output(output)
      .run();
  });
};

const uploadSubtitle = async ({
  movie,
  language,
  vttStream,
  downloadLink,
}: {
  movie: TMovieSchema;
  language: string;
  vttStream: PassThrough;
  downloadLink: string;
}) => {
  await storageService.putObject(
    BUCKETS.MOVIES,
    getStoragePath(
      movie.tmdbId.toString(),
      "subtitles",
      language,
      "subtitles.vtt"
    ),
    vttStream
  );

  await prisma.subtitle.upsert({
    where: { downloadLink },
    update: {},
    create: {
      movieId: movie.id,
      language,
      rating: 5,
      downloadLink,
      downloadState: DownloadStates.DOWNLOADED,
    },
  });
};

/** subtitleFilePath is already the fully-downloaded sidecar file — the piece manager wrote it straight to this path, no separate materialization step needed. */
const handleSidecarSubtitleFile = async (
  movie: TMovieSchema,
  subtitleFileName: string,
  subtitleFilePath: string
) => {
  const language = formatSidecarSubtitleLanguage(subtitleFileName);
  const uploadStream = new PassThrough();

  hypertubeLogger.info(`Converting sidecar subtitle to VTT: ${subtitleFileName}`);
  await Promise.all([
    convertSubtitleFileToVtt(subtitleFilePath, uploadStream),
    uploadSubtitle({
      movie,
      language,
      vttStream: uploadStream,
      downloadLink: subtitleFileName,
    }),
  ]);
};

export const downloadMovie = async (
  job: Job<TDownloadJobData>,
  token?: string
) => {
  const { movie, resolutionId } = job.data;

  const dbResolution = await prisma.resolution.findUnique({
    where: { id: resolutionId },
  });
  if (!dbResolution) {
    throw new Error(`Resolution ${resolutionId} not found`);
  }

  const resolutionStream = await storageService.getObject(
    BUCKETS.MOVIES,
    getStoragePath(
      movie.tmdbId.toString(),
      "resolutions",
      resolutionId,
      "resolution.torrent"
    )
  );
  const torrentBuf = await buffer(resolutionStream);
  const isMagnet = torrentBuf.toString("utf-8").startsWith("magnet:");
  const torrentId: string | Buffer = isMagnet
    ? torrentBuf.toString("utf-8")
    : torrentBuf;

  const { infoHash, metadata } = await engine.addTorrent(torrentId);
  if (dbResolution.infoHash !== infoHash) {
    await prisma.resolution.update({
      where: { id: resolutionId },
      data: { infoHash },
    });
  }

  const addingMessage = `Adding ${isMagnet ? "magnet" : "torrent"} for movie ${movie.tmdbId} resolution ${dbResolution.resolution} (${dbResolution.indexerName}), infoHash=${infoHash}`;
  hypertubeLogger.info(addingMessage);
  reportJobLog(job, addingMessage);

  const scratchDir = path.join(
    env.TORRENT_SCRATCH_DIR ?? path.join(os.tmpdir(), "hypertube-downloader"),
    resolutionId
  );

  try {
    const selected = selectTargetFiles(metadata.files);
    if (!selected) {
      throw new Error(
        `Video file not found (supported: ${VIDEO_EXTENSIONS.join(", ")})`
      );
    }
    const { videoFile, sidecarSubtitleFiles } = selected;
    hypertubeLogger.info(`Video file found ${videoFile.name}`);
    reportJobLog(job, `Video file found: ${videoFile.name}`);

    if (sidecarSubtitleFiles.length > 0) {
      hypertubeLogger.info(
        `${sidecarSubtitleFiles.length} sidecar subtitle file(s) found ${sidecarSubtitleFiles
          .map((file) => file.name)
          .join(", ")}`
      );
    }

    await fs.promises.mkdir(scratchDir, { recursive: true });

    const sourcePath = path.join(
      scratchDir,
      `source${path.extname(videoFile.name)}`
    );
    const videoTarget: TargetFile = { file: videoFile, scratchFilePath: sourcePath };
    const sidecarTargets: TargetFile[] = sidecarSubtitleFiles.map((file) => ({
      file,
      scratchFilePath: path.join(scratchDir, path.basename(file.name)),
    }));

    await engine.startDownload(
      infoHash,
      [videoTarget, ...sidecarTargets],
      storageService
    );

    notifySubscribers(movie.id, DownloadStates.DOWNLOADING);
    hypertubeLogger.info(`Movie download started successfully`);
    reportJobLog(job, "Download started");

    let lastVerifiedPieces = 0;
    let lastProgressAt = Date.now();
    let stalled = false;
    let rejectOnStall: ((err: Error) => void) | null = null;
    const stallPromise = new Promise<never>((_, reject) => {
      rejectOnStall = reject;
    });

    const progressInterval = setInterval(() => {
      const progress = engine.getProgress(infoHash);
      if (progress.verifiedPieces > lastVerifiedPieces) {
        lastVerifiedPieces = progress.verifiedPieces;
        lastProgressAt = Date.now();
      } else if (!stalled && Date.now() - lastProgressAt > STALL_TIMEOUT) {
        stalled = true;
        rejectOnStall?.(
          new Error(
            `Torrent stalled at ${progress.verifiedPieces}/${progress.totalPieces} pieces`
          )
        );
        return;
      }

      const ratio =
        progress.totalPieces > 0
          ? progress.verifiedPieces / progress.totalPieces
          : 1;
      const progressMessage = `Progress: ${(ratio * 100).toFixed(2)}%, pieces=${progress.verifiedPieces}/${progress.totalPieces}, peers=${progress.connectedPeers}`;
      hypertubeLogger.info(progressMessage);
      reportJobProgress(job, ratio * DOWNLOAD_PROGRESS_WEIGHT);
      reportJobLog(job, progressMessage);
      // Ties lock renewal to this same tick rather than relying solely on
      // BullMQ's own blind per-worker renewal timer — see
      // DOWNLOAD_JOB_LOCK_DURATION in main.ts for why the lock is short.
      if (token) {
        job.extendLock(token, DOWNLOAD_JOB_LOCK_DURATION).catch((error: unknown) => {
          hypertubeLogger.error(
            `Failed to extend job lock: ${formatUnknownError(error)}`
          );
        });
      }
    }, PROGRESS_LOG_INTERVAL);

    let doneTimeoutId: ReturnType<typeof setTimeout>;
    const doneTimeoutPromise = new Promise<never>((_, reject) => {
      doneTimeoutId = setTimeout(
        () => reject(new Error("Timeout waiting for torrent download to finish")),
        WAIT_FILE_DONE_TIMEOUT
      );
    });

    try {
      await Promise.race([engine.onDone(infoHash), stallPromise, doneTimeoutPromise]);
    } finally {
      clearInterval(progressInterval);
      clearTimeout(doneTimeoutId!);
    }

    try {
      const sidecarPromises = sidecarSubtitleFiles.map((subtitleFile, i) =>
        handleSidecarSubtitleFile(
          movie,
          subtitleFile.name,
          sidecarTargets[i].scratchFilePath
        )
      );
      await Promise.race([
        Promise.allSettled(sidecarPromises),
        new Promise((resolve) => setTimeout(resolve, WAIT_SUBTITLE_TIMEOUT)),
      ]);
    } catch (error) {
      hypertubeLogger.error(
        `Error handling sidecar subtitle files: ${formatUnknownError(error)}`
      );
    }

    const sourceMetadata = await probeVideoMetadata(sourcePath);
    const { options: codecOptions, description: conversionDescription } =
      decideConversionCodecOptions(sourceMetadata);

    reportJobProgress(job, DOWNLOAD_PROGRESS_WEIGHT);
    reportJobLog(job, `Conversion started: ${conversionDescription}`);

    const convertedPath = path.join(scratchDir, "movie.mp4");
    await convertMovie({ path: sourcePath }, convertedPath, codecOptions, {
      onProgress: async ({ percent }) => {
        reportJobProgress(
          job,
          DOWNLOAD_PROGRESS_WEIGHT +
            (Math.min(Math.max(percent, 0), 100) / 100) *
              CONVERT_PROGRESS_WEIGHT
        );
      },
      onEnd: async () => {
        reportJobLog(job, "Conversion finished");
      },
    });

    const convertedStat = await fs.promises.stat(convertedPath);
    if (convertedStat.size === 0) {
      throw new Error(`Converted movie file is empty: ${convertedPath}`);
    }

    const finalMetadata = await probeVideoMetadata(convertedPath);
    const movieObjectPath = getStoragePath(
      movie.tmdbId.toString(),
      "resolutions",
      resolutionId,
      "movie.mp4"
    );
    const movieMetadata = buildMovieObjectMetadata({
      videoMetadata: finalMetadata,
      movie,
      resolutionId,
      resolution: dbResolution,
      sourceFilename: videoFile.name,
      sourceSizeBytes: videoFile.length,
    });
    hypertubeLogger.info(
      `Uploading movie with metadata: duration=${movieMetadata.duration}s, resolution=${movieMetadata.resolution}`
    );

    await storageService.putObject(
      BUCKETS.MOVIES,
      movieObjectPath,
      fs.createReadStream(convertedPath),
      convertedStat.size,
      movieMetadata
    );

    await handleEmbeddedSubtitles({
      videoPath: sourcePath,
      videoFileName: videoFile.name,
      onSubtitle: async ({ language, vttStream, downloadLink }) => {
        await uploadSubtitle({ movie, language, vttStream, downloadLink });
      },
    });

    const uploadedStat = await storageService.statObject(
      BUCKETS.MOVIES,
      movieObjectPath
    );
    if (uploadedStat.size === 0) {
      throw new Error(`Uploaded movie file is empty: ${movieObjectPath}`);
    }

    reportJobProgress(job, 100);
    reportJobLog(job, "Upload complete");

    // Download already stopped dialing out for peers as soon as engine
    // detected 'done' (see engine.startDownload); this only releases the
    // scratch-file fds. The torrent stays registered with the peer server,
    // seeding straight from the durable S3 piece store, indefinitely.
    await engine.closeScratchFiles(infoHash);
  } catch (error) {
    const err =
      error instanceof Error ? error : new Error(formatUnknownError(error));
    reportJobLog(job, `FAILED: ${err.message}`);
    await engine.destroy(infoHash);
    throw err;
  } finally {
    await fs.promises.rm(scratchDir, { recursive: true, force: true });
  }
};
