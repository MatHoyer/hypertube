import { formatUnknownError, newUTCDate, TLogger } from "@hypertube/libs";
import { BUCKETS, prisma } from "@hypertube/server-core";
import { subMonths } from "date-fns";
import { container } from "../container.js";
import { cronUTC } from "./cronUTC.js";

const DELETE_MOVIES_MONTHLY_CRON_EXPRESSION = "0 0 0 * * *";
const DELETE_MOVIES_MONTHLY_CRON_NAME = "Delete movies monthly";

const DELETE_MOVIES_MONTHLY_CRON_CALLBACK = async (localLogger: TLogger) => {
  localLogger.info("Deleting movies older than 1 month");

  const moviesToDelete = await prisma.movie.findMany({
    where: {
      usedAt: {
        lt: subMonths(newUTCDate(), 1),
      },
    },
  });

  if (moviesToDelete.length === 0) {
    localLogger.warn("No movies to delete");
    return;
  }
  localLogger.info(`Deleting ${moviesToDelete.length} movies`);

  for (const movie of moviesToDelete) {
    try {
      await container.storageService.removeObjectsByPrefix(
        BUCKETS.MOVIES,
        movie.tmdbId.toString()
      );
    } catch (error) {
      localLogger.error(
        `Error deleting movie folder: ${formatUnknownError(error)}`
      );
    }
  }

  const deletedMovies = await prisma.movie.deleteMany({
    where: {
      id: {
        in: moviesToDelete.map((movie) => movie.id),
      },
    },
  });

  localLogger.info(`Deleted ${deletedMovies.count} movies`);
};

export const deleteMoviesMonthlyCron = () => {
  cronUTC({
    cronExpression: DELETE_MOVIES_MONTHLY_CRON_EXPRESSION,
    callback: DELETE_MOVIES_MONTHLY_CRON_CALLBACK,
    cronName: DELETE_MOVIES_MONTHLY_CRON_NAME,
  });
};
