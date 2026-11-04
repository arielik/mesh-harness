// Hub-issued opaque tokens (plan §4.3): random, stored hashed, idle and absolute expiry, revocable.

import { randomBytes } from "node:crypto";
import type { HubStore, TokenKind, TokenRow } from "../store/index.ts";
import { sha256 } from "./providers.ts";

export interface TokenPolicy {
  maxAgeMs: number;
  /** 0 = no idle timeout. */
  idleMs: number;
}

export interface SessionPolicies {
  device: TokenPolicy;
  web: TokenPolicy;
  service: TokenPolicy;
}

const DAY = 24 * 60 * 60_000;
export const DEFAULT_POLICIES: SessionPolicies = {
  device: { maxAgeMs: 14 * DAY, idleMs: 7 * DAY },
  web: { maxAgeMs: 7 * DAY, idleMs: 12 * 60 * 60_000 },
  service: { maxAgeMs: 365 * DAY, idleMs: 0 },
};

const PREFIX: Record<TokenKind, string> = { device: "mh_d_", web: "mh_w_", service: "mh_s_" };

export interface Issued {
  token: string;
  hash: string;
  expiresAt: number;
}

export class Tokens {
  private store: HubStore;
  private policies: SessionPolicies;

  constructor(store: HubStore, policies: SessionPolicies = DEFAULT_POLICIES) {
    this.store = store;
    this.policies = policies;
  }

  issue(kind: TokenKind, userId: string, now: number, opts: { machineId?: string | undefined; label?: string | undefined } = {}): Issued {
    const token = PREFIX[kind] + randomBytes(32).toString("base64url");
    const hash = sha256(token);
    const p = this.policies[kind];
    const expiresAt = now + p.maxAgeMs;
    this.store.insertToken({ hash, userId, kind, machineId: opts.machineId, label: opts.label, createdAt: now, lastUsed: now, expiresAt, revoked: false });
    return { token, hash, expiresAt };
  }

  /** Validate a presented token; slides the idle window. */
  verify(token: string, now: number): TokenRow | undefined {
    if (!/^mh_[dws]_[A-Za-z0-9_-]{20,}$/.test(token)) return undefined;
    const row = this.store.getToken(sha256(token));
    if (!row || row.revoked || now >= row.expiresAt) return undefined;
    const idle = this.policies[row.kind].idleMs;
    if (idle > 0 && now - row.lastUsed > idle) return undefined;
    if (now - row.lastUsed > 60_000) this.store.touchToken(row.hash, now);
    return row;
  }

  revoke(token: string): void {
    this.store.revokeToken(sha256(token));
  }
}
