// Generic OIDC provider (plan §4.2): Kanidm, Keycloak, Authentik, GitLab, Google… The hub is the
// only OIDC client: authorization code + PKCE, and the device flow when the issuer offers it.

import { randomUUID } from "node:crypto";
import * as client from "openid-client";
import { normalizeGroups } from "../core/index.ts";
import { AuthError, type AuthProvider, type CompleteInput, type FlowKind, type Identity, type StartContext, type StartResult } from "./types.ts";

export interface OidcConfig {
  id: string;
  label?: string | undefined;
  issuer: string;
  clientId: string;
  clientSecret?: string | undefined;
  scopes: string[];
  groupsClaim: string;
  groupNormalize: ("strip_domain" | "lowercase")[];
  /** Allow http:// issuers (tests, local IdPs). */
  allowInsecure?: boolean | undefined;
}

/** Presets fill defaults for well-known IdPs; they are configuration, not code paths. */
export const PRESETS: Record<string, Partial<OidcConfig>> = {
  kanidm: { label: "Kanidm", scopes: ["openid", "profile", "email", "groups"], groupsClaim: "groups", groupNormalize: ["strip_domain"] },
  keycloak: { label: "Keycloak", scopes: ["openid", "profile", "email"], groupsClaim: "groups", groupNormalize: [] },
  gitlab: { label: "GitLab", scopes: ["openid", "profile", "email"], groupsClaim: "groups_direct", groupNormalize: [] },
};

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/**
 * A device login in progress (RFC 8628). Held by the hub between polls, not by this object, so the
 * provider is stateless and any hub replica can answer a poll.
 */
interface DeviceState {
  deviceCode: string;
  expiresAt: number;
  /** Seconds between token requests; raised by `slow_down`. */
  interval: number;
  /** Polls before this answer "pending" without asking the identity provider. */
  nextPollAt: number;
}

function deviceState(s: Record<string, unknown>): DeviceState {
  if (typeof s.deviceCode !== "string" || typeof s.expiresAt !== "number" || typeof s.interval !== "number" || typeof s.nextPollAt !== "number") {
    throw new AuthError("unknown or expired device login", 404);
  }
  return s as unknown as DeviceState;
}

export class OidcProvider implements AuthProvider {
  readonly kind = "oidc" as const;
  readonly id: string;
  readonly label: string;
  private cfg: OidcConfig;
  private config: Promise<client.Configuration> | undefined;
  /** Clock for device-flow expiry and pacing (tests). */
  private readonly now: () => number;

  constructor(cfg: OidcConfig, now: () => number = () => Date.now()) {
    this.cfg = cfg;
    this.now = now;
    this.id = cfg.id;
    this.label = cfg.label ?? cfg.id;
  }

  private configuration(): Promise<client.Configuration> {
    this.config ??= client
      .discovery(
        new URL(this.cfg.issuer),
        this.cfg.clientId,
        undefined,
        this.cfg.clientSecret ? client.ClientSecretPost(this.cfg.clientSecret) : client.None(),
        this.cfg.allowInsecure ? { execute: [client.allowInsecureRequests] } : undefined,
      )
      .catch((e: unknown) => {
        this.config = undefined;
        throw new AuthError(`cannot reach the identity provider ${this.cfg.issuer}: ${String(e)}`, 502);
      });
    return this.config;
  }

  flows(): FlowKind[] {
    return ["redirect", "device"];
  }

  async supportsDevice(): Promise<boolean> {
    const c = await this.configuration();
    return Boolean(c.serverMetadata().device_authorization_endpoint);
  }

