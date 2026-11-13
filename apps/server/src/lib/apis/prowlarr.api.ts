import {
  formatUnknownError,
  hypertubeLogger,
  TMovieSchema,
  TMovieTorrentSchema,
  TResolutionSchema,
  ytsQualities,
} from "@hypertube/libs";
import { BUCKETS, env, getStoragePath } from "@hypertube/server-core";
import { container } from "../../container";

type YtsQuality = (typeof ytsQualities)[number];

type ProwlarrRelease = {
  title: string;
  downloadUrl?: string;
  magnetUrl?: string;
  size: number;
  infoHash: string;
  seeders: number;
  indexer: string;
  indexerId: number;
  guid: string;
};

type NormalizedRelease = Omit<ProwlarrRelease, "downloadUrl" | "magnetUrl"> & {
  downloadUrl: string;
  magnetUrl?: string;
};

type ParsedRelease = NormalizedRelease & {
  quality: YtsQuality;
};

export type ProwlarrMovieSearch = {
  imdbId: string;
  tmdbId?: number;
  title: string;
  year: number;
};

const MOVIE_CATEGORIES = [
  "2000",
  "2010",
  "2020",
  "2030",
  "2040",
  "2045",
  "2050",
  "2060",
];

const QUALITY_PATTERNS: { quality: YtsQuality; pattern: RegExp }[] = [
  { quality: "3D", pattern: /\b3D\b/i },
  { quality: "2160p", pattern: /\b(2160p|4K|UHD)\b/i },
  {
    quality: "1080p.x265",
    pattern: /\b1080p\b.*\b(x265|hevc|h\.?265)\b/i,
  },
  {
    quality: "1080p.x265",
    pattern: /\b(x265|hevc|h\.?265)\b.*\b1080p\b/i,
  },
  { quality: "1080p", pattern: /\b1080p\b/i },
  { quality: "720p", pattern: /\b720p\b/i },
  { quality: "480p", pattern: /\b(480p|576p)\b/i },
];

const SOURCE_QUALITY_HINTS: { quality: YtsQuality; pattern: RegExp }[] = [
  { quality: "1080p.x265", pattern: /\b(x265|hevc|h\.?265)\b/i },
  { quality: "1080p", pattern: /\b(bluray|bdrip|brrip|web-?dl|webdl)\b/i },
  { quality: "720p", pattern: /\b(webrip|hdtv|dvdrip)\b/i },
  { quality: "480p", pattern: /\b(cam|hdcam|telesync|ts|dvdscr)\b/i },
];

const isMagnetLink = (url: string): boolean => url.trim().startsWith("magnet:");

const MAGNET_PREFERRED_INDEXERS = [/pirate\s*bay/i, /\btpb\b/i];

const buildMagnetFromInfoHash = (infoHash: string, title: string): string =>
  `magnet:?xt=urn:btih:${infoHash.trim().toLowerCase()}&dn=${encodeURIComponent(title)}`;

const prefersMagnetLink = (indexer: string): boolean =>
  MAGNET_PREFERRED_INDEXERS.some((pattern) => pattern.test(indexer));

