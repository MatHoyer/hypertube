import { formatUnknownError, hypertubeLogger } from "@hypertube/libs";
import {
  BUCKETS,
  getTorrentPieceObjectName,
  IStorageService,
} from "@hypertube/server-core";
import { createHash } from "node:crypto";
import { buffer } from "node:stream/consumers";
import type { TorrentMetadata } from "./metadata.js";

const SELF_VERIFY_CONCURRENCY = 16;

export type PieceStoreOptions = {
  metadata: TorrentMetadata;
  storageService: IStorageService;
};

/**
 * Durable, S3-backed piece store — survives container/process restarts,
 * unlike the local scratch file (deleted after every job per the roadmap).
 * On startup, findVerifiedPieces self-verifies (SHA1, same defensive
 * posture the old webtorrent-based buildVerifiedBitfield used) whatever
 * pieces already exist here for this infoHash, so PieceManager only ever
 * requests genuinely-missing pieces from peers on a resumed download.
 * Every peer-downloaded, hash-verified piece is written back here too.
 *
 * Also doubles as the read path for seeding: keeps each piece as a single
 * object under its own key, unlike the local scratch file(s) which only
 * ever hold the file-relative slice of a piece — the exact original piece
 * bytes are what a requesting peer needs.
 *
 * Cleanup of the `torrent-pieces/<infoHash>/` prefix is intentionally NOT
 * done here — the monthly cleanup cron (packages/server-core/src/crons) already owns deleting
 * it, and does so before the downloader is told to stop seeding (see
 * TORRENT_ENGINE_ARCHITECTURE.md, Decision D).
 */
export class PieceStore {
  private readonly metadata: TorrentMetadata;
  private readonly storageService: IStorageService;

  constructor({ metadata, storageService }: PieceStoreOptions) {
    this.metadata = metadata;
    this.storageService = storageService;
  }

  private objectName(index: number): string {
    return getTorrentPieceObjectName(this.metadata.infoHash, index);
  }

  /** Self-verifies whatever's already in S3 among the given candidate indices; returns just the ones that hash-check out. Bounded concurrency — hundreds of pieces would be slow fully serial. */
  async findVerifiedPieces(candidateIndices: number[]): Promise<Set<number>> {
    const existingObjectNames = new Set(
      await this.storageService.listObjectNamesByPrefix(
        BUCKETS.TORRENT_PIECES,
        `${this.metadata.infoHash}/`
      )
    );
    const verified = new Set<number>();
    if (existingObjectNames.size === 0) return verified;

    let cursor = 0;
    const worker = async () => {
      while (cursor < candidateIndices.length) {
        const index = candidateIndices[cursor++];
        if (!existingObjectNames.has(this.objectName(index))) continue;
        try {
          const pieceBuffer = await this.readPiece(index);
          const hash = createHash("sha1").update(pieceBuffer).digest("hex");
          if (hash === this.metadata.pieces[index]) verified.add(index);
        } catch (error) {
          hypertubeLogger.warn(
            `Torrent ${this.metadata.infoHash}: failed to self-verify stored piece ${index}: ${formatUnknownError(error)}`
          );
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(SELF_VERIFY_CONCURRENCY, candidateIndices.length) },
        worker
      )
    );
    return verified;
  }

  async readPiece(index: number): Promise<Buffer> {
    const stream = await this.storageService.getObject(
      BUCKETS.TORRENT_PIECES,
      this.objectName(index)
    );
    return buffer(stream);
  }

  /** Byte range within a piece — for seeding, so answering a 16KB block request doesn't require loading the whole (often 1MB+) piece. */
  async readPieceRange(
    index: number,
    offset: number,
    length: number
  ): Promise<Buffer> {
    const stream = await this.storageService.getPartialObject(
      BUCKETS.TORRENT_PIECES,
      this.objectName(index),
      offset,
      length
    );
    return buffer(stream);
  }

  async writePiece(index: number, pieceBuffer: Buffer): Promise<void> {
    await this.storageService.putObject(
      BUCKETS.TORRENT_PIECES,
      this.objectName(index),
      pieceBuffer,
      pieceBuffer.length
    );
  }
}
