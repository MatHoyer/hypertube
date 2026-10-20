import { formatUnknownError, hypertubeLogger } from "@hypertube/libs";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { open, type FileHandle } from "node:fs/promises";
import { BLOCK_LENGTH, PeerConnection, PeerConnectionPool } from "./peer-connection.js";
import type { SeedSource } from "./peer-server.js";
import { computeNeededPieceIndices, pieceByteLength } from "./piece-ranges.js";
import type { PieceStore } from "./piece-store.js";
import type { TorrentFileMeta, TorrentMetadata } from "./metadata.js";

type PieceState = "needed" | "in-flight" | "done";

const MAX_IN_FLIGHT_PER_PEER = 5;
const BLOCK_PIPELINE_DEPTH = 4;

export type TargetFile = {
  file: TorrentFileMeta;
  /** Local path this file's bytes get written to, sized exactly file.length. Caller owns cleanup. */
  scratchFilePath: string;
};

export type PieceManagerOptions = {
  metadata: TorrentMetadata;
  /** Every file within the torrent we actually want (typically the video plus any sidecar subtitle files) — every piece outside all of their byte ranges is never requested. */
  targetFiles: TargetFile[];
  pool: PeerConnectionPool;
  /** Durable S3-backed piece store — enables resuming a restarted download without re-fetching pieces we already have, and lets this manager double as a SeedSource. Optional only so the class stays usable without S3 wired up (e.g. in isolation); production wiring always supplies one. */
  pieceStore?: PieceStore;
};

/**
 * The core download engine: assigns needed pieces to available unchoked
 * peers, requests their blocks, verifies each completed piece against its
 * SHA1 hash, and writes the verified bytes into every target file it
 * overlaps, at each file's own relative offset. Piece selection is
 * deliberately simple (sequential, lowest-needed-index-first) —
 * rarest-first/endgame are roadmap bonus-tier, not required for correctness.
 */
export class PieceManager extends EventEmitter implements SeedSource {
  private readonly metadata: TorrentMetadata;
  private readonly targetFiles: TargetFile[];
  private readonly pool: PeerConnectionPool;
  private readonly pieceStore?: PieceStore;

  private readonly neededPieceIndices: number[];
  private readonly pieceState = new Map<number, PieceState>();
  private readonly inFlightPerPeer = new Map<PeerConnection, number>();
  /** Peers whose last attempt at a given piece failed a hash check — deprioritized (not banned) for that piece so a retry prefers a different source. */
  private readonly failedPeersByPiece = new Map<number, Set<PeerConnection>>();
  private readonly peers = new Set<PeerConnection>();

  private readonly fileHandles = new Map<TargetFile, FileHandle>();
  private verifiedCount = 0;
  private destroyed = false;
  private doneEmitted = false;

  constructor({ metadata, targetFiles, pool, pieceStore }: PieceManagerOptions) {
    super();
    this.metadata = metadata;
    this.targetFiles = targetFiles;
    this.pool = pool;
    this.pieceStore = pieceStore;
    this.neededPieceIndices = computeNeededPieceIndices(
      metadata,
      targetFiles.map(({ file }) => file)
    );
    for (const index of this.neededPieceIndices) this.pieceState.set(index, "needed");
  }

  async start(): Promise<void> {
    for (const target of this.targetFiles) {
      this.fileHandles.set(target, await open(target.scratchFilePath, "w+"));
    }

    if (this.pieceStore) {
      const alreadyVerified = await this.pieceStore.findVerifiedPieces(
        this.neededPieceIndices
      );
      for (const index of alreadyVerified) {
        const pieceBuffer = await this.pieceStore.readPiece(index);
        await this.writePieceToFiles(index, pieceBuffer);
        this.pieceState.set(index, "done");
        this.verifiedCount++;
      }
      if (alreadyVerified.size > 0) {
        hypertubeLogger.info(
          `Torrent ${this.metadata.infoHash}: resumed ${alreadyVerified.size}/${this.neededPieceIndices.length} needed pieces from durable store`
        );
      }
    }

    if (this.verifiedCount === this.neededPieceIndices.length) {
      this.finish();
      return;
    }

    this.pool.on("wire", (connection) => this.handleNewPeer(connection));
    this.scheduleMore();
  }

  private handleNewPeer(connection: PeerConnection): void {
    if (this.destroyed) return;
    this.peers.add(connection);
    this.inFlightPerPeer.set(connection, 0);
    connection.wire.interested();

    const onUnchoke = () => this.scheduleMore();
    const onBitfieldOrHave = () => this.scheduleMore();
    connection.wire.on("unchoke", onUnchoke);
    connection.wire.on("bitfield", onBitfieldOrHave);
    connection.wire.on("have", onBitfieldOrHave);

    const cleanup = () => {
      this.peers.delete(connection);
      this.inFlightPerPeer.delete(connection);
    };
    connection.once("close", cleanup);
    connection.once("error", cleanup);

    this.scheduleMore();
  }

  private pickPeerFor(index: number): PeerConnection | null {
    const excluded = this.failedPeersByPiece.get(index);
    let fallback: PeerConnection | null = null;
    for (const peer of this.peers) {
      if (peer.wire.peerChoking) continue;
      if (!peer.wire.peerPieces.get(index)) continue;
      const inFlight = this.inFlightPerPeer.get(peer) ?? 0;
      if (inFlight >= MAX_IN_FLIGHT_PER_PEER) continue;
      if (excluded?.has(peer)) {
        fallback ??= peer;
        continue;
      }
      return peer;
    }
    return fallback;
  }

