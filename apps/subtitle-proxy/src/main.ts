import { serve } from "@hono/node-server";
import { hypertubeLogger, subtitleSchema } from "@hypertube/libs";
import {
  env,
  IStorageService,
  S3StorageService,
} from "@hypertube/server-core";
import { Hono } from "hono";
import {
  downloadYifysubtitles,
  getSubtitlesDownloadLinks,
} from "./scrappers/yifysubtitles.scrapper";

export const storageService: IStorageService = new S3StorageService();

const app = new Hono();

app.get("/subtitles/:imdbId", async (c) => {
  const imdbId = c.req.param("imdbId");
  if (!imdbId) {
    return c.json({ error: "IMDB ID is required" }, 400);
  }

  const subtitles = await getSubtitlesDownloadLinks({ imdbId });
  return c.json(subtitles);
});

app.post("/subtitles/download", async (c) => {
  const data = await c.req.json();
  const subtitles = subtitleSchema.parse(data.subtitles);
  const tmdbId = data.tmdbId;
  if (!tmdbId) {
    return c.json({ error: "TMDB ID is required" }, 400);
  }

  await downloadYifysubtitles({ ...subtitles, tmdbId });
  return c.json({ message: "Download started" });
});

serve(
  {
    fetch: app.fetch,
    port: env.SUBTITLE_PROXY_PORT,
  },
  (info) => {
    hypertubeLogger.info(
      `Subtitle proxy is running on http://localhost:${info.port}`
    );
  }
);
