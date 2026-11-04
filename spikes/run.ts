// Usage: pnpm spike <print|interactive|background|all>
import { runBackground } from "./background.ts";
import { runE2e } from "./e2e.ts";
import { runE2eM2 } from "./e2e-m2.ts";
import { runInteractive } from "./interactive.ts";
import { runPrint } from "./print.ts";

const which = process.argv[2] ?? "all";
const spikes: Record<string, () => Promise<void>> = {
  print: runPrint,
  interactive: runInteractive,
  background: runBackground,
  e2e: runE2e,
  "e2e-m2": runE2eM2,
};

for (const [name, fn] of Object.entries(spikes)) {
  if (which === "all" ? name.startsWith("e2e") : which !== name) continue;
  process.stdout.write(`\n=== spike ${name} ===\n`);
  await fn();
}
