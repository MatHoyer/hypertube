import { formatUnknownError, specificLogger, TLogger } from "@hypertube/libs";
import cron from "node-cron";

type TCronUTC = {
  cronExpression: string;
  callback: (logger: TLogger) => void | Promise<void>;
  cronName: string;
};

export const cronUTC = ({ cronExpression, callback, cronName }: TCronUTC) => {
  const localLogger = specificLogger(cronName);

  cron.schedule(
    cronExpression,
    async () => {
      try {
        localLogger.info(`Cron job started`);
        await callback(localLogger);
      } catch (error) {
        localLogger.error(`Error in cron job: ${formatUnknownError(error)}`);
      }
    },
    {
      timezone: "UTC",
    }
  );
};
