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

interface DeviceState {
  result?: Identity;
  error?: string;
  expiresAt: number;
}

export class OidcProvider implements AuthProvider {
  readonly kind = "oidc" as const;
  readonly id: string;
  readonly label: string;
  private cfg: OidcConfig;
  private config: Promise<client.Configuration> | undefined;
  private devices = new Map<string, DeviceState>();

  constructor(cfg: OidcConfig) {
    this.cfg = cfg;
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
      const pollId = randomUUID();
      const state: DeviceState = { expiresAt: Date.now() + resp.expires_in * 1000 };
      this.devices.set(pollId, state);
      client
        .pollDeviceAuthorizationGrant(c, resp)
        .then((tokens) => this.identityFrom(c, tokens))
        .then((id) => (state.result = id))
        .catch((e: unknown) => (state.error = e instanceof Error ? e.message : String(e)));
      return {
        kind: "device",
        userCode: resp.user_code,
        verifyUrl: resp.verification_uri,
        verifyUrlComplete: resp.verification_uri_complete,
        pollId,
        interval: resp.interval ?? 5,
        expiresIn: resp.expires_in,
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
    if (input.flow === "device") {
      const state = this.devices.get(input.pollId);
      if (!state) throw new AuthError("unknown or expired device login", 404);
      if (state.result) {
        this.devices.delete(input.pollId);
        return state.result;
      }
      if (state.error || Date.now() > state.expiresAt) {
        this.devices.delete(input.pollId);
        throw new AuthError(`device login failed: ${state.error ?? "expired"}`);
      }
      return "pending";
    }
    throw new AuthError(`provider ${this.id} does not support the ${input.flow} flow`, 400);
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
