// Usage: pnpm spike <print|interactive|background|contract|e2e…|all>; pnpm test:claude = contract
import { runBackground } from "./background.ts";
import { runContract } from "./contract.ts";
import { runE2e } from "./e2e.ts";
import { runE2eM2 } from "./e2e-m2.ts";
import { runE2eM3 } from "./e2e-m3.ts";
import { runE2eM45 } from "./e2e-m45.ts";
import { runE2eOffline } from "./e2e-offline.ts";
import { runInteractive } from "./interactive.ts";
import { runPrint } from "./print.ts";

const which = process.argv[2] ?? "all";
const spikes: Record<string, () => Promise<void>> = {
  print: runPrint,
  interactive: runInteractive,
  background: runBackground,
  e2e: runE2e,
  "e2e-m2": runE2eM2,
  "e2e-m3": runE2eM3,
  "e2e-offline": runE2eOffline,
  "e2e-m45": runE2eM45,
  contract: runContract,
};

for (const [name, fn] of Object.entries(spikes)) {
  if (which === "all" ? name.startsWith("e2e") : which !== name) continue;
  process.stdout.write(`\n=== spike ${name} ===\n`);
  await fn();
}