const formatBytes = (bytes: number): string => {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(2)} MB`;
  return `${(bytes / 1e3).toFixed(2)} KB`;
};

const parseQuality = (title: string): YtsQuality | null => {
  for (const { quality, pattern } of QUALITY_PATTERNS) {
    if (pattern.test(title)) return quality;
  }
  for (const { quality, pattern } of SOURCE_QUALITY_HINTS) {
    if (pattern.test(title)) return quality;
  }
  return null;
};

const normalizeRelease = (
  release: ProwlarrRelease
): NormalizedRelease | null => {
  const downloadUrl = release.downloadUrl ?? release.magnetUrl;
  if (!downloadUrl || !release.indexer) return null;
  return {
    title: release.title,
    size: release.size,
    infoHash: release.infoHash,
    seeders: release.seeders,
    indexer: release.indexer,
    indexerId: release.indexerId,
    guid: release.guid,
    downloadUrl,
    magnetUrl: release.magnetUrl,
  };
};

const parseRelease = (release: ProwlarrRelease): ParsedRelease | null => {
  const normalized = normalizeRelease(release);
  if (!normalized) return null;
  const quality = parseQuality(normalized.title);
  if (!quality) return null;
  return { ...normalized, quality };
};

const pickBestPerQualityPerIndexer = (
  items: ParsedRelease[]
): ParsedRelease[] => {
  const byKey = new Map<string, ParsedRelease>();

  for (const item of items) {
    const key = `${item.quality}::${item.indexer}`;
    const existing = byKey.get(key);
    if (!existing || item.seeders > existing.seeders) {
      byKey.set(key, item);
    }
  }

  return [...byKey.values()];
};

export class ProwlarrApi {
  private readonly baseUrl: string;

  constructor() {
    this.baseUrl = env.PROWLARR_URL.replace(/\/$/, "");
  }

  private buildSearchUrl(query: string, type: "movie" | "search"): string {
    const params = new URLSearchParams({
      query,
      type,
    });

    for (const category of MOVIE_CATEGORIES) {
      params.append("categories", category);
    }

    const indexerIds = env.PROWLARR_INDEXER_IDS.split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    for (const id of indexerIds) {
      params.append("indexerIds", id);
    }

    return `${this.baseUrl}/api/v1/search?${params}`;
  }

  private shouldRewriteToProwlarrBase(downloadUrl: string): boolean {
    if (isMagnetLink(downloadUrl)) return false;

    try {
      const url = new URL(downloadUrl);
      const base = new URL(this.baseUrl);
      if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
        return true;
      }
      return url.hostname === base.hostname;
    } catch {
      return false;
    }
  }

  private resolveDownloadUrl(downloadUrl: string): string {
    if (!this.shouldRewriteToProwlarrBase(downloadUrl)) return downloadUrl;

    try {
      const url = new URL(downloadUrl);
      const base = new URL(this.baseUrl);
      url.protocol = base.protocol;
      url.hostname = base.hostname;
      url.port = base.port;
      return url.toString();
    } catch {
      return downloadUrl;
    }
  }

  private async fetchTorrentFile(downloadUrl: string): Promise<Buffer> {
    const url = this.resolveDownloadUrl(downloadUrl);
    try {
      // Prowlarr answers magnet-only releases with a 301 to the magnet URI,
      // which fetch can't follow; elsewhere, don't forward the API key.
      let res = await fetch(url, {
        headers: { "X-Api-Key": env.PROWLARR_API_KEY },
        redirect: "manual",
      });
      const location = res.headers.get("location");
      if (location && isMagnetLink(location)) {
        return Buffer.from(location.trim(), "utf-8");
      }
      if (location) res = await fetch(new URL(location, url));
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return Buffer.from(await res.arrayBuffer());
    } catch (error) {
      throw new Error(
        `Failed to fetch torrent from ${url}: ${formatUnknownError(error)}`,
        { cause: error }
      );
    }
  }

  private resolveMagnetLink(release: ParsedRelease): string | null {
    if (release.magnetUrl && isMagnetLink(release.magnetUrl)) {
      return release.magnetUrl.trim();
    }
    if (isMagnetLink(release.downloadUrl)) {
      return release.downloadUrl.trim();
    }
    if (prefersMagnetLink(release.indexer) && release.infoHash) {
      return buildMagnetFromInfoHash(release.infoHash, release.title);
    }
    return null;
  }

  private async storeTorrentSource(
    objectPath: string,
    content: Buffer
  ): Promise<void> {
    await container.storageService.putObject(
      BUCKETS.MOVIES,
      objectPath,
      content
    );
  }

  private async fetchMovieReleases(
    imdbId: string,
    tmdbId?: number
  ): Promise<ProwlarrRelease[]> {
    const queries = [`{ImdbId:${imdbId}}`];
    if (tmdbId) queries.push(`{TmdbId:${tmdbId}}`);

    const results = await Promise.all(
      queries.map((query) => this.fetchReleases(query, "movie"))
    );
    return this.mergeReleases(results.flat());
  }

  private buildTextQueries(title: string, year: number): string[] {
    const queries = new Set<string>();
    const trimmed = title.trim();
    queries.add(`${trimmed} ${year}`);
    queries.add(`${trimmed.replace(/\s+/g, ".")}.${year}`);
    queries.add(
      `${trimmed.replace(/[^\w\s]/g, "").replace(/\s+/g, " ")} ${year}`
    );
    return [...queries];
  }

  private async fetchTextReleases(
    title: string,
    year: number
  ): Promise<ProwlarrRelease[]> {
    const results = await Promise.all(
      this.buildTextQueries(title, year).map((query) =>
        this.fetchReleases(query, "search")
      )
    );
    return this.mergeReleases(results.flat());
  }

  private async fetchReleases(
    query: string,
    type: "movie" | "search"
  ): Promise<ProwlarrRelease[]> {
    const response = await fetch(this.buildSearchUrl(query, type), {
      headers: { "X-Api-Key": env.PROWLARR_API_KEY },
    });
    if (!response.ok) {
      throw new Error(`Prowlarr search failed with status ${response.status}`);
    }
    return (await response.json()) as ProwlarrRelease[];
  }

  private mergeReleases(releases: ProwlarrRelease[]): ProwlarrRelease[] {
    const byGuid = new Map<string, ProwlarrRelease>();
    for (const release of releases) {
      byGuid.set(release.guid, release);
    }
    return [...byGuid.values()];
  }

  private async searchReleases({
    imdbId,
    tmdbId,
    title,
    year,
  }: ProwlarrMovieSearch): Promise<ParsedRelease[]> {
    try {
      const [imdbResults, textResults] = await Promise.all([
        this.fetchMovieReleases(imdbId, tmdbId),
        this.fetchTextReleases(title, year),
      ]);
      const releases = this.mergeReleases([...imdbResults, ...textResults]);
      const parsed = releases
        .map(parseRelease)
        .filter((item): item is ParsedRelease => item !== null);

      hypertubeLogger.info(
        `Prowlarr search for ${imdbId}: imdb=${imdbResults.length}, text=${textResults.length}, raw=${releases.length}, parsed=${parsed.length}, indexers=[${[...new Set(parsed.map((r) => r.indexer))].join(", ")}]`
      );

      return pickBestPerQualityPerIndexer(parsed);
    } catch (error) {
      hypertubeLogger.error(
        `Error searching Prowlarr: ${formatUnknownError(error)}`
      );
      return [];
    }
  }

  public async getResolutions(
    search: ProwlarrMovieSearch
  ): Promise<TMovieTorrentSchema[]> {
    const items = await this.searchReleases(search);
    return items.map((item) => ({
      quality: item.quality,
      size: formatBytes(item.size),
      url: item.downloadUrl,
      hash: item.infoHash,
      indexerName: item.indexer,
      indexerId: item.indexerId,
      releaseGuid: item.guid,
    }));
  }

  public async downloadTorrent({
    movie,
    resolution,
    resolutionId,
    search,
  }: {
    movie: TMovieSchema;
    resolution: TResolutionSchema;
    resolutionId: string;
    search: ProwlarrMovieSearch;
  }) {
    if (!movie.imdbId) throw new Error("Movie has no IMDB ID");

    const items = await this.searchReleases(search);
    const release =
      items.find((item) => item.guid === resolution.releaseGuid) ??
      items.find(
        (item) =>
          item.indexer === resolution.indexerName &&
          item.quality === resolution.resolution
      );
    if (!release) {
      throw new Error(
        `Resolution (${resolution.resolution}, ${resolution.indexerName}) not found for movie ${movie.imdbId}`
      );
    }

    const objectPath = getStoragePath(
      movie.tmdbId.toString(),
      "resolutions",
      resolutionId,
      "resolution.torrent"
    );

    const magnetLink = this.resolveMagnetLink(release);
    if (magnetLink) {
      hypertubeLogger.info(
        `Storing magnet link for ${movie.imdbId} (${resolution.resolution}, ${resolution.indexerName})`
      );
      await this.storeTorrentSource(
        objectPath,
        Buffer.from(magnetLink, "utf-8")
      );
      return;
    }

    try {
      const buffer = await this.fetchTorrentFile(release.downloadUrl);
      await this.storeTorrentSource(objectPath, buffer);
    } catch (error) {
      if (release.infoHash) {
        hypertubeLogger.warn(
          `Torrent fetch failed for ${movie.imdbId} (${resolution.resolution}, ${resolution.indexerName}), using infoHash magnet fallback`
        );
        await this.storeTorrentSource(
          objectPath,
          Buffer.from(
            buildMagnetFromInfoHash(release.infoHash, release.title),
            "utf-8"
          )
        );
        return;
      }

      hypertubeLogger.error(
        `Torrent download failed for ${movie.imdbId} (${resolution.resolution}, ${resolution.indexerName}): ${formatUnknownError(error)}`
      );
      throw new Error(
        `Failed to download torrent for movie ${movie.imdbId} (${resolution.resolution}, ${resolution.indexerName})`,
        { cause: error }
      );
    }
  }
}
