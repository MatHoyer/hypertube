import { hypertubeLogger } from "@hypertube/libs";
import { deleteMoviesMonthlyCron } from "./deleteMoviesMonthly.js";
import { healthcheckCron } from "./healthcheck.js";

export const registerCrons = () => {
  healthcheckCron();
  deleteMoviesMonthlyCron();
  hypertubeLogger.info("Cron jobs started");
};
