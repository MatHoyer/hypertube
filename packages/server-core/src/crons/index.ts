import { hypertubeLogger } from "@hypertube/libs";
import { IStorageService } from "../services/StorageService/IStorageService.js";
import { deleteMoviesMonthlyCron } from "./deleteMoviesMonthly.js";
import { healthcheckCron } from "./healthcheck.js";

export const registerCrons = (storageService: IStorageService) => {
  healthcheckCron();
  deleteMoviesMonthlyCron(storageService);
  hypertubeLogger.info("Cron jobs started");
};
