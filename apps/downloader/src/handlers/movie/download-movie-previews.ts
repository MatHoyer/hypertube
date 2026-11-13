import { hypertubeLogger, TpreviewMetadata } from "@hypertube/libs";
import {
  BUCKETS,
  getStoragePath,
  TPreviewJobData,
} from "@hypertube/server-core";
import { Job } from "bullmq";
import ffmpeg from "fluent-ffmpeg";
import Stream, { PassThrough } from "stream";
import { storageService } from "../../main.js";
import { VideoMetadata } from "./download-torrent-subtitles.js";

const COLS = 10;
const ROWS = 10;
// 16:9 ratio by default
const TILE_WIDTH = 240;
const TILE_HEIGHT = 135;

const getMoviePreviewPath = (movieId: string) => `${movieId}/preview.jpg`;

const hasMoviePreview = async (movieId: string) => {
  try {
    await storageService.statObject(
      BUCKETS.MOVIES,
      getMoviePreviewPath(movieId)
    );
    return true;
  } catch {
    return false;
  }
};

const downloadMoviePreview = async ({
  movieId,
  stream,
  movieMetadata,
}: {
  movieId: string;
  stream: Stream.Readable;
  movieMetadata: VideoMetadata;
}) => {
  let tileHeight = TILE_HEIGHT;
  if (movieMetadata.width && movieMetadata.height) {
    tileHeight = movieMetadata.height * (TILE_WIDTH / movieMetadata.width);
  }

  const metadata: TpreviewMetadata = {
    cols: COLS,
    rows: ROWS,
    width: TILE_WIDTH * COLS,
    height: tileHeight * ROWS,
    "tile-width": TILE_WIDTH,
    "tile-height": tileHeight,
  };

  const uploadStream = new PassThrough();
  // Upload must consume ffmpeg's output while it runs: started only on
  // 'end', a jpeg bigger than the pipe buffers blocked ffmpeg's stdout
  // forever and 'end' never came.
  const upload = putPreviewToObjectStockage(movieId, metadata, uploadStream);

  const conversion = new Promise<void>((resolve, reject) => {
    ffmpeg(stream)
      // Decode keyframes only: 100 thumbnails don't need every frame (~40x
      // faster than a full decode).
      .inputOptions(["-threads", "1", "-skip_frame", "nokey"])
      .outputOptions([
        "-vf",
        `fps=${(COLS * ROWS) / movieMetadata.duration},scale=${TILE_WIDTH}:${tileHeight},tile=${COLS}x${ROWS}`,
        "-q:v",
        "10",
      ])
      .on("start", () => {
        hypertubeLogger.info(`Start download preview for : ${movieId}`);
      })
      .on("end", () => resolve())
      .on("error", (e) => {
        hypertubeLogger.error(`Movie preview error : ${e.message}`);
        uploadStream.destroy(e);
        reject(e);
      })
      .format("image2")
      .pipe(uploadStream, { end: true });
  });

  await Promise.all([conversion, upload]);
  hypertubeLogger.info(`Finish download preview for : ${movieId}`);
};

const putPreviewToObjectStockage = async (
  movieId: string,
  metadata: TpreviewMetadata,
  uploadStream: PassThrough
) => {
  hypertubeLogger.info(`Put preview on object storage for : ${movieId}`);
  try {
    await storageService.putObject(
      BUCKETS.MOVIES,
      getMoviePreviewPath(movieId),
      uploadStream,
      undefined,
      { "Content-Type": "image/jpeg", ...metadata }
    );
  } catch (e) {
    hypertubeLogger.error("Preview upload failed");
    throw e;
  }
};

export const downloadMoviePreviews = async (
  job: Job<TPreviewJobData>
): Promise<string[] | undefined> => {
  const movieId = job.data.movie.tmdbId.toString();
  const resolutionId = job.data.resolutionId;

  if (await hasMoviePreview(movieId)) return;

  const stream = await storageService.getObject(
    BUCKETS.MOVIES,
    getStoragePath(movieId, "resolutions", resolutionId, "movie.mp4")
  );

  const { metaData } = await storageService.statObject(
    BUCKETS.MOVIES,
    getStoragePath(movieId, "resolutions", resolutionId, "movie.mp4")
  );

  await downloadMoviePreview({
    movieId,
    stream,
    movieMetadata: metaData as VideoMetadata,
  });
};
