import { hypertubeLogger } from "@hypertube/libs";
import { IStorageService, S3StorageService } from "@hypertube/server-core";
import { deleteMoviesMonthlyCron } from "./crons/deleteMoviesMonthly.js";
import { healthcheckCron } from "./crons/healthcheck.js";

export const storageService: IStorageService = new S3StorageService();

healthcheckCron();
deleteMoviesMonthlyCron();

hypertubeLogger.info("Cron jobs started");
