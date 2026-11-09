import { describe, expect, it } from "vitest";
import { trustSystemCertificates, type TlsCaApi } from "./system-ca.ts";

function fakeTls(def: string[], sys: string[]): TlsCaApi & { set?: string[] } {
  const t: TlsCaApi & { set?: string[] } = {
    getCACertificates: (type) => (type === "system" ? sys : def),
    setDefaultCACertificates: (certs) => void (t.set = certs),
  };
  return t;
}

describe("trust the system certificate store", () => {
  it("adds the system's certificates to Node's defaults, once each", () => {
    const t = fakeTls(["mozilla-a", "extra-b"], ["mozilla-a", "lab-root"]);
    expect(trustSystemCertificates(t, {})).toBe(1);
    expect(t.set).toEqual(["mozilla-a", "extra-b", "lab-root"]);
  });

  it("changes nothing when the system adds nothing new", () => {
    const t = fakeTls(["a"], ["a"]);
    expect(trustSystemCertificates(t, {})).toBe(0);
    expect(t.set).toBeUndefined();
  });

  it("MESH_SYSTEM_CA=off, an older Node, or an unreadable store leave Node's list alone", () => {
    const t = fakeTls(["a"], ["b"]);
    expect(trustSystemCertificates(t, { MESH_SYSTEM_CA: "off" })).toBeUndefined();
    expect(t.set).toBeUndefined();
    expect(trustSystemCertificates({}, {})).toBeUndefined();
    const broken: TlsCaApi = { getCACertificates: () => { throw new Error("no store"); }, setDefaultCACertificates: () => undefined };
    expect(trustSystemCertificates(broken, {})).toBeUndefined();
  });
});
