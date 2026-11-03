// Usage: pnpm spike <print|interactive|background|all>
import { runBackground } from "./background.ts";
import { runInteractive } from "./interactive.ts";
import { runPrint } from "./print.ts";

const which = process.argv[2] ?? "all";
const spikes: Record<string, () => Promise<void>> = {
  print: runPrint,
  interactive: runInteractive,
  background: runBackground,
};

for (const [name, fn] of Object.entries(spikes)) {
  if (which !== "all" && which !== name) continue;
  process.stdout.write(`\n=== spike ${name} ===\n`);
  await fn();
}
