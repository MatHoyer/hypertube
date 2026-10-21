import { hypertubeLogger } from "@hypertube/libs";
import { env } from "@hypertube/server-core";
import * as fs from "node:fs/promises";

// gluetun (VPN_PORT_FORWARDING=on) writes ProtonVPN's dynamically assigned,
// publicly-reachable port here a few seconds after the tunnel comes up —
// see docker-compose-vpn.yml. Shared with this container via the
// gluetun_data volume, since we're in gluetun's network namespace
// (network_mode: container:vpn) but not its filesystem. Carried over
// verbatim from the webtorrent-based client — same VPN setup, same gap it
// closes: without it we're outbound-connections-only, which starves both
// peer discovery and (now) seeding, since nothing on the internet could
// otherwise reach PeerServer.
const GLUETUN_FORWARDED_PORT_FILE = "/tmp/gluetun/forwarded_port";
const FORWARDED_PORT_WAIT_TIMEOUT_MS = 30000;
const FORWARDED_PORT_POLL_INTERVAL_MS = 1000;

/**
 * One port for the whole process: advertised to trackers as our listening
 * port for every torrent (PeerDiscovery), and what PeerServer actually
 * binds to answer inbound connections. Falls back to the static
 * TORRENT_PORT (outbound-only — no inbound connections/seeding
 * will actually reach us) if gluetun never writes the file, e.g.
 * VPN_PORT_FORWARDING isn't set, or a non-gluetun dev setup.
 */
export const resolveListenPort = async (): Promise<number> => {
  const deadline = Date.now() + FORWARDED_PORT_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const raw = (
        await fs.readFile(GLUETUN_FORWARDED_PORT_FILE, "utf-8")
      ).trim();
      const port = Number.parseInt(raw, 10);
      if (Number.isFinite(port) && port > 0) return port;
    } catch {
      // File not written yet — gluetun negotiates it a few seconds after
      // the tunnel comes up. Keep polling until the timeout.
    }
    await new Promise((resolve) =>
      setTimeout(resolve, FORWARDED_PORT_POLL_INTERVAL_MS)
    );
  }
  hypertubeLogger.error(
    `No VPN forwarded port found after ${FORWARDED_PORT_WAIT_TIMEOUT_MS}ms, falling back to static TORRENT_PORT (outbound-only, no seeding reachability)`
  );
  return env.TORRENT_PORT;
};
