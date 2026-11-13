import type { TorrentFileMeta, TorrentMetadata } from "./metadata.js";

/** Byte length of a given piece index — every piece is metadata.pieceLength except the very last piece of the whole torrent, which is whatever's left over (metadata.lastPieceLength). */
export const pieceByteLength = (metadata: TorrentMetadata, index: number): number => {
  const { pieceLength, lastPieceLength, pieces } = metadata;
  return index === pieces.length - 1 ? lastPieceLength : pieceLength;
};

/** Every piece index that overlaps at least one of the given files' byte ranges — shared by PieceManager (which needs to know what to download) and engine.ts's resumeSeeding (which needs to know what to check for in the durable store, without downloading anything). */
export const computeNeededPieceIndices = (
  metadata: TorrentMetadata,
  targetFiles: TorrentFileMeta[]
): number[] => {
  const { pieceLength, pieces } = metadata;
  const indices: number[] = [];
  for (let index = 0; index < pieces.length; index++) {
    const pieceStart = index * pieceLength;
    const pieceEnd = pieceStart + pieceByteLength(metadata, index);
    const overlapsAnyTarget = targetFiles.some((file) => {
      const fileStart = file.offset;
      const fileEnd = fileStart + file.length;
      return pieceEnd > fileStart && pieceStart < fileEnd;
    });
    if (overlapsAnyTarget) indices.push(index);
  }
  return indices;
};
