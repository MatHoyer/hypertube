import { formatUnknownError, hypertubeLogger } from "@hypertube/libs";
import * as net from "node:net";
import Wire from "bittorrent-protocol";

export interface SeedSource {
  hasPiece(index: number): boolean;
  readPieceRange(index: number, offset: number, length: number): Promise<Buffer>;
}

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
  private server: net.Server | null = null;

  constructor(peerId: string) {
    this.peerId = peerId;
  }

  register(infoHash: string, pieceCount: number, source: SeedSource): void {
    this.sources.set(infoHash.toLowerCase(), source);
    this.pieceCounts.set(infoHash.toLowerCase(), pieceCount);
  }

  unregister(infoHash: string): void {
    this.sources.delete(infoHash.toLowerCase());
    this.pieceCounts.delete(infoHash.toLowerCase());
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

  close(): void {
    this.server?.close();
    this.server = null;
  }

  private handleInbound(socket: net.Socket): void {
    const wire = new Wire();
    socket.pipe(wire).pipe(socket);
    socket.on("error", () => {
      // Swallowed deliberately: a dropped inbound connection is routine
      // swarm churn, not something the process needs to react to. wire's
      // own 'close'/timeout handling (via the piped socket ending) is what
      // actually releases this connection's resources.
    });

    let source: SeedSource | null = null;

    wire.once("handshake", (infoHash: string, _remotePeerId: string) => {
      const key = infoHash.toLowerCase();
      source = this.sources.get(key) ?? null;
      if (!source) {
        socket.destroy();
        return;
      }
      const pieceCount = this.pieceCounts.get(key) ?? 0;
      wire.handshake(infoHash, this.peerId);
      wire.bitfield(buildBitfield(source, pieceCount));
      wire.unchoke();
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
        source
          .readPieceRange(index, offset, length)
          .then((block) => cb(null, block))
          .catch((error: unknown) => {
            hypertubeLogger.warn(
              `Peer server failed to serve piece ${index} offset ${offset}: ${formatUnknownError(error)}`
            );
          });
      }
    );

    wire.on("error", () => {
      // Same reasoning as the socket 'error' listener above.
    });
  }
}
