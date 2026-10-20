import { formatUnknownError } from "@hypertube/libs";
import parseTorrent from "parse-torrent";
import type Wire from "bittorrent-protocol";
import utMetadata, { UtMetadata } from "ut_metadata";

export type TorrentFileMeta = {
  path: string;
  name: string;
  length: number;
  offset: number;
};

export type TorrentMetadata = {
  infoHash: string;
  name: string;
  pieceLength: number;
  lastPieceLength: number;
  /** Per-piece hex-encoded SHA1 hashes, in piece-index order. */
  pieces: string[];
  files: TorrentFileMeta[];
  length: number;
  announce: string[];
};

/**
 * Result of a purely local parse (no network). A full .torrent buffer
 * resolves piece hashes and the file list immediately; a magnet URI only
 * ever carries the info hash + trackers — the rest has to come from a peer
 * (see fetchMetadataFromPeer, BEP 9).
 */
export type TorrentIdentifier =
  | { kind: "full"; metadata: TorrentMetadata }
  | { kind: "magnet"; infoHash: string; announce: string[]; name?: string };

const normalizeAnnounce = (tr: string | string[] | undefined): string[] => {
  if (!tr) return [];
  return Array.isArray(tr) ? tr : [tr];
};

/** Parses a magnet URI or full .torrent buffer locally — never touches the network. */
export const parseTorrentIdentifier = async (
  torrentIdOrMagnet: string | Buffer
): Promise<TorrentIdentifier> => {
  const parsed = await parseTorrent(torrentIdOrMagnet);
  if (!parsed.infoHash) {
    throw new Error("parse-torrent returned no infoHash for this identifier");
  }

  if (parsed.pieces && parsed.files) {
    return {
      kind: "full",
      metadata: {
        infoHash: parsed.infoHash,
        name: parsed.name ?? parsed.dn ?? parsed.infoHash,
        pieceLength: parsed.pieceLength ?? 0,
        lastPieceLength: parsed.lastPieceLength ?? 0,
        pieces: parsed.pieces,
        files: parsed.files,
        length: parsed.length ?? 0,
        announce: parsed.announce ?? normalizeAnnounce(parsed.tr),
      },
    };
  }

  return {
    kind: "magnet",
    infoHash: parsed.infoHash,
    announce: parsed.announce ?? normalizeAnnounce(parsed.tr),
    name: parsed.name ?? parsed.dn,
  };
};

const METADATA_FETCH_TIMEOUT_MS = 60000;

/**
 * Fetches the info dict from a single already-connected peer via BEP 9
 * (ut_metadata), for magnet-only starts that have no piece/file info yet.
 * Caller (peer-connection.ts, Phase 3) owns the wire's lifecycle — this
 * only attaches the extension and waits for either 'metadata' or a fatal
 * outcome (peer doesn't support/have it, wire closes, or timeout).
 */
export const fetchMetadataFromPeer = (
  wire: Wire,
  infoHash: string,
  timeoutMs = METADATA_FETCH_TIMEOUT_MS
): Promise<TorrentMetadata> => {
  return new Promise((resolve, reject) => {
    wire.use(utMetadata());
    // wire.use() assigns the extension instance under this well-known key
    // (bittorrent-protocol's `use()` reads it off `Extension.prototype.name`)
    // — no public type for it, hence the one cast here.
    const ext = (wire as unknown as { ut_metadata: UtMetadata }).ut_metadata;

    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out fetching metadata for ${infoHash} from peer via ut_metadata`
        )
      );
    }, timeoutMs);

    const onMetadata = async (metadataBuffer: Buffer) => {
      cleanup();
      try {
        const identifier = await parseTorrentIdentifier(metadataBuffer);
        if (identifier.kind !== "full") {
          reject(
            new Error(
              `ut_metadata delivered incomplete metadata for ${infoHash}`
            )
          );
          return;
        }
        resolve(identifier.metadata);
      } catch (error) {
        reject(
          new Error(
            `Failed to parse metadata fetched for ${infoHash}: ${formatUnknownError(error)}`
          )
        );
      }
    };
    const onWarning = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(
        new Error(`Wire closed before metadata for ${infoHash} arrived`)
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      ext.removeListener("metadata", onMetadata);
      ext.removeListener("warning", onWarning);
      wire.removeListener("close", onClose);
    };

    ext.on("metadata", onMetadata);
    ext.on("warning", onWarning);
    wire.once("close", onClose);
    ext.fetch();
  });
};

/**
 * Single entry point for both start shapes. A full .torrent buffer resolves
 * immediately with no network access; a magnet URI needs `getPeerWire` to
 * hand back at least one live, handshaken peer connection (supplied by
 * peer-connection.ts / engine.ts once those exist — Phases 3 and 5) so the
 * info dict can be pulled via BEP 9.
 */
export const resolveMetadata = async (
  torrentIdOrMagnet: string | Buffer,
  opts: { getPeerWire?: () => Promise<Wire> } = {}
): Promise<TorrentMetadata> => {
  const identifier = await parseTorrentIdentifier(torrentIdOrMagnet);
  if (identifier.kind === "full") return identifier.metadata;

  if (!opts.getPeerWire) {
    throw new Error(
      `Magnet ${identifier.infoHash} has no piece/file metadata and no getPeerWire was supplied to fetch it from a peer`
    );
  }
  const wire = await opts.getPeerWire();
  return fetchMetadataFromPeer(wire, identifier.infoHash);
};
