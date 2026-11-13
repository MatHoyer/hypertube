import { randomBytes } from "node:crypto";

let peerId: string | null = null;

/** One stable 20-byte (40 hex char) peer ID per downloader process, shared by every torrent's tracker/DHT announces and the inbound peer server — so the swarm sees one consistent identity for this node regardless of which torrent it's talking about. */
export const getPeerId = (): string => {
  if (!peerId) peerId = randomBytes(20).toString("hex");
  return peerId;
};
