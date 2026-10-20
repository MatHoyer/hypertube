import { hypertubeLogger } from "@hypertube/libs";
import type { IStorageService } from "@hypertube/server-core";
import type Wire from "bittorrent-protocol";
import { resolveListenPort } from "./listen-port.js";
import {
  fetchMetadataFromPeer,
  parseTorrentIdentifier,
  type TorrentFileMeta,
  type TorrentMetadata,
} from "./metadata.js";
import { getPeerId } from "./peer-id.js";
import { PeerConnectionPool } from "./peer-connection.js";
import { PeerDiscovery } from "./peer-discovery.js";
import type { SeedSource } from "./peer-server.js";
import { PeerServer } from "./peer-server.js";
import { computeNeededPieceIndices } from "./piece-ranges.js";
import { PieceManager, type TargetFile } from "./piece-manager.js";
import { PieceStore } from "./piece-store.js";

type TorrentHandle = {
  infoHash: string;
  metadata: TorrentMetadata;
  discovery: PeerDiscovery;
  pool: PeerConnectionPool;
  pieceManager: PieceManager | null;
  /** True once stopDownloading has torn down discovery/pool — a torrent can still be an active SeedSource after this. */
  stoppedDownloading: boolean;
};

const handles = new Map<string, TorrentHandle>();
let peerServerPromise: Promise<PeerServer> | null = null;

/** One inbound-connection listener for the whole process, shared by every torrent — mirrors the old webtorrent.client.ts singleton client pattern. */
const getPeerServer = (): Promise<PeerServer> => {
  if (!peerServerPromise) {
    peerServerPromise = (async () => {
      const port = await resolveListenPort();
      const server = new PeerServer(getPeerId());
      await server.listen(port);
      hypertubeLogger.info(`Torrent peer server listening on port ${port}`);
      return server;
    })();
  }
  return peerServerPromise;
};

const infoHashOf = (
  identifier: Awaited<ReturnType<typeof parseTorrentIdentifier>>
): string =>
  identifier.kind === "full" ? identifier.metadata.infoHash : identifier.infoHash;

export type AddedTorrent = {
  infoHash: string;
  metadata: TorrentMetadata;
};

/**
 * Resolves a torrent/magnet's metadata and stands up its peer discovery +
 * connection pool, without downloading anything yet — call startDownload
 * afterwards with the files to actually fetch. Idempotent per infoHash: a
 * second addTorrent for an already-known infoHash just returns its
 * existing metadata.
 */
export const addTorrent = async (
  torrentIdOrMagnet: string | Buffer
): Promise<AddedTorrent> => {
  const identifier = await parseTorrentIdentifier(torrentIdOrMagnet);
  const infoHash = infoHashOf(identifier);

  const existing = handles.get(infoHash);
  if (existing) return { infoHash, metadata: existing.metadata };

  const peerId = getPeerId();
  const port = await resolveListenPort();
  const announce =
    identifier.kind === "full" ? identifier.metadata.announce : identifier.announce;

  const discovery = new PeerDiscovery({ infoHash, announce, peerId, port });
  const pool = new PeerConnectionPool({ infoHash, peerId, discovery });

  let metadata: TorrentMetadata;
  try {
    if (identifier.kind === "full") {
      metadata = identifier.metadata;
    } else {
      const wire = await new Promise<Wire>((resolve) =>
        pool.once("wire", (connection) => resolve(connection.wire))
      );
      metadata = await fetchMetadataFromPeer(wire, infoHash);
    }
  } catch (error) {
    discovery.destroy();
    pool.destroy();
    throw error;
  }

  handles.set(infoHash, {
    infoHash,
    metadata,
    discovery,
    pool,
    pieceManager: null,
    stoppedDownloading: false,
  });
  return { infoHash, metadata };
};

const getHandle = (infoHash: string): TorrentHandle => {
  const handle = handles.get(infoHash);
  if (!handle) throw new Error(`Unknown torrent ${infoHash} — call addTorrent first`);
  return handle;
};

/**
 * Starts (or resumes) downloading the given files of an already-added
 * torrent. Registers as a SeedSource immediately, before the first byte is
 * even in — peers can already pull whatever we verify as we go, not just
 * once we're fully done.
 */
export const startDownload = async (
  infoHash: string,
  targetFiles: TargetFile[],
  storageService: IStorageService
): Promise<void> => {
  const handle = getHandle(infoHash);
  if (handle.pieceManager) return; // already started

  const pieceStore = new PieceStore({ metadata: handle.metadata, storageService });
  const pieceManager = new PieceManager({
    metadata: handle.metadata,
    targetFiles,
    pool: handle.pool,
    pieceStore,
  });
  handle.pieceManager = pieceManager;

  const peerServer = await getPeerServer();
  peerServer.register(infoHash, handle.metadata.pieces.length, pieceManager);

  pieceManager.once("done", () => {
    // Nothing left to fetch — stop dialing out, but stay registered as a
    // seed (PeerServer only needs the PieceManager instance, not the pool).
    stopDownloading(infoHash);
  });

  await pieceManager.start();
};

