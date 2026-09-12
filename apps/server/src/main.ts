import { serve } from "@hono/node-server";
import { hypertubeLogger } from "@hypertube/libs";
import { env, registerCrons } from "@hypertube/server-core";
import { createApp } from "./app.js";
import { container } from "./container.js";

const app = createApp();

serve(
  {
    fetch: app.fetch,
    port: env.SERVER_PORT,
  },
  (info) => {
    hypertubeLogger.info(
      `Server is running on http://${info.address}:${info.port}`
    );
  }
);

if (env.RUN_SCHEDULER) {
  registerCrons(container.storageService);
}