  private scheduleMore(): void {
    if (this.destroyed) return;
    for (const index of this.neededPieceIndices) {
      if (this.pieceState.get(index) !== "needed") continue;
      const peer = this.pickPeerFor(index);
      if (!peer) continue;
      this.pieceState.set(index, "in-flight");
      this.inFlightPerPeer.set(peer, (this.inFlightPerPeer.get(peer) ?? 0) + 1);
      this.downloadPiece(peer, index).finally(() => {
        this.inFlightPerPeer.set(peer, Math.max(0, (this.inFlightPerPeer.get(peer) ?? 1) - 1));
        this.scheduleMore();
      });
    }
  }

  private async downloadPiece(peer: PeerConnection, index: number): Promise<void> {
    const pieceLength = pieceByteLength(this.metadata, index);
    const blockCount = Math.ceil(pieceLength / BLOCK_LENGTH);
    const blocks: Buffer[] = new Array(blockCount);

    try {
      let cursor = 0;
      const worker = async () => {
        while (cursor < blockCount) {
          const blockIndex = cursor++;
          const offset = blockIndex * BLOCK_LENGTH;
          const length = Math.min(BLOCK_LENGTH, pieceLength - offset);
          blocks[blockIndex] = await peer.requestBlock(index, offset, length);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(BLOCK_PIPELINE_DEPTH, blockCount) }, worker)
      );

      const pieceBuffer = Buffer.concat(blocks, pieceLength);
      const hash = createHash("sha1").update(pieceBuffer).digest("hex");
      if (hash !== this.metadata.pieces[index]) {
        hypertubeLogger.warn(
          `Torrent ${this.metadata.infoHash}: piece ${index} failed hash verification from ${peer.address.host}:${peer.address.port} — re-requesting from a different peer`
        );
        let excluded = this.failedPeersByPiece.get(index);
        if (!excluded) {
          excluded = new Set();
          this.failedPeersByPiece.set(index, excluded);
        }
        excluded.add(peer);
        this.pieceState.set(index, "needed");
        return;
      }

      await this.writePieceToFiles(index, pieceBuffer);
      if (this.pieceStore) {
        try {
          await this.pieceStore.writePiece(index, pieceBuffer);
        } catch (storeError) {
          hypertubeLogger.warn(
            `Torrent ${this.metadata.infoHash}: failed to durably store piece ${index}: ${formatUnknownError(storeError)} — will re-download on restart`
          );
        }
      }
      this.pieceState.set(index, "done");
      this.failedPeersByPiece.delete(index);
      this.verifiedCount++;
      this.emit("progress", {
        verifiedPieces: this.verifiedCount,
        totalPieces: this.neededPieceIndices.length,
      });
      if (this.verifiedCount === this.neededPieceIndices.length) this.finish();
    } catch (error) {
      hypertubeLogger.warn(
        `Torrent ${this.metadata.infoHash}: piece ${index} request to ${peer.address.host}:${peer.address.port} failed: ${formatUnknownError(error)} — re-requesting`
      );
      this.pieceState.set(index, "needed");
    }
  }

  /** Writes the verified piece into every target file it overlaps — a piece can span a skipped neighboring file, or (rarely) the boundary between two target files. */
  private async writePieceToFiles(index: number, pieceBuffer: Buffer): Promise<void> {
    const pieceGlobalStart = index * this.metadata.pieceLength;
    const pieceGlobalEnd = pieceGlobalStart + pieceBuffer.length;

    for (const target of this.targetFiles) {
      const fileStart = target.file.offset;
      const fileEnd = fileStart + target.file.length;

      const writeStart = Math.max(pieceGlobalStart, fileStart);
      const writeEnd = Math.min(pieceGlobalEnd, fileEnd);
      if (writeStart >= writeEnd) continue;

      const slice = pieceBuffer.subarray(
        writeStart - pieceGlobalStart,
        writeEnd - pieceGlobalStart
      );
      const position = writeStart - fileStart;
      const fileHandle = this.fileHandles.get(target);
      if (!fileHandle) {
        throw new Error(
          `Scratch file handle missing for ${target.scratchFilePath} while writing piece ${index}`
        );
      }
      await fileHandle.write(slice, 0, slice.length, position);
    }
  }

  /** SeedSource: whether we can currently answer a request for this piece. */
  hasPiece(index: number): boolean {
    return this.pieceState.get(index) === "done";
  }

  get isDone(): boolean {
    return this.doneEmitted;
  }

  get progress(): { verifiedPieces: number; totalPieces: number } {
    return {
      verifiedPieces: this.verifiedCount,
      totalPieces: this.neededPieceIndices.length,
    };
  }

  get connectedPeerCount(): number {
    return this.peers.size;
  }

  /** SeedSource: reads a piece's bytes back from the durable store to answer an inbound peer request. Local scratch files only ever hold a file-relative slice of a piece (see writePieceToFiles), so the durable store is the one place the exact original piece bytes live. */
  async readPieceRange(index: number, offset: number, length: number): Promise<Buffer> {
    if (!this.pieceStore) {
      throw new Error(
        `No durable piece store configured for ${this.metadata.infoHash}; cannot serve piece ${index} to a peer`
      );
    }
    return this.pieceStore.readPieceRange(index, offset, length);
  }

  private finish(): void {
    if (this.doneEmitted) return;
    this.doneEmitted = true;
    this.emit("done");
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    await Promise.all(
      [...this.fileHandles.values()].map((handle) => handle.close())
    );
    this.fileHandles.clear();
  }
}
