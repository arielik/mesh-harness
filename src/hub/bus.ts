// In-process fan-out for the SSE hint channel (plan §5.4). Losing a hint loses nothing: daemons
// pull their inbox and dashboards refetch.

export type Hint = { type: "wake"; machine: string } | { type: "changed"; seq: number };

export class Bus {
  private subs = new Set<(h: Hint) => void>();

  subscribe(fn: (h: Hint) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  publish(h: Hint): void {
    for (const fn of this.subs) {
      try {
        fn(h);
      } catch {
        // a broken subscriber must not affect others
      }
    }
  }
}
