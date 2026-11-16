// The reader of mesh's output went away (`mesh pulse show p-3 | head -1`): stop quietly.

import type { EventEmitter } from "node:events";

interface Proc {
  stdout: EventEmitter;
  stderr: EventEmitter;
  exitCode?: number | string | null | undefined;
  exit(code?: number): never;
}

/**
 * Exits quietly when stdout or stderr is a pipe whose reader has closed (EPIPE), instead of
 * dying on an unhandled 'error' event with a stack trace. Stdout closed by its reader exits 0 (the
 * reader took what it wanted, like `head`); stderr closed keeps the exit code set so far. Any other
 * stream error is thrown as before.
 */
export function exitQuietlyOnClosedPipe(proc: Proc): void {
  const on = (stream: EventEmitter, code: () => number) =>
    stream.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code !== "EPIPE") throw e;
      proc.exit(code());
    });
  on(proc.stdout, () => 0);
  on(proc.stderr, () => (typeof proc.exitCode === "number" ? proc.exitCode : 0));
}
