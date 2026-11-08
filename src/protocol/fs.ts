// Crash-safe file writes, shared by every module that writes a user file (config, credentials,
// Claude settings, CLAUDE.md, the skill, service units, records). It lives in protocol because
// every module may import protocol; it has no other dependency than node:fs.

import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface AtomicWriteOptions {
  /** File mode of the result. Default: the replaced file's mode, or 0644 for a new file. */
  mode?: number;
  /** Before replacing, keep the previous file as `<path>.prev` (same mode). */
  keepPrevious?: boolean;
}

let counter = 0;

/**
 * Write `text` to `path` so that a crash or power cut leaves either the old file or the new one,
 * never a truncated mix: write a temporary file in the same folder, flush it to disk, rename it
 * over the target, then flush the folder.
 */
export function writeFileAtomic(path: string, text: string | Uint8Array, opts: AtomicWriteOptions = {}): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${++counter}.tmp`);
  const existing = existsSync(path) ? statSync(path).mode & 0o777 : undefined;
  const mode = opts.mode ?? existing ?? 0o644;
  const fd = openSync(tmp, "w", mode);
  try {
    const data = typeof text === "string" ? Buffer.from(text) : text;
    let off = 0;
    while (off < data.length) off += writeSync(fd, data, off, data.length - off);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
  closeSync(fd);
  try {
    // openSync's mode is filtered by the umask: set an explicit or inherited mode exactly.
    if (opts.mode !== undefined || existing !== undefined) chmodSync(tmp, mode);
    if (opts.keepPrevious && existing !== undefined) {
      copyFileSync(path, `${path}.prev`);
      chmodSync(`${path}.prev`, existing);
    }
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  // Flush the folder entry too (not supported on every platform; best effort).
  try {
    const dfd = openSync(dir, "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    // Windows and some file systems refuse to open or fsync a directory.
  }
}
