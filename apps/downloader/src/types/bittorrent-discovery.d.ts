/**
 * Narrow ambient types for the bittorrent-tracker/bittorrent-dht API surface
 * this app actually uses — neither ships first-party types.
 */
declare module "bittorrent-tracker" {
  import { EventEmitter } from "node:events";

  export interface ClientOpts {
    infoHash: string | Uint8Array;
    peerId: string | Uint8Array;
    announce: string[];
    port: number;
    userAgent?: string;
    getAnnounceOpts?: () => Record<string, unknown>;
  }

  export interface AnnounceUpdate {
    announce: string;
    complete: number;
    incomplete: number;
  }

  export default class Client extends EventEmitter {
    constructor(opts: ClientOpts);
    infoHash: string;
    peerId: string;
    destroyed: boolean;
    start(opts?: Record<string, unknown>): void;
    stop(opts?: Record<string, unknown>): void;
    update(opts?: Record<string, unknown>): void;
    complete(opts?: Record<string, unknown>): void;
    destroy(cb?: () => void): void;

    on(event: "peer", listener: (addr: string) => void): this;
    on(event: "update", listener: (data: AnnounceUpdate) => void): this;
    on(event: "warning", listener: (err: Error) => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }
}

declare module "bittorrent-dht" {
  import { EventEmitter } from "node:events";

  export interface DHTOpts {
    bootstrap?: string[] | boolean;
  }

  export interface DHTPeer {
    host: string;
    port: number;
  }

  export interface DHTAddress {
    address: string;
    family: string;
    port: number;
  }

  export default class DHT extends EventEmitter {
    constructor(opts?: DHTOpts);
    destroyed: boolean;
    listen(onlistening?: () => void): void;
    listen(port?: number, onlistening?: () => void): void;
    listen(port?: number, address?: string, onlistening?: () => void): void;
    lookup(
      infoHash: string | Uint8Array,
      callback?: (err: Error | null, numFound: number) => void
    ): { abort: () => void };
    address(): DHTAddress;
    destroy(cb?: () => void): void;

    on(
      event: "peer",
      listener: (peer: DHTPeer, infoHash: string, from: DHTAddress) => void
    ): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: "listening", listener: () => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }
}
