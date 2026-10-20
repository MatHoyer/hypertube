/**
 * Narrow ambient types for the parse-torrent API surface this app actually
 * uses — it ships no first-party types. Extend this file rather than
 * reaching for a @types package (none exists) if more of the API is needed
 * later.
 */
declare module "parse-torrent" {
  export type ParsedTorrentFile = {
    path: string;
    name: string;
    length: number;
    offset: number;
  };

  export type ParsedTorrent = {
    infoHash: string;
    name?: string;
    /** BEP9 magnet convenience alias for `name` — set by magnet-uri, not present when parsed from a full .torrent buffer. */
    dn?: string;
    length?: number;
    pieceLength?: number;
    lastPieceLength?: number;
    /** Per-piece hex-encoded SHA1 hashes. Only populated when parsed from full .torrent info (absent for magnet links). */
    pieces?: string[];
    files?: ParsedTorrentFile[];
    /** Populated when parsed from a full .torrent buffer. */
    announce?: string[];
    /** Raw magnet `tr` param(s) — only present when parsed from a magnet URI; a single string or an array if repeated. */
    tr?: string | string[];
    urlList?: string[];
  };

  export default function parseTorrent(
    torrentId: string | Buffer
  ): Promise<ParsedTorrent>;
}
