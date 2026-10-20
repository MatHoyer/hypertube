import { formatUnknownError, hypertubeLogger } from "@hypertube/libs";
import { EventEmitter } from "node:events";
import TrackerClient from "bittorrent-tracker";
import DHT, { type DHTPeer } from "bittorrent-dht";

export type PeerAddress = { host: string; port: number };

export type PeerDiscoveryOptions = {
  infoHash: string;
  /** Announce URLs from the parsed torrent/magnet — may be empty (magnet with no trackers), in which case DHT carries the whole load. */
  announce: string[];
  peerId: string;
  /** Port we advertise to trackers as our listening port, and the same port the shared DHT node binds its UDP socket to — one port for both, forwarded once by the VPN, matching standard BitTorrent client convention. */
  port: number;
  /** Stop accepting newly-discovered candidates once the deduped pool reaches this size — a large swarm would otherwise grow the pool unbounded for the life of the download. Peer connection concurrency is a separate, usually smaller, concern (see peer-connection.ts). */
  maxPeers?: number;
  useDht?: boolean;
};

const DEFAULT_MAX_PEERS = 200;

/** Splits a tracker "peer" event's "host:port" string. IPv6 literals aren't a concern here — all trackers/peers this app talks to are plain IPv4. */
const parseAddr = (addr: string): PeerAddress | null => {
  const separatorIndex = addr.lastIndexOf(":");
  if (separatorIndex === -1) return null;
  const host = addr.slice(0, separatorIndex);
  const port = Number.parseInt(addr.slice(separatorIndex + 1), 10);
  if (!host || !Number.isFinite(port) || port <= 0) return null;
  return { host, port };
};

let sharedDhtPromise: Promise<DHT> | null = null;

/**
 * One DHT node for the whole process, shared by every torrent's
 * PeerDiscovery — a torrent-per-node design would need its own UDP port
 * each (EADDRINUSE past the first, if pinned to the same forwarded port
 * the roadmap calls for), and wastes a routing table per torrent for no
 * benefit: bittorrent-dht's 'peer' events already carry the infoHash they
 * belong to, so one shared node can fan out lookups for as many torrents
 * as are active at once.
 */
const getSharedDht = (port: number): Promise<DHT> => {
  if (!sharedDhtPromise) {
    sharedDhtPromise = new Promise<DHT>((resolve) => {
      const dht = new DHT();
      dht.on("error", (err) => {
        hypertubeLogger.error(`DHT error: ${formatUnknownError(err)}`);
      });
      dht.listen(port, () => resolve(dht));
    }).catch((error: unknown) => {
      sharedDhtPromise = null;
      throw error;
    });
  }
  return sharedDhtPromise as Promise<DHT>;
};

/**
 * Merges tracker announces and DHT lookups into one deduped peer pool,
 * emitting 'peer' once per newly-seen address until the cap is hit. Peer
 * connection dial-out and retry-on-disconnect (pulling the next candidate)
 * is peer-connection.ts's job — this module only ever discovers and
 * forwards, it doesn't track connection state.
 */
export class PeerDiscovery extends EventEmitter {
  private readonly infoHash: string;
  private readonly seen = new Set<string>();
  private readonly tracker: TrackerClient | null;
  private readonly useDht: boolean;
  private dht: DHT | null = null;
  private readonly onDhtPeer = (
    peer: DHTPeer,
    peerInfoHash: string | Buffer
  ): void => {
    const peerInfoHashHex = Buffer.isBuffer(peerInfoHash)
      ? peerInfoHash.toString("hex")
      : peerInfoHash;
    if (peerInfoHashHex.toLowerCase() === this.infoHash.toLowerCase()) {
      this.handleCandidate(peer);
    }
  };
  private readonly maxPeers: number;
  private destroyed = false;

  constructor({
    infoHash,
    announce,
    peerId,
    port,
    maxPeers = DEFAULT_MAX_PEERS,
    useDht = true,
  }: PeerDiscoveryOptions) {
    super();
    this.infoHash = infoHash;
    this.maxPeers = maxPeers;
    this.useDht = useDht;

    this.tracker =
      announce.length > 0
        ? new TrackerClient({ infoHash, peerId, announce, port })
        : null;
    if (this.tracker) {
      this.tracker.on("peer", (addr) => this.handleCandidate(addr));
      this.tracker.on("warning", (err) => {
        hypertubeLogger.warn(
          `Tracker warning for ${infoHash}: ${formatUnknownError(err)}`
        );
      });
      this.tracker.on("error", (err) => {
        hypertubeLogger.error(
          `Tracker error for ${infoHash}: ${formatUnknownError(err)}`
        );
      });
      this.tracker.start();
    }

    if (useDht) {
      getSharedDht(port)
        .then((dht) => {
          if (this.destroyed) return;
          this.dht = dht;
          dht.on("peer", this.onDhtPeer);
          dht.lookup(infoHash, (err) => {
            if (err) {
              hypertubeLogger.warn(
                `DHT lookup failed for ${infoHash}: ${formatUnknownError(err)}`
              );
            }
          });
        })
        .catch((err: unknown) => {
          hypertubeLogger.error(
            `Failed to start DHT for ${infoHash}: ${formatUnknownError(err)}`
          );
        });
    }
  }

  private handleCandidate(candidate: PeerAddress | string): void {
    if (this.destroyed || this.seen.size >= this.maxPeers) return;
    const peer =
      typeof candidate === "string" ? parseAddr(candidate) : candidate;
    if (!peer) return;

    const key = `${peer.host}:${peer.port}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.emit("peer", peer);
  }

  /** Re-announces to trackers and re-runs a DHT lookup — use when the connection pool is starved for candidates (e.g. every existing peer disconnected). */
  refresh(infoHash: string): void {
    if (this.destroyed) return;
    this.tracker?.update();
    this.dht?.lookup(infoHash);
  }

  /** Tears down this torrent's own tracker client and DHT listener/lookup — never destroys the shared DHT node itself, since other torrents may still be using it. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.tracker?.destroy();
    if (this.useDht) this.dht?.removeListener("peer", this.onDhtPeer);
  }
}
