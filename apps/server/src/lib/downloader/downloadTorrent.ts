import { TMovieSchema, TResolutionSchema } from "@hypertube/libs";
import { getMovieQueue, MOVIE_QUEUE_JOB_NAMES } from "@hypertube/server-core";
import { ProwlarrApi } from "../apis/prowlarr.api";
import { TmdbApi } from "../apis/tmdb.api";

export const downloadTorrent = async ({
  movie,
  resolution,
}: {
  movie: TMovieSchema;
  resolution: TResolutionSchema;
}) => {
  if (!movie.imdbId) throw new Error("Movie has no IMDB ID");

  const tmdbMovie = await new TmdbApi().getMovie(movie.tmdbId, "en");
  if (!tmdbMovie.hasDetails) {
    throw new Error(`Movie details not found for tmdbId ${movie.tmdbId}`);
  }

  const year = Number.parseInt(tmdbMovie.release_date.slice(0, 4), 10);
  if (!Number.isFinite(year)) {
    throw new Error(`Movie release year not found for tmdbId ${movie.tmdbId}`);
  }

  await new ProwlarrApi().downloadTorrent({
    movie,
    resolution,
    resolutionId: resolution.id,
    search: {
      imdbId: movie.imdbId,
      tmdbId: movie.tmdbId,
      title: tmdbMovie.original_title,
      year,
    },
  });

  await getMovieQueue().produce(
    MOVIE_QUEUE_JOB_NAMES.DOWNLOAD_MOVIE,
    {
      movie,
      resolutionId: resolution.id,
    },
    {
      // Torrent downloads can fail transiently (swarm hiccups, a stalled
      // peer) without the download itself being unrecoverable: retries
      // resume from whatever was already verified into the S3 piece store
      // rather than restarting from zero, so a few automatic retries are
      // close to free.
      attempts: 3,
      backoff: { type: "exponential", delay: 30000 },
    }
  );
};
