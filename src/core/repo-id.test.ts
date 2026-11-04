import { describe, expect, it } from "vitest";
import { repoFromRemote, repoMatches } from "./repo-id.ts";

describe("repoFromRemote", () => {
  it.each([
    ["git@gitlab.lab:vpc/frr-dplane-ovs.git", "gitlab.lab/vpc/frr-dplane-ovs"],
    ["https://gitlab.lab/vpc/frr-dplane-ovs.git", "gitlab.lab/vpc/frr-dplane-ovs"],
    ["https://user:token@gitlab.lab/vpc/frr-dplane-ovs", "gitlab.lab/vpc/frr-dplane-ovs"],
    ["ssh://git@gitlab.lab:2222/vpc/sub/Repo.git", "gitlab.lab/vpc/sub/repo"],
    ["https://github.com/arielik/mesh-harness/", "github.com/arielik/mesh-harness"],
    ["git@github.com:arielik/mesh-harness.git", "github.com/arielik/mesh-harness"],
    ["/srv/git/proto-defs.git", "local/srv/git/proto-defs"],
    ["file:///srv/git/proto-defs.git", "local/srv/git/proto-defs"],
  ])("%s → %s", (url, id) => {
    expect(repoFromRemote(url)?.id).toBe(id);
  });

  it("names the repo after the last path segment", () => {
    expect(repoFromRemote("git@gitlab.lab:vpc/frr-dplane-ovs.git")?.name).toBe("frr-dplane-ovs");
  });

  it.each(["", "   ", "not a url", "https://"])("rejects %j", (url) => {
    expect(repoFromRemote(url)).toBeUndefined();
  });
});

describe("repoMatches", () => {
  const repo = { id: "gitlab.lab/vpc/frr-dplane-ovs", name: "frr-dplane-ovs" };
  it.each(["frr-dplane-ovs", "vpc/frr-dplane-ovs", "gitlab.lab/vpc/frr-dplane-ovs", "FRR-dplane-ovs.git"])("matches %s", (q) => {
    expect(repoMatches(repo, q)).toBe(true);
  });
  it.each(["ovs", "dplane-ovs", "other"])("does not match %s", (q) => {
    expect(repoMatches(repo, q)).toBe(false);
  });
});