  async start(flow: FlowKind, ctx: StartContext): Promise<StartResult> {
    const c = await this.configuration();
    const scope = this.cfg.scopes.join(" ");
    if (flow === "redirect") {
      const url = client.buildAuthorizationUrl(c, {
        redirect_uri: ctx.redirectUri,
        scope,
        state: ctx.state,
        nonce: ctx.nonce,
        code_challenge: ctx.pkceChallenge,
        code_challenge_method: "S256",
      });
      return { kind: "redirect", url: url.href };
    }
    if (flow === "device") {
      if (!(await this.supportsDevice())) throw new AuthError(`${this.cfg.issuer} does not offer the device flow`, 400);
      const resp = await client.initiateDeviceAuthorization(c, { scope });
      const interval = resp.interval ?? 5;
      const now = this.now();
      const state: DeviceState = { deviceCode: resp.device_code, expiresAt: now + resp.expires_in * 1000, interval, nextPollAt: now + interval * 1000 };
      return {
        kind: "device",
        userCode: resp.user_code,
        verifyUrl: resp.verification_uri,
        verifyUrlComplete: resp.verification_uri_complete,
        pollId: randomUUID(),
        interval,
        expiresIn: resp.expires_in,
        state: state as unknown as Record<string, unknown>,
      };
    }
    throw new AuthError(`provider ${this.id} does not support the ${flow} flow`, 400);
  }

  async complete(input: CompleteInput): Promise<Identity | "pending"> {
    const c = await this.configuration();
    if (input.flow === "redirect") {
      let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
      try {
        tokens = await client.authorizationCodeGrant(c, new URL(input.callbackUrl), {
          pkceCodeVerifier: input.pkceVerifier,
          expectedState: input.state,
          expectedNonce: input.nonce,
        });
      } catch (e) {
        throw new AuthError(`login failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return this.identityFrom(c, tokens);
    }
    if (input.flow === "device") return this.pollDevice(c, deviceState(input.state));
    throw new AuthError(`provider ${this.id} does not support the ${input.flow} flow`, 400);
  }

  /**
   * One token request for a device login (not the library's polling loop: the next poll may land
   * on another replica). Paced by the issuer's interval, so a fast-polling client cannot make the
   * hub hammer the identity provider. Updates `s` in place.
   */
  private async pollDevice(c: client.Configuration, s: DeviceState): Promise<Identity | "pending"> {
    const now = this.now();
    if (now > s.expiresAt) throw new AuthError("device login failed: expired");
    if (now < s.nextPollAt) return "pending";
    let tokens: Awaited<ReturnType<typeof client.genericGrantRequest>>;
    try {
      tokens = await client.genericGrantRequest(c, DEVICE_GRANT, { device_code: s.deviceCode });
    } catch (e) {
      if (e instanceof client.ResponseBodyError) {
        if (e.error === "authorization_pending" || e.error === "slow_down") {
          if (e.error === "slow_down") s.interval += 5;
          s.nextPollAt = now + s.interval * 1000;
          return "pending";
        }
        throw new AuthError(`device login failed: ${e.error}${e.error_description ? ` (${e.error_description})` : ""}`);
      }
      throw new AuthError(`device login failed: cannot reach the identity provider ${this.cfg.issuer}: ${e instanceof Error ? e.message : String(e)}`, 502);
    }
    return this.identityFrom(c, tokens);
  }

  private async identityFrom(c: client.Configuration, tokens: client.TokenEndpointResponse & client.TokenEndpointResponseHelpers): Promise<Identity> {
    const claims = tokens.claims();
    if (!claims) throw new AuthError("the identity provider returned no ID token");
    let all: Record<string, unknown> = { ...claims };
    if (all[this.cfg.groupsClaim] === undefined && c.serverMetadata().userinfo_endpoint) {
      try {
        all = { ...all, ...(await client.fetchUserInfo(c, tokens.access_token, claims.sub)) };
      } catch {
        // groups are optional
      }
    }
    const raw = all[this.cfg.groupsClaim];
    const groups = Array.isArray(raw) ? raw.filter((g): g is string => typeof g === "string") : [];
    const str = (k: string) => (typeof all[k] === "string" ? (all[k] as string) : undefined);
    return {
      provider: this.id,
      subject: claims.sub,
      name: str("preferred_username") ?? str("name") ?? str("email"),
      email: str("email"),
      groups: normalizeGroups(groups, this.cfg.groupNormalize),
    };
  }
}
