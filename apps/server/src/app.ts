import {
  hypertubeLogger,
  languageCodesArray,
  zodTranslate,
} from "@hypertube/libs";
import { serveStatic } from "@hono/node-server/serve-static";
import { env } from "@hypertube/server-core";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { languageDetector } from "hono/language";
import { logger } from "hono/logger";
import i18next from "i18next";
import "./lib/i18n/i18n.js";
import {
  injectApiContext,
  TApiContext,
} from "./middlewares/injectApiContext.js";
import authRouter from "./routes/auth/auth.route.js";
import authentificationRouter from "./routes/authentification/authentification.route.js";
import commentsRouter from "./routes/comments/comments.route.js";
import historyRouter from "./routes/history/history.route.js";
import imagesRouter from "./routes/images/images.route.js";
import moviesRouter from "./routes/movies/movies.route.js";
import notificationsRouter from "./routes/notifications/notifications.route.js";
import { oauthRouter } from "./routes/oauth/oauth.route.js";
import playlistsRouter from "./routes/playlists/playlists.route.js";
import streamingRouter from "./routes/streaming/streaming.route.js";
import swaggerRouter from "./routes/swagger/swagger.route.js";
import usersRouter from "./routes/users/users.route.js";

zodTranslate(i18next.t);

export function createApp() {
  const app = new Hono();

  app.onError((err: Error, c) => {
    hypertubeLogger.error(err.message);
    return c.json({ error: "internal server error" }, 500);
  });

  app.use(
    logger(),
    cors({
      origin: [env.CLIENT_URL],
      credentials: true,
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    }),
    languageDetector({
      convertDetectedLanguage: (lang) => lang.split("-")[0],
      supportedLanguages: [...languageCodesArray],
      fallbackLanguage: "en",
      caches: [],
    }),
    async (c, next) => {
      i18next.changeLanguage(c.get("language"));
      await next();
    }
  );

  const apiRouter = new Hono<TApiContext>();

  apiRouter.use(injectApiContext);

  apiRouter.route("/auth", authRouter);
  apiRouter.route("/oauth", oauthRouter);
  apiRouter.route("/authentification", authentificationRouter);
  apiRouter.route("/images", imagesRouter);
  apiRouter.route("/users", usersRouter);
  apiRouter.route("/movies", moviesRouter);
  apiRouter.route("/playlists", playlistsRouter);
  apiRouter.route("/notifications", notificationsRouter);
  apiRouter.route("/streaming", streamingRouter);
  apiRouter.route("/swagger", swaggerRouter);
  apiRouter.route("/comments", commentsRouter);
  apiRouter.route("/history", historyRouter);
  apiRouter.get("/health", (c) => c.text("OK"));

  app.route("/api", apiRouter);

  if (env.SERVE_FRONT) {
    const CLIENT_DIST_ROOT = "../client/dist";

    app.use("*", serveStatic({ root: CLIENT_DIST_ROOT }));
    app.get("*", serveStatic({ path: `${CLIENT_DIST_ROOT}/index.html` }));
  }

  return app;
}
