import { formatUnknownError, hypertubeLogger } from "@hypertube/libs";
import * as net from "node:net";
import Wire from "bittorrent-protocol";
import { BLOCK_LENGTH, PeerConnection } from "./peer-connection.js";

export interface SeedSource {
  hasPiece(index: number): boolean;
  /** Byte length of this piece — the last piece of a torrent is shorter, so this bounds what a peer may legitimately request. */
  pieceLength(index: number): number;
  readPieceRange(index: number, offset: number, length: number): Promise<Buffer>;
}

/** Hard ceiling on simultaneous inbound sockets across all seeded infoHashes — without it idle/never-handshaking peers exhaust file descriptors. */
const MAX_INBOUND_CONNECTIONS = 500;
/** Drop a socket that connects but never completes the BitTorrent handshake. */
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** Drop a handshaken peer that then goes silent, so a seed-only connection can't sit open forever. */
const IDLE_TIMEOUT_MS = 2 * 60_000;
/** Cap concurrent piece reads per peer — a peer pipelining thousands of requests would otherwise blow up memory and S3 connections. */
const MAX_CONCURRENT_READS_PER_WIRE = 8;

/**
 * A piece's worth of bits, MSB-first (BitTorrent wire format) — same layout
 * webtorrent.client.ts's buildVerifiedBitfield produces, built fresh from
 * whatever a SeedSource currently reports as done.
 */
const buildBitfield = (source: SeedSource, pieceCount: number): Uint8Array => {
  const bitfield = new Uint8Array(Math.ceil(pieceCount / 8));
  for (let index = 0; index < pieceCount; index++) {
    if (source.hasPiece(index)) bitfield[index >> 3] |= 0x80 >> index % 8;
  }
  return bitfield;
};

/**
 * Accepts inbound peer connections and serves whatever pieces we've
 * verified for the infoHashes we're currently registered as a source for —
 * this is what lets the process seed after (or during) a download, instead
 * of being a leech-only dial-out client. No choking algorithm/tit-for-tat:
 * every interested peer gets unchoked immediately, matching the "simple
 * strategy is fine" scope used throughout this engine. A peer requesting a
 * piece we don't (yet) have per hasPiece() is simply never answered — no
 * cb() call — rather than sent a reject; a well-behaved client's own
 * request timeout handles that.
 */
export class PeerServer {
  private readonly peerId: string;
  private readonly sources = new Map<string, SeedSource>();
  private readonly pieceCounts = new Map<string, number>();
  /** Set while a torrent is still downloading: inbound peers are handed over so we download from them too, not only seed to them. */
  private readonly onInboundPeer = new Map<string, (connection: PeerConnection) => void>();
  /** Handshaken inbound sockets per infoHash, so unregister can cut off peers already being served. */
  private readonly inboundSockets = new Map<string, Set<net.Socket>>();
  private server: net.Server | null = null;
  private inboundCount = 0;

  constructor(peerId: string) {
    this.peerId = peerId;
  }

  register(
    infoHash: string,
    pieceCount: number,
    source: SeedSource,
    onInboundPeer?: (connection: PeerConnection) => void
  ): void {
    const key = infoHash.toLowerCase();
    this.sources.set(key, source);
    this.pieceCounts.set(key, pieceCount);
    if (onInboundPeer) this.onInboundPeer.set(key, onInboundPeer);
    else this.onInboundPeer.delete(key);
  }

  unregister(infoHash: string): void {
    const key = infoHash.toLowerCase();
    this.sources.delete(key);
    this.pieceCounts.delete(key);
    this.onInboundPeer.delete(key);
    for (const socket of this.inboundSockets.get(key) ?? []) socket.destroy();
    this.inboundSockets.delete(key);
  }

  isRegistered(infoHash: string): boolean {
    return this.sources.has(infoHash.toLowerCase());
  }

  listInfoHashes(): string[] {
    return [...this.sources.keys()];
  }

  listen(port: number): Promise<void> {
    if (this.server) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.handleInbound(socket));
      const onListenError = (err: Error) => reject(err);
      server.once("error", onListenError);
      server.listen(port, () => {
        server.removeListener("error", onListenError);
        server.on("error", (err) => {
          hypertubeLogger.error(`Peer server error: ${formatUnknownError(err)}`);
        });
        this.server = server;
        resolve();
      });
    });
  }

  /** The port actually bound — what to advertise to trackers/DHT. */
  get port(): number {
    return (this.server?.address() as net.AddressInfo | null)?.port ?? 0;
  }

  close(): void {
    this.server?.close();
    this.server = null;
  }

  private handleInbound(socket: net.Socket): void {
    if (this.inboundCount >= MAX_INBOUND_CONNECTIONS) {
      socket.destroy();
      return;
    }
    this.inboundCount += 1;
    socket.once("close", () => {
      this.inboundCount -= 1;
    });

    // Starts as a handshake deadline; relaxed to an idle deadline once the
    // peer handshakes. Either way a silent socket is torn down, not leaked.
    socket.setTimeout(HANDSHAKE_TIMEOUT_MS);
    socket.on("timeout", () => socket.destroy());

    const wire = new Wire();
    socket.pipe(wire).pipe(socket);
    socket.on("error", () => {
      // Swallowed deliberately: a dropped inbound connection is routine
      // swarm churn, not something the process needs to react to. wire's
      // own 'close'/timeout handling (via the piped socket ending) is what
      // actually releases this connection's resources.
    });

    let source: SeedSource | null = null;
    let inFlightReads = 0;

    wire.once("handshake", (infoHash: string, _remotePeerId: string) => {
      const key = infoHash.toLowerCase();
      source = this.sources.get(key) ?? null;
      if (!source) {
        socket.destroy();
        return;
      }
      const sockets = this.inboundSockets.get(key) ?? new Set<net.Socket>();
      this.inboundSockets.set(key, sockets);
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      const pieceCount = this.pieceCounts.get(key) ?? 0;
      wire.handshake(infoHash, this.peerId);
      wire.bitfield(buildBitfield(source, pieceCount));
      wire.unchoke();
      const onInbound = this.onInboundPeer.get(key);
      if (onInbound) {
        // Adopted into the download pool, which installs its own wire-level
        // keep-alive/request timeout — the socket-level timer would conflict.
        socket.setTimeout(0);
        onInbound(PeerConnection.fromInbound(socket, wire));
      } else {
        socket.setTimeout(IDLE_TIMEOUT_MS);
      }
    });

    wire.on(
      "request",
      (
        index: number,
        offset: number,
        length: number,
        cb: (err: Error | null, block: Buffer) => void
      ) => {
        if (!source?.hasPiece(index)) return;
        // Validate against the peer's own (untrusted) offset/length: a zero
        // length makes an invalid S3 range (whole piece), and an oversized or
        // out-of-piece range wastes memory/bandwidth. BEP3: close the peer.
        if (
          length <= 0 ||
          length > BLOCK_LENGTH ||
          offset < 0 ||
          offset + length > source.pieceLength(index)
        ) {
          socket.destroy();
          return;
        }
        if (inFlightReads >= MAX_CONCURRENT_READS_PER_WIRE) return; // drop; peer's request timeout handles it
        inFlightReads += 1;
        source
          .readPieceRange(index, offset, length)
          .then((block) => cb(null, block))
          .catch((error: unknown) => {
            hypertubeLogger.warn(
              `Peer server failed to serve piece ${index} offset ${offset}: ${formatUnknownError(error)}`
            );
          })
          .finally(() => {
            inFlightReads -= 1;
          });
      }
    );

    wire.on("error", () => {
      // Same reasoning as the socket 'error' listener above.
    });
  }
}
