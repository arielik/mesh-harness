// The `none` and `token` providers (plan §4.2).

import { createHash, timingSafeEqual } from "node:crypto";
import { AuthError, type AuthProvider, type CompleteInput, type FlowKind, type Identity, type StartResult } from "./types.ts";

/** Single-user local mode: everyone is `local`. The hub refuses this provider off loopback. */
export class NoneProvider implements AuthProvider {
  readonly kind = "none" as const;
  readonly label = "Local (no login)";
  readonly id: string;
  readonly user: string;
  constructor(id = "local", user = "local") {
    this.id = id;
    this.user = user;
  }
  flows(): FlowKind[] {
    return ["none"];
  }
  async start(): Promise<StartResult> {
    return { kind: "immediate" };
  }
  async complete(input: CompleteInput): Promise<Identity> {
    if (input.flow !== "none") throw new AuthError(`provider ${this.id} only supports the none flow`, 400);
    return { provider: this.id, subject: this.user, name: this.user, groups: ["local"] };
  }
}

export interface TokenUser {
  name: string;
  token_sha256: string;
  groups?: string[] | undefined;
  email?: string | undefined;
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Static tokens from config (CI, small teams, break-glass). Constant-time comparison. */
export class TokenProvider implements AuthProvider {
  readonly kind = "token" as const;
  readonly id: string;
  readonly label: string;
  private users: TokenUser[];
  constructor(id: string, users: TokenUser[], label = "Token") {
    this.id = id;
    this.users = users;
    this.label = label;
  }
  flows(): FlowKind[] {
    return ["token"];
  }
  async start(): Promise<StartResult> {
    return { kind: "immediate" };
  }
  async complete(input: CompleteInput): Promise<Identity> {
    if (input.flow !== "token") throw new AuthError(`provider ${this.id} only supports the token flow`, 400);
    const got = Buffer.from(sha256(input.token), "hex");
    let match: TokenUser | undefined;
    for (const u of this.users) {
      const want = Buffer.from(u.token_sha256, "hex");
      if (want.length === got.length && timingSafeEqual(want, got)) match = u;
    }
    if (!match) throw new AuthError("unknown token");
    return { provider: this.id, subject: match.name, name: match.name, email: match.email, groups: match.groups ?? [] };
  }
}
