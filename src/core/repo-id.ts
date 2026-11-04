import type { Repo } from "../protocol/index.ts";

/**
 * Normalise a git remote URL to a repo id: lower-case `host/path`, no scheme, user, port or `.git`
 * (plan §3.1). HTTPS and SSH clones of the same repo get the same id.
 */
export function repoFromRemote(remote: string): Repo | undefined {
  const url = remote.trim();
  if (!url) return undefined;
  let host: string;
  let path: string;

  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(url);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return undefined;
    }
    if (parsed.protocol === "file:") {
      host = "local";
      path = parsed.pathname;
    } else {
      host = parsed.hostname;
      path = parsed.pathname;
    }
  } else if (scp && !url.startsWith("/") && !/^[a-z]:\\/i.test(url)) {
    host = scp[1] ?? "";
    path = scp[2] ?? "";
  } else if (url.startsWith("/")) {
    host = "local";
    path = url;
  } else {
    return undefined;
  }

  path = path.replace(/\/+$/, "").replace(/\.git$/i, "").replace(/^\/+/, "");
  if (!host || !path) return undefined;
  const id = `${host}/${path}`.toLowerCase();
  const name = id.slice(id.lastIndexOf("/") + 1);
  return { id, name };
}

/** Does `query` name this repo? Matches the full id, a path suffix, or the bare name. */
export function repoMatches(repo: Repo, query: string): boolean {
  const q = query.toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "");
  return repo.id === q || repo.name === q || repo.id.endsWith(`/${q}`);
}