export const getProgress = (
  infoHash: string
): { verifiedPieces: number; totalPieces: number; connectedPeers: number } => {
  const handle = getHandle(infoHash);
  const progress = handle.pieceManager?.progress ?? {
    verifiedPieces: 0,
    totalPieces: 0,
  };
  return { ...progress, connectedPeers: handle.pool.connectionCount };
};

export const onDone = (infoHash: string): Promise<void> => {
  const handle = getHandle(infoHash);
  if (!handle.pieceManager) {
    return Promise.reject(
      new Error(`startDownload was never called for ${infoHash}`)
    );
  }
  if (handle.pieceManager.isDone) return Promise.resolve();
  return new Promise((resolve) => handle.pieceManager?.once("done", () => resolve()));
};

/** Stops dialing out for more peers/pieces — used once a download finishes, but also callable directly to abandon an in-progress download while still seeding whatever was verified so far. */
export const stopDownloading = (infoHash: string): void => {
  const handle = handles.get(infoHash);
  if (!handle || handle.stoppedDownloading) return;
  handle.stoppedDownloading = true;
  handle.discovery.destroy();
  handle.pool.destroy();
};

/** Closes the target files' local scratch file handles without touching seeding — call once conversion/upload has read everything it needs, so an indefinitely-seeded torrent isn't holding scratch-dir fds (and the disk space behind them, even after the scratch dir itself is rm'd) open for its whole seeding lifetime. Reading/serving pieces to peers goes through the durable store, not these handles, so closing them is always safe once local materialization is done. */
export const closeScratchFiles = async (infoHash: string): Promise<void> => {
  const handle = handles.get(infoHash);
  await handle?.pieceManager?.destroy();
};

class StaticSeedSource implements SeedSource {
  constructor(
    private readonly verifiedIndices: Set<number>,
    private readonly pieceStore: PieceStore
  ) {}

  hasPiece(index: number): boolean {
    return this.verifiedIndices.has(index);
  }

  readPieceRange(index: number, offset: number, length: number): Promise<Buffer> {
    return this.pieceStore.readPieceRange(index, offset, length);
  }
}

/**
 * Re-registers a previously-completed download as a seed after a process
 * restart, without spinning up peer discovery/dialing or touching local
 * scratch files at all — there's nothing left to fetch, so this only
 * self-verifies (SHA1) whatever the durable store already has for the
 * given target files and serves straight from there. No-op if this
 * infoHash is already active (e.g. a genuine download already in
 * progress registered it). Only works for a torrent whose full metadata
 * we can resolve without a peer round-trip (a real .torrent buffer, or a
 * magnet already cached — see the roadmap's note on trackerless magnets
 * needing a live peer for BEP 9); a magnet with no cached metadata is
 * skipped with a warning rather than spinning up a whole discovery/pool
 * just to re-seed.
 */
export const resumeSeeding = async (
  torrentIdOrMagnet: string | Buffer,
  targetFiles: TorrentFileMeta[],
  storageService: IStorageService
): Promise<void> => {
  const identifier = await parseTorrentIdentifier(torrentIdOrMagnet);
  const infoHash = infoHashOf(identifier);
  if (handles.has(infoHash)) return;

  if (identifier.kind !== "full") {
    hypertubeLogger.warn(
      `Cannot resume seeding ${infoHash} from a magnet with no cached metadata — would need a live peer round-trip just to re-seed, skipping`
    );
    return;
  }

  const { metadata } = identifier;
  const pieceStore = new PieceStore({ metadata, storageService });
  const neededPieceIndices = computeNeededPieceIndices(metadata, targetFiles);
  const verifiedIndices = await pieceStore.findVerifiedPieces(neededPieceIndices);

  const peerServer = await getPeerServer();
  peerServer.register(
    infoHash,
    metadata.pieces.length,
    new StaticSeedSource(verifiedIndices, pieceStore)
  );
};

export const isSeeding = async (infoHash: string): Promise<boolean> => {
  const peerServer = await getPeerServer();
  return peerServer.isRegistered(infoHash);
};

export const listSeedingInfoHashes = async (): Promise<string[]> => {
  const peerServer = await getPeerServer();
  return peerServer.listInfoHashes();
};

/** Full teardown: stops downloading, stops seeding, closes the scratch file handle(s), forgets the torrent entirely. Does not touch the durable S3 piece store or the local scratch files themselves — callers own that cleanup. Always unregisters from the peer server, even for a resumeSeeding-only source with no `handles` entry (no discovery/pool/pieceManager to tear down in that case). */
export const destroy = async (infoHash: string): Promise<void> => {
  const handle = handles.get(infoHash);
  if (handle) {
    stopDownloading(infoHash);
    await handle.pieceManager?.destroy();
    handles.delete(infoHash);
  }

  const peerServer = await getPeerServer();
  peerServer.unregister(infoHash);
};
