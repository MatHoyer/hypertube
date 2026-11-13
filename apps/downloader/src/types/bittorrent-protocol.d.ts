/**
 * Narrow ambient types for the bittorrent-protocol/ut_metadata API surface
 * this app actually uses — neither package ships first-party types. Extend
 * these rather than reaching for @types/bittorrent-protocol (doesn't exist)
 * if more of the API is needed in later phases (piece requests, choke/
 * unchoke, extended handshake fields beyond ut_metadata).
 */
declare module "bittorrent-protocol" {
  import { Duplex } from "node:stream";

  export interface HandshakeExtensions {
    dht?: boolean;
    extended?: boolean;
    [key: string]: unknown;
  }

  export interface ExtendedHandshake {
    metadata_size?: number;
    [key: string]: unknown;
  }

  export interface WireBitField {
    get(index: number): boolean;
    buffer: Uint8Array;
  }

  export default class Wire extends Duplex {
    peerId: string | null;
    peerIdBuffer: Buffer | null;
    extended: boolean;
    extendedHandshake: ExtendedHandshake;
    destroyed: boolean;

    peerChoking: boolean;
    amChoking: boolean;
    peerInterested: boolean;
    amInterested: boolean;
    peerPieces: WireBitField;
    requests: { piece: number; offset: number; length: number }[];
    peerRequests: { piece: number; offset: number; length: number }[];

    handshake(
      infoHash: string | Buffer,
      peerId: string | Buffer,
      extensions?: HandshakeExtensions
    ): void;
    use(extension: (wire: Wire) => unknown): void;
    destroy(): void;
    setTimeout(ms: number, unref?: boolean): void;
    setKeepAlive(enable: boolean): void;

    choke(): void;
    unchoke(): void;
    interested(): void;
    uninterested(): void;
    have(index: number): void;
    bitfield(bitfield: Uint8Array): void;
    request(
      index: number,
      offset: number,
      length: number,
      cb: (err: Error | null, block: Buffer) => void
    ): void;
    cancel(index: number, offset: number, length: number): void;

    on(event: "handshake", listener: (infoHash: string, peerId: string, extensions: HandshakeExtensions) => void): this;
    on(event: "extended", listener: (ext: string, buf: Buffer) => void): this;
    on(event: "choke" | "unchoke" | "interested" | "uninterested" | "timeout" | "keep-alive" | "close", listener: () => void): this;
    on(event: "bitfield", listener: (bitfield: WireBitField) => void): this;
    on(event: "have", listener: (index: number) => void): this;
    on(event: "request", listener: (index: number, offset: number, length: number, cb: (err: Error | null, block: Buffer) => void) => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
    once(event: "handshake", listener: (infoHash: string, peerId: string, extensions: HandshakeExtensions) => void): this;
    once(event: string, listener: (...args: unknown[]) => void): this;
  }
}

declare module "ut_metadata" {
  import type { EventEmitter } from "node:events";
  import type Wire from "bittorrent-protocol";

  export interface UtMetadata extends EventEmitter {
    metadata: Buffer | undefined;
    /** Ask the peer to start sending us metadata pieces (BEP 9). No-op if we already have it or the peer doesn't support the extension. */
    fetch(): void;
    cancel(): void;
    on(event: "metadata", listener: (metadata: Buffer) => void): this;
    on(event: "warning", listener: (err: Error) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }

  /** Extension factory passed to `wire.use(...)`. Pass known metadata (a full .torrent buffer or bare info-dict) to make it available to peers that ask us. */
  export default function utMetadata(metadata?: Buffer): (wire: Wire) => UtMetadata;
}
