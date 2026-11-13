import {
  newUTCDate,
  PRESIGNED_URL_EXPIRY_SECONDS,
  TGetStreamingPreviewSchemas,
  TGetStreamingResolutionSchemas,
  TGetStreamingSubtitlesSchemas,
} from "@hypertube/libs";
import { BUCKETS, getStoragePath, prisma } from "@hypertube/server-core";
import { Context } from "hono";
import { container } from "../../container";
import { TApiContext } from "../../middlewares/injectApiContext";
import { TUrlParamsParser } from "../../middlewares/urlParamsParser";

export const getStreamingResolution = async (
  c: Context<
    TApiContext & TUrlParamsParser<TGetStreamingResolutionSchemas["urlParams"]>
  >
) => {
  const { movieId: tmdbId, resolutionId } = c.get("validatedUrlParams");
  const storageService = c.get("storageService");
  const objectName = getStoragePath(
    tmdbId.toString(),
    "resolutions",
    resolutionId,
    "movie.mp4"
  );

  try {
    await storageService.statObject(BUCKETS.MOVIES, objectName);
  } catch {
    return c.notFound();
  }

  // The monthly cleanup cron deletes movies by usedAt; without this it is
  // never bumped and movies people still watch get deleted.
  await prisma.movie.updateMany({
    where: { tmdbId },
    data: { usedAt: newUTCDate() },
  });

  const url = await container.storageService.presignedGetObject(
    BUCKETS.MOVIES,
    objectName,
    PRESIGNED_URL_EXPIRY_SECONDS
  );

  return c.json({ url });
};

export const getStreamingSubtitles = async (
  c: Context<
    TApiContext & TUrlParamsParser<TGetStreamingSubtitlesSchemas["urlParams"]>
  >
) => {
  const { movieId: tmdbId, subtitlesLanguage } = c.get("validatedUrlParams");
  const storageService = c.get("storageService");
  const objectName = getStoragePath(
    tmdbId.toString(),
    "subtitles",
    subtitlesLanguage,
    "subtitles.vtt"
  );

  try {
    await storageService.statObject(BUCKETS.MOVIES, objectName);
  } catch {
    return c.notFound();
  }

  const url = await storageService.presignedGetObject(
    BUCKETS.MOVIES,
    objectName
  );

  return c.json({ url });
};

export const getStreamingPreview = async (
  c: Context<
    TApiContext & TUrlParamsParser<TGetStreamingPreviewSchemas["urlParams"]>
  >
) => {
  const { movieId: tmdbId } = c.get("validatedUrlParams");
  const storageService = c.get("storageService");
  const objectName = `${tmdbId.toString()}/preview.jpg`;

  let metaData;
  try {
    const statObject = await storageService.statObject(
      BUCKETS.MOVIES,
      objectName
    );
    metaData = statObject.metaData;
  } catch {
    return c.notFound();
  }

  const url = await storageService.presignedGetObject(
    BUCKETS.MOVIES,
    objectName
  );

  const {
    "tile-width": tileWidth,
    "tile-height": tileHeight,
    ...metadata
  } = metaData;

  return c.json({
    url,
    metadata: {
      tileWidth,
      tileHeight,
      ...metadata,
    },
  });
};
