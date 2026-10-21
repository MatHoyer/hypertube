# Self-built torrent engine + S3 seeding architecture

Replaces the earlier WebTorrent-based design (itself a replacement for the original
Transmission daemon). A library that assembles a torrent into a playable stream in one
call (`webtorrent`, `pulsar`, `peerflix`) is off the table, so the engine — piece
manager, peer connection pool, tracker/DHT discovery, inbound seeding — is project code,
built on low-level protocol libraries only (`parse-torrent`, `bittorrent-tracker`,
`bittorrent-dht`, `bittorrent-protocol`, `ut_metadata`). This ADR records the decisions
that carried over unchanged from the WebTorrent design (A, B) and the ones the new engine
required (C, D).

## Package surface

None of `parse-torrent`, `bittorrent-tracker`, `bittorrent-dht`, `bittorrent-protocol`, or
`ut_metadata` ship first-party TypeScript types. Ambient declarations for the narrow slice
each one actually needs live in `apps/downloader/src/types/` (`parse-torrent.d.ts`,
`bittorrent-protocol.d.ts`, `bittorrent-discovery.d.ts`) — extend those rather than adding
a stale/mismatched `@types` package. The engine itself is pure JS, but
`bittorrent-tracker` transitively imports `node-datachannel` (via `simple-peer` for
WebSocket/WebRTC trackers), a native addon — it stays in `pnpm-workspace.yaml`'s
`onlyBuiltDependencies` or the downloader crashes on import.

## Engine module map (`apps/downloader/src/handlers/movie/torrent/`)

| Module | Role |
|---|---|
| `metadata.ts` | Parse a `.torrent` buffer or magnet URI locally; for magnet-only starts, fetch the info dict from a peer via BEP 9 (`ut_metadata`) |
| `peer-discovery.ts` | Merge tracker announces + DHT lookups into a deduped peer-address pool |
| `peer-connection.ts` | Dial peers, BitTorrent handshake, bounded-concurrency connection pool |
| `piece-manager.ts` | Assign needed pieces to unchoked peers, verify SHA1, write to target file(s) |
| `piece-ranges.ts` | Pure piece/file byte-range math shared by piece-manager and seed reconciliation |
| `piece-store.ts` | Durable S3-backed piece persistence + self-verify-on-resume |
| `peer-server.ts` | Inbound connection listener — answers peer requests, i.e. seeding |
| `select-target-files.ts` | Picks the video file + sidecar subtitles out of a torrent's file list |
| `engine.ts` | Facade tying all of the above together for `movie-downloader.ts` |

## Decision A — remux vs. transcode

