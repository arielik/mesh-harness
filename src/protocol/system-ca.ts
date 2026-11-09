// Trust the operating system's certificate store as well as Node's bundled one.
//
// Node verifies TLS against its own copy of the Mozilla list and ignores the system store, so a hub
// behind a company or lab CA (installed in /usr/local/share/ca-certificates, the macOS keychain or
// the Windows store) fails with UNABLE_TO_GET_ISSUER_CERT_LOCALLY although curl and browsers on the
// same machine trust it. Every mesh process (CLI, daemon, MCP server, hub) calls this once at start,
// so `mesh login`, the daemon's sync and the hub's OIDC calls all see the same trust as the system.

/** The parts of node:tls this needs (Node 22.19+ / 24.5+; older Node has neither and is left alone). */
export interface TlsCaApi {
  getCACertificates?: (type?: "default" | "system" | "bundled" | "extra") => string[];
  setDefaultCACertificates?: (certs: string[]) => void;
}

/**
 * Add the system store to the default CAs (NODE_EXTRA_CA_CERTS keeps working: it is part of the
 * default set). MESH_SYSTEM_CA=off skips it. Returns how many certificates the system store added,
 * or undefined when it did nothing.
 */
export function trustSystemCertificates(tls: TlsCaApi, env: Record<string, string | undefined> = process.env): number | undefined {
  if (env.MESH_SYSTEM_CA === "off" || !tls.getCACertificates || !tls.setDefaultCACertificates) return undefined;
  try {
    const current = tls.getCACertificates("default");
    const system = tls.getCACertificates("system");
    const known = new Set(current);
    const added = system.filter((c) => !known.has(c));
    if (added.length > 0) tls.setDefaultCACertificates([...current, ...added]);
    return added.length;
  } catch {
    // A store that can't be read must not stop mesh: Node's own list still applies.
    return undefined;
  }
}
