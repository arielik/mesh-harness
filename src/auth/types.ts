// Auth provider port (plan §4.2). Providers prove who someone is at login; after that the hub
// issues its own opaque tokens, so nothing downstream knows which provider was used.

export interface Identity {
  /** Provider instance id from config, e.g. "kanidm". */
  provider: string;
  /** Stable id at that provider. */
  subject: string;
  name?: string | undefined;
  email?: string | undefined;
  /** Groups, already normalized per provider config. */
  groups: string[];
}

export type FlowKind = "none" | "token" | "redirect" | "device";

export interface StartContext {
  state: string;
  nonce: string;
  pkceChallenge: string;
  redirectUri: string;
}

export type StartResult =
  | { kind: "redirect"; url: string }
  | { kind: "device"; userCode: string; verifyUrl: string; verifyUrlComplete?: string | undefined; pollId: string; interval: number; expiresIn: number }
  | { kind: "immediate" };

export type CompleteInput =
  | { flow: "none" }
  | { flow: "token"; token: string }
  | { flow: "redirect"; callbackUrl: string; pkceVerifier: string; state: string; nonce: string; redirectUri: string }
  | { flow: "device"; pollId: string };

export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}

export interface AuthProvider {
  readonly id: string;
  readonly kind: "none" | "token" | "oidc";
  /** Human label for login pages. */
  readonly label: string;
  flows(): FlowKind[];
  start(flow: FlowKind, ctx: StartContext): Promise<StartResult>;
  /** Returns the identity, or "pending" while a device login is not approved yet. Throws AuthError. */
  complete(input: CompleteInput): Promise<Identity | "pending">;
}
