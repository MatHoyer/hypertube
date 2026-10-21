import { formatUnknownError, hypertubeLogger } from "@hypertube/libs";
import { EventEmitter } from "node:events";
import * as net from "node:net";
import Wire from "bittorrent-protocol";
import utMetadata from "ut_metadata";
import type { PeerAddress, PeerDiscovery } from "./peer-discovery.js";

const CONNECT_TIMEOUT_MS = 10000;
const HANDSHAKE_TIMEOUT_MS = 10000;
/** A connected, unchoking peer that stops answering block requests would otherwise hold its in-flight pieces forever. */
const REQUEST_TIMEOUT_MS = 30000;
/** Per BitTorrent wire protocol convention (BEP 3): 16KB, the block size virtually every client uses/expects for piece requests. */
export const BLOCK_LENGTH = 16 * 1024;

/**
 * One TCP connection to a peer, wrapped in the BitTorrent wire protocol —
 * either dialed out (connect) or accepted by PeerServer and handed over
 * (fromInbound); this module never listens itself. Piece selection/requesting
 * strategy lives in piece-manager.ts (Phase 4); this class only exposes the
 * wire mechanics (handshake, choke state, block requests) that piece-manager
 * drives.
 */
export class PeerConnection extends EventEmitter {
  readonly address: PeerAddress;
  readonly wire: Wire;
  private socket: net.Socket | null = null;
  private destroyed = false;

  private constructor(address: PeerAddress, wire?: Wire) {
    super();
    this.address = address;
    this.wire = wire ?? new Wire();
    // Must be registered before the handshake: the extended handshake that
    // advertises ut_metadata goes out with it, and magnet starts need it.
    // An inbound wire arrives already handshaken (metadata is known by then).
    if (!wire) this.wire.use(utMetadata());
  }

  /** Wraps a peer that dialed us (already handshaken by PeerServer) so the piece manager can download from it too — most of a swarm sits behind NAT and can only reach us, never be dialed. */
  static fromInbound(socket: net.Socket, wire: Wire): PeerConnection {
    const connection = new PeerConnection(
      { host: socket.remoteAddress ?? "", port: socket.remotePort ?? 0 },
      wire
    );
    connection.socket = socket;
    socket.on("error", (err) => connection.forwardError(err));
    socket.on("close", () => {
      connection.destroy();
      connection.emit("close");
    });
    wire.on("error", (err) => connection.forwardError(err));
    connection.startRequestTimeouts();
    return connection;
  }

  private startRequestTimeouts(): void {
    this.wire.setKeepAlive(true);
    this.wire.setTimeout(REQUEST_TIMEOUT_MS);
    this.wire.on("timeout", () => this.destroy());
  }

  static async connect(
    address: PeerAddress,
    infoHash: string,
    peerId: string
  ): Promise<PeerConnection> {
    const connection = new PeerConnection(address);
    await connection.open(infoHash, peerId);
    return connection;
  }

  private open(infoHash: string, peerId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({
        host: this.address.host,
        port: this.address.port,
      });
      this.socket = socket;
      socket.setTimeout(CONNECT_TIMEOUT_MS);

      const settleTimeout = setTimeout(() => {
        settle(
          new Error(
            `Handshake timeout with ${this.address.host}:${this.address.port}`
          )
        );
      }, CONNECT_TIMEOUT_MS + HANDSHAKE_TIMEOUT_MS);

      let settled = false;
      const settle = (err: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(settleTimeout);
        socket.removeListener("connect", onConnect);
        socket.removeListener("timeout", onSocketTimeout);
        this.wire.removeListener("handshake", onHandshake);
        // onSocketError deliberately NOT removed here — it stays attached
        // for the connection's whole lifetime, forwarding post-handshake
        // errors via this.emit("error", ...) once settled is true.
        if (err) {
          this.destroy();
          reject(err);
        } else {
          socket.setTimeout(0);
          this.startRequestTimeouts();
          resolve();
        }
      };

      const onConnect = () => {
        this.wire.handshake(infoHash, peerId);
      };
      const onHandshake = (remoteInfoHash: string) => {
        if (remoteInfoHash.toLowerCase() !== infoHash.toLowerCase()) {
          settle(
            new Error(
              `Peer ${this.address.host}:${this.address.port} handshake infoHash mismatch`
            )
          );
          return;
        }
        settle(null);
      };
      const onSocketTimeout = () =>
        settle(
          new Error(
            `Connect timeout to ${this.address.host}:${this.address.port}`
          )
        );
      // Single handler for the socket's whole lifetime, not a once+on pair:
      // both would fire for the same emitted 'error' (once-listeners don't
      // suppress other listeners on the same event), and forwarding to
      // this.emit("error", ...) before anything is listening on the
      // PeerConnection itself throws — EventEmitter special-cases 'error'
      // with zero listeners as an uncaught exception. Observed live: this
      // crashed the whole downloader process on a peer connect ECONNRESET.
      const onSocketError = (err: Error) => {
        if (!settled) {
          settle(err);
          return;
        }
        this.forwardError(err);
      };

      socket.once("connect", onConnect);
      socket.on("error", onSocketError);
      socket.once("timeout", onSocketTimeout);
      this.wire.once("handshake", onHandshake);

      socket.pipe(this.wire).pipe(socket);

      // Only relevant post-handshake — pre-handshake failures settle() the
      // connect() promise instead via the listeners above.
      socket.on("close", () => {
        // An abrupt close doesn't end the piped wire, which would leave its
        // pending block requests unanswered — destroy() fails them.
        this.destroy();
        if (settled) this.emit("close");
      });
      this.wire.on("error", (err) => {
        if (settled) this.forwardError(err);
      });
    });
  }

  /**
   * Consumers (PeerConnectionPool, PieceManager) attach a `.once("error", ...)`
   * — enough for the first error a connection ever has, but not a second
   * one after that listener's already fired and self-removed. Emitting
   * "error" with zero listeners throws (Node special-cases it), so this
   * falls back to a plain log instead of emit when nobody's listening, and
   * always tears the connection down rather than leaving a half-dead
   * socket free to emit more surprises later.
   */
  private forwardError(err: Error): void {
    if (this.listenerCount("error") > 0) {
      this.emit("error", err);
    } else {
      hypertubeLogger.warn(
        `Unhandled error on connection to ${this.address.host}:${this.address.port}: ${formatUnknownError(err)}`
      );
    }
    this.destroy();
  }

  requestBlock(index: number, offset: number, length: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (this.destroyed) {
        reject(new Error(`requestBlock on destroyed connection to ${this.address.host}:${this.address.port}`));
        return;
      }
      this.wire.request(index, offset, length, (err, block) => {
        if (err) reject(err);
        else resolve(block);
      });
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.wire.destroy();
    this.socket?.destroy();
  }
}

