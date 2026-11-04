import { createHash, randomBytes } from "node:crypto";

export function pkceVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function randomId(bytes = 16): string {
  return randomBytes(bytes).toString("base64url");
}
