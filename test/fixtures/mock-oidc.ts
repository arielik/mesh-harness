// A tiny OIDC issuer for tests: discovery, authorize (auto-approves the configured user),
// token (code + PKCE, device code), device authorization, JWKS and userinfo. RS256 ID tokens.

import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";

export interface MockUser {
  sub: string;
  preferred_username: string;
  email?: string;
  groups?: string[];
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export class MockOidc {
  issuer = "";
  user: MockUser = { sub: "u-1", preferred_username: "alice", email: "alice@lab", groups: ["mesh-approvers@idm.lab"] };
  /** Put groups in userinfo only (not in the ID token). */
  groupsInUserinfo = false;
  device = true;
  /** Device-code token requests seen (pacing tests). */
  deviceTokenRequests = 0;
  /** Answer the next device-code token request with slow_down. */
  slowDownOnce = false;
  private server: Server;
  private key: KeyObject;
  private jwk: Record<string, unknown>;
  private codes = new Map<string, { challenge: string; nonce: string; clientId: string; redirect: string }>();
  private devices = new Map<string, { userCode: string; approved: boolean; clientId: string }>();

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.key = privateKey;
    this.jwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: "k1", alg: "RS256", use: "sig" };
    this.server = createServer((req, res) => {
      void this.handle(req).then(
        ({ status, body, headers }) => {
          res.writeHead(status, { "content-type": "application/json", ...headers });
          res.end(typeof body === "string" ? body : JSON.stringify(body));
        },
        (e) => {
          res.writeHead(500);
          res.end(String(e));
        },
      );
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((ok) => this.server.listen(0, "127.0.0.1", ok));
    const a = this.server.address();
    if (!a || typeof a === "string") throw new Error("no port");
    this.issuer = `http://127.0.0.1:${a.port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((ok) => this.server.close(() => ok()));
  }

  /** Approve a pending device login, as the user would in a browser. */
  approveDevice(userCode: string): boolean {
    for (const d of this.devices.values()) if (d.userCode === userCode) return (d.approved = true);
    return false;
  }

  private idToken(clientId: string, nonce?: string): string {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: this.issuer,
      aud: clientId,
      sub: this.user.sub,
      iat: now,
      exp: now + 300,
      preferred_username: this.user.preferred_username,
      email: this.user.email,
      ...(this.groupsInUserinfo ? {} : { groups: this.user.groups ?? [] }),
      ...(nonce ? { nonce } : {}),
    };
    const head = b64(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "k1" }));
    const body = b64(JSON.stringify(claims));
    return `${head}.${body}.${b64(sign("sha256", Buffer.from(`${head}.${body}`), this.key))}`;
  }

  private async handle(req: IncomingMessage): Promise<{ status: number; body: unknown; headers?: Record<string, string> }> {
    const url = new URL(req.url ?? "/", this.issuer);
    let raw = "";
    for await (const c of req) raw += c;
    const form = new URLSearchParams(raw);
    switch (url.pathname) {
      case "/.well-known/openid-configuration":
        return {
          status: 200,
          body: {
            issuer: this.issuer,
            authorization_endpoint: `${this.issuer}/authorize`,
            token_endpoint: `${this.issuer}/token`,
            jwks_uri: `${this.issuer}/jwks`,
            userinfo_endpoint: `${this.issuer}/userinfo`,
            ...(this.device ? { device_authorization_endpoint: `${this.issuer}/device` } : {}),
            response_types_supported: ["code"],
            subject_types_supported: ["public"],
            id_token_signing_alg_values_supported: ["RS256"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
          },
        };
      case "/jwks":
        return { status: 200, body: { keys: [this.jwk] } };
      case "/authorize": {
        const code = b64(randomBytes(16));
        const redirect = url.searchParams.get("redirect_uri") ?? "";
        this.codes.set(code, {
          challenge: url.searchParams.get("code_challenge") ?? "",
          nonce: url.searchParams.get("nonce") ?? "",
          clientId: url.searchParams.get("client_id") ?? "",
          redirect,
        });
        const to = new URL(redirect);
        to.searchParams.set("code", code);
        to.searchParams.set("state", url.searchParams.get("state") ?? "");
        to.searchParams.set("iss", this.issuer);
        return { status: 302, body: "", headers: { location: to.href } };
      }
      case "/device": {
        const deviceCode = b64(randomBytes(16));
        const userCode = b64(randomBytes(3)).toUpperCase();
        this.devices.set(deviceCode, { userCode, approved: false, clientId: form.get("client_id") ?? "" });
        return {
          status: 200,
          body: { device_code: deviceCode, user_code: userCode, verification_uri: `${this.issuer}/activate`, verification_uri_complete: `${this.issuer}/activate?code=${userCode}`, expires_in: 60, interval: 1 },
        };
      }
      case "/token": {
        const grant = form.get("grant_type");
        if (grant === "authorization_code") {
          const c = this.codes.get(form.get("code") ?? "");
          if (!c) return { status: 400, body: { error: "invalid_grant" } };
          this.codes.delete(form.get("code") ?? "");
          const verifier = form.get("code_verifier") ?? "";
          if (createHash("sha256").update(verifier).digest("base64url") !== c.challenge) return { status: 400, body: { error: "invalid_grant", error_description: "PKCE" } };
          return { status: 200, body: { access_token: "at-" + b64(randomBytes(8)), token_type: "Bearer", expires_in: 300, id_token: this.idToken(c.clientId, c.nonce) } };
        }
        if (grant === "urn:ietf:params:oauth:grant-type:device_code") {
          this.deviceTokenRequests++;
          if (this.slowDownOnce) {
            this.slowDownOnce = false;
            return { status: 400, body: { error: "slow_down" } };
          }
          const d = this.devices.get(form.get("device_code") ?? "");
          if (!d) return { status: 400, body: { error: "expired_token" } };
          if (!d.approved) return { status: 400, body: { error: "authorization_pending" } };
          this.devices.delete(form.get("device_code") ?? "");
          return { status: 200, body: { access_token: "at-" + b64(randomBytes(8)), token_type: "Bearer", expires_in: 300, id_token: this.idToken(d.clientId) } };
        }
        return { status: 400, body: { error: "unsupported_grant_type" } };
      }
      case "/userinfo":
        return { status: 200, body: { sub: this.user.sub, preferred_username: this.user.preferred_username, email: this.user.email, groups: this.user.groups ?? [] } };
      default:
        return { status: 404, body: { error: "not found" } };
    }
  }
}