Always transcoding is expensive and lossy for the common case (torrent releases that are
already h264/aac in an mkv/avi container). We ffprobe the downloaded source file (see
Decision B for why it's a local file, not a live pipe, by the time we probe it) and branch:

| video codec | audio codec | ffmpeg output options |
|---|---|---|
| `h264` | none, or `aac` | `-c:v copy -c:a copy` (or drop the audio map if there's no audio stream) — pure remux |
| `h264` | present, not `aac` | `-c:v copy -c:a aac` — video remuxed, audio transcoded |
| anything else (`hevc`, `vp9`, `mpeg4`, ...) | any | `-c:v libx264 -c:a aac` — full transcode |

All three branches still target `mp4` with `-movflags +faststart` (Decision B) and keep the
existing `-map 0:v:0 -map 0:a:0?` stream selection. Unaffected by the torrent engine swap —
this logic lives entirely in `movie-downloader.ts`'s ffmpeg calls, downstream of however the
source file got onto local disk.

## Decision B — moov atom placement

Chosen: **local scratch file, not fragmented MP4.**

A muxer writes `moov` at the end of the file unless the output is seekable (so ffmpeg can
seek back and prepend it after encoding) or the file is written fragmented
(`frag_keyframe+empty_moov+default_base_moof`). We rejected fragmented MP4 for two reasons:

1. `apps/client` documents no explicit minimum browser/Safari-iOS baseline, so we can't
   verify fragmented MP4's progressive-download/Range behavior is safe on every target
   browser. Faststart MP4 on a plain byte-range object is universally supported; fragmented
   MP4 playback-via-Range has known rough edges on some Safari/iOS versions.
2. Independent of moov placement, ffprobe/ffmpeg need a **seekable** input to reliably
   detect and decode arbitrary source containers. This forces a seekable local file for the
   *source* side regardless; reusing the same mechanism for the *output* side (write to a
   local temp file, run ffmpeg with `-movflags +faststart`, then upload the finished file)
   costs nothing extra.

Concretely, per download job:

```
piece-manager writes target file(s) directly to scratch, at each file's own byte offset
                                     →  local scratch "source" file (no separate
                                                                       materialization step —
                                                                       piece-manager already
                                                                       produces the exact
                                                                       final bytes in place)
ffprobe(source)                     →  codec decision matrix (Decision A)
ffmpeg(source → converted, +faststart) → local scratch "converted" file
storageService.putObject(converted) →  movies bucket
rm scratch dir (source + converted)
```

This is simpler than the WebTorrent-era pipeline, which needed an explicit
`materializeToLocalFile` copy step (`TorrentFile#createReadStream()` → local file) because
WebTorrent's own file abstraction sat between the chunk store and anything reading it. The
new piece manager writes straight to the file path the caller gives it — there's nothing to
copy from.

## Decision C — durable resume (S3-backed piece store)

Local scratch is ephemeral (deleted after every job), but a container/process restart
mid-download shouldn't force a full re-download. `piece-store.ts` persists every
hash-verified piece to S3 under `torrent-pieces/<infoHash>/<pieceIndex>` (bucket
`BUCKETS.TORRENT_PIECES`) — the same layout the old WebTorrent-era `S3ChunkStore` used,
though this is a plain read/write store now, not an `abstract-chunk-store` implementation
(WebTorrent's `Torrent#_verifyPieces` self-verified on load automatically; this engine's
piece manager does the equivalent self-verify itself, explicitly, in
`PieceManager.start()`).

On start, `PieceStore.findVerifiedPieces` lists what's already in S3 for the infoHash and
SHA1-verifies each one against the torrent's known-good hash before trusting it — a
corrupted or partial object just gets left "not verified" and re-downloaded from peers
normally, no separate length check needed. Every piece downloaded fresh from a peer during
this run is written back to S3 too (best-effort: a store-write failure just means that one
piece re-downloads on a future restart, not a fatal error for the current one).

**Storage layout / cost caveat carried over unchanged**: bucket `torrent-pieces`, one
object per piece. A movie-sized torrent has a piece length of roughly 256KB–8MB, so a full
download is hundreds to low-thousands of S3 objects — acceptable request/storage cost,
scoped to single-movie-file torrents (this app's only case). Cleanup of the
`torrent-pieces/<infoHash>/` prefix is **not** done by the piece store or the piece
manager — the monthly cleanup cron (`packages/server-core/src/crons/deleteMoviesMonthly.ts`) owns deleting it, same convention the
WebTorrent-era `S3ChunkStore.destroy` documented.

## Decision D — seeding (inbound peer server)

A pure leech (dial-out only, never accept inbound connections) would be simpler to build,
but seeding matters for swarm health — this app should give back to the swarms it pulls
from, not just take. `peer-server.ts` runs one `net.Server` per process (on the same
VPN-forwarded port used to advertise to trackers, see `listen-port.ts`), accepts inbound
sockets, and answers `bitfield`/`request` messages for whatever infoHashes are currently
registered against it.

Any `SeedSource` (an object with `hasPiece(index)` / `readPieceRange(index, offset,
length)`) can be registered — `PieceManager` implements the interface directly, so a
download registers as seedable the moment it starts, not just once it finishes; peers can
pull already-verified pieces from us mid-download. While a download is in progress it also
registers an inbound-peer callback: the server wraps each inbound connection as a
`PeerConnection` (`fromInbound`) and hands it to that torrent's pool (`adopt`), so we
download from peers that dialed us too — most of a swarm is behind NAT and can't be dialed.
Once the download finishes the pool (and those adopted connections) is torn down, and
later inbound connections are seed-only. `engine.ts`'s `resumeSeeding` builds a
lighter `StaticSeedSource` (backed directly by `PieceStore`, no live peer connections at
all) for `seed-reconciliation.ts` to re-attach every still-retained, fully-downloaded
resolution on worker boot — mirrors the WebTorrent-era reconciliation's self-healing
property (nothing that should stop seeding survives a restart; nothing that should keep
seeding needs the original download's worker instance to stay alive), but does it without
any peer discovery/dialing for a source that's already fully verified — the durable store
alone is enough to answer requests.

**Deliberately simple** (both consistent with the roadmap's "simple selection strategy is
fine" scope, and possible future hardening if swarm behavior in practice calls for it):

- No choking algorithm/tit-for-tat — every interested peer is unchoked immediately.
- The bitfield sent at handshake is a one-time snapshot, not live-updated with `have`
  messages as more pieces verify mid-connection.
- A peer requesting a piece we don't have is simply never answered (no `reject` message) —
  their own request timeout handles it.

**Cross-process stop-seeding**: unchanged shape from the WebTorrent era. The scheduler's
monthly cleanup cron deletes the DB rows, the `movies` bucket objects, and the
`torrent-pieces/<infoHash>/` prefix, then enqueues one `STOP_SEEDING` job per infoHash. The
downloader worker handles it via `engine.destroy(infoHash)`, which unregisters from the
peer server (and tears down any still-live discovery/pool/piece-manager) — it does not
also delete S3 objects, since the scheduler already did.
