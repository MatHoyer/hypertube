import { isSidecarSubtitle } from "../download-torrent-subtitles.js";
import type { TorrentFileMeta } from "./metadata.js";

export const VIDEO_EXTENSIONS = [
  ".mp4",
  ".mkv",
  ".avi",
  ".m4v",
  ".webm",
  ".mov",
  ".wmv",
  ".flv",
  ".ts",
  ".m2ts",
];

const isVideoFile = (filename: string): boolean => {
  const lower = filename.toLowerCase();
  return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
};

const findMainVideoFile = (
  files: TorrentFileMeta[]
): TorrentFileMeta | undefined => {
  const videoFiles = files.filter((file) => isVideoFile(file.name));
  if (videoFiles.length === 0) return undefined;
  if (videoFiles.length === 1) return videoFiles[0];

  return videoFiles.reduce((largest, file) =>
    file.length > largest.length ? file : largest
  );
};

export type SelectedTargetFiles = {
  videoFile: TorrentFileMeta;
  sidecarSubtitleFiles: TorrentFileMeta[];
};

/**
 * The same file-selection logic movie-downloader.ts uses to pick what to
 * actually download, reused by seed-reconciliation.ts so a resumed seed
 * checks the durable store for exactly the pieces the original download
 * would have fetched — not the whole torrent (most of which was never
 * downloaded in the first place, see the roadmap's "skip other files").
 */
export const selectTargetFiles = (
  files: TorrentFileMeta[]
): SelectedTargetFiles | null => {
  const videoFile = findMainVideoFile(files);
  if (!videoFile) return null;

  const sidecarSubtitleFiles = files.filter((file) =>
    isSidecarSubtitle(file.name)
  );
  return { videoFile, sidecarSubtitleFiles };
};
