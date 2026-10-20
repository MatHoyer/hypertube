import {
  DownloadStates,
  formatUnknownError,
  hypertubeLogger,
  newUTCDate,
} from "@hypertube/libs";
import { BUCKETS, getStoragePath, prisma } from "@hypertube/server-core";
import { subMonths } from "date-fns";
import { buffer } from "node:stream/consumers";
import { storageService } from "../../main.js";
import * as engine from "./torrent/engine.js";
import { parseTorrentIdentifier } from "./torrent/metadata.js";
import { selectTargetFiles } from "./torrent/select-target-files.js";

/**
 * Every downloader process is disposable, but seeding shouldn't stop just
 * because the worker that did the original download restarted or was
 * replaced. On boot, re-attach every resolution that's still fully
 * downloaded and still within the monthly retention window that
 * packages/server-core/src/crons/deleteMoviesMonthly.ts enforces — anything it
 * would delete is, by construction, also not worth re-seeding here.
 */
export const reconcileSeeds = async (): Promise<void> => {
  const retentionCutoff = subMonths(newUTCDate(), 1);

  const resolutions = await prisma.resolution.findMany({
    where: {
      downloadState: DownloadStates.DOWNLOADED,
      infoHash: { not: null },
      Movie: { usedAt: { gte: retentionCutoff } },
    },
    include: { Movie: true },
  });

  if (resolutions.length === 0) {
    hypertubeLogger.info("Seed reconciliation: nothing to resume");
    return;
  }

  hypertubeLogger.info(
    `Seed reconciliation: resuming ${resolutions.length} torrent(s)`
  );

  await Promise.allSettled(
    resolutions.map(async (resolution) => {
      if (!resolution.infoHash) return;
      try {
        const torrentStream = await storageService.getObject(
          BUCKETS.MOVIES,
          getStoragePath(
            resolution.Movie.tmdbId.toString(),
            "resolutions",
            resolution.id,
            "resolution.torrent"
          )
        );
        const torrentBuf = await buffer(torrentStream);
        const isMagnet = torrentBuf.toString("utf-8").startsWith("magnet:");
        const torrentId: string | Buffer = isMagnet
          ? torrentBuf.toString("utf-8")
          : torrentBuf;

        // Deliberately not engine.addTorrent — that would spin up live peer
        // discovery/dialing (and register a handle that'd make
        // resumeSeeding's no-op guard bail immediately). Reconciliation
        // only needs metadata.files, resolved locally with no network
        // access for a real .torrent buffer; a magnet with no cached
        // metadata is handled inside resumeSeeding itself.
        const identifier = await parseTorrentIdentifier(torrentId);
        if (identifier.kind !== "full") {
          hypertubeLogger.warn(
            `Seed reconciliation: magnet with no cached metadata for resolution ${resolution.id}, skipping (would need a live peer round-trip just to re-seed)`
          );
          return;
        }
        const selected = selectTargetFiles(identifier.metadata.files);
        if (!selected) {
          hypertubeLogger.warn(
            `Seed reconciliation: no video file found for resolution ${resolution.id}, skipping`
          );
          return;
        }

        await engine.resumeSeeding(
          torrentId,
          [selected.videoFile, ...selected.sidecarSubtitleFiles],
          storageService
        );
      } catch (error) {
        hypertubeLogger.error(
          `Seed reconciliation failed for resolution ${resolution.id}: ${formatUnknownError(error)}`
        );
      }
    })
  );
};