export type PeerConnectionPoolOptions = {
  infoHash: string;
  peerId: string;
  discovery: PeerDiscovery;
  /** Max simultaneous dial-outs/open connections — bounds process load regardless of how many candidates discovery hands us. */
  concurrency?: number;
};

const DEFAULT_CONCURRENCY = 30;
const REFRESH_MIN_INTERVAL_MS = 15000;
const PUMP_INTERVAL_MS = 30000;

/**
 * Dials candidates handed out by a PeerDiscovery pool, bounded to
 * `concurrency` simultaneous connections. When a connection drops or fails,
 * frees its slot and pulls the next queued candidate; when the candidate
 * queue itself runs dry, asks discovery to refresh (rate-limited so a
 * scarce swarm doesn't hammer trackers/DHT every tick).
 */
export class PeerConnectionPool extends EventEmitter {
  private readonly infoHash: string;
  private readonly peerId: string;
  private readonly discovery: PeerDiscovery;
  private readonly concurrency: number;
  private readonly queue: PeerAddress[] = [];
  /** Reserved while a dial is in flight — not yet handshaken, but already counted against `concurrency` so we don't over-dial. */
  private readonly pending = new Set<string>();
  private readonly active = new Map<string, PeerConnection>();
  private lastRefreshAt = 0;
  private destroyed = false;
  /** pump() otherwise only runs on dial/close events — a pool whose few peers stay connected would never ask discovery for more. */
  private readonly pumpTimer = setInterval(() => this.pump(), PUMP_INTERVAL_MS);

  constructor({
    infoHash,
    peerId,
    discovery,
    concurrency = DEFAULT_CONCURRENCY,
  }: PeerConnectionPoolOptions) {
    super();
    this.infoHash = infoHash;
    this.peerId = peerId;
    this.discovery = discovery;
    this.concurrency = concurrency;
    discovery.on("peer", (peer) => this.enqueue(peer));
  }

  private enqueue(peer: PeerAddress): void {
    if (this.destroyed) return;
    this.queue.push(peer);
    this.pump();
  }

  private get inFlight(): number {
    return this.pending.size + this.active.size;
  }

  /** Connections already handshaken — for consumers that start listening for 'wire' after some peers connected. */
  get connections(): PeerConnection[] {
    return [...this.active.values()];
  }

  /** Currently connected (post-handshake) peer count — for progress/stall reporting. */
  get connectionCount(): number {
    return this.active.size;
  }

  private pump(): void {
    while (
      !this.destroyed &&
      this.inFlight < this.concurrency &&
      this.queue.length > 0
    ) {
      const peer = this.queue.shift();
      if (!peer) break;
      const key = `${peer.host}:${peer.port}`;
      if (this.pending.has(key) || this.active.has(key)) continue;
      this.pending.add(key);
      this.dial(peer, key);
    }

    if (this.queue.length === 0 && this.inFlight < this.concurrency) {
      const now = Date.now();
      if (now - this.lastRefreshAt > REFRESH_MIN_INTERVAL_MS) {
        this.lastRefreshAt = now;
        this.discovery.refresh();
      }
    }
  }

  private async dial(peer: PeerAddress, key: string): Promise<void> {
    try {
      const connection = await PeerConnection.connect(
        peer,
        this.infoHash,
        this.peerId
      );
      this.pending.delete(key);
      if (this.destroyed) {
        connection.destroy();
        return;
      }
      this.active.set(key, connection);
      connection.once("close", () => this.retire(key, peer));
      connection.once("error", () => this.retire(key, peer));
      this.emit("wire", connection);
    } catch (error) {
      hypertubeLogger.warn(
        `Peer connect failed ${key}: ${formatUnknownError(error)}`
      );
      this.pending.delete(key);
      this.pump();
    }
  }

  /** Takes an inbound connection into the pool, so it's offered to the piece manager like a dialed one. */
  adopt(connection: PeerConnection): void {
    if (this.destroyed) return;
    const key = `${connection.address.host}:${connection.address.port}`;
    if (this.active.has(key)) return;
    this.active.set(key, connection);
    connection.once("close", () => this.retire(key, connection.address));
    connection.once("error", () => this.retire(key, connection.address));
    this.emit("wire", connection);
  }

  private retire(key: string, peer: PeerAddress): void {
    if (!this.active.delete(key)) return;
    this.emit("wireClosed", peer);
    this.pump();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    clearInterval(this.pumpTimer);
    this.queue.length = 0;
    this.pending.clear();
    for (const connection of this.active.values()) {
      connection.destroy();
    }
    this.active.clear();
  }
}
