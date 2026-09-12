import { TLogger } from "@hypertube/libs";
import { cronUTC } from "./cronUTC.js";

const HEALTHCHECK_CRON_EXPRESSION = "0 */1 * * * *";
const HEALTHCHECK_CRON_NAME = "Healthcheck";

const HEALTHCHECK_CRON_CALLBACK = async (localLogger: TLogger) => {
  localLogger.info("Scheduler healthcheck");
};

export const healthcheckCron = () => {
  cronUTC({
    cronExpression: HEALTHCHECK_CRON_EXPRESSION,
    callback: HEALTHCHECK_CRON_CALLBACK,
    cronName: HEALTHCHECK_CRON_NAME,
  });
};
