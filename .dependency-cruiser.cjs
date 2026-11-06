// Module boundaries (docs/plan/implementation-plan.md §2.1).
// Paths match "src/<module>/" anywhere in the path so test fixtures can exercise the rules.

const MODULES = ["protocol", "core", "auth", "store", "claude", "mux", "daemon", "mcp", "hub", "cli", "gitlab"];

/** module -> internal modules it may import (itself is always allowed) */
const ALLOWED = {
  protocol: [],
  core: ["protocol"],
  auth: ["protocol", "core", "store"],
  store: ["protocol"],
  claude: ["protocol"],
  mux: ["protocol"],
  daemon: ["protocol", "core", "store", "claude", "mux"],
  mcp: ["protocol"],
  hub: ["protocol", "core", "store", "auth", "gitlab"],
  cli: ["protocol", "core", "claude", "mux", "auth"],
  gitlab: ["protocol"],
};

const at = (m) => `(^|/)src/${m}/`;

const moduleRules = MODULES.map((from) => {
  const forbidden = MODULES.filter((to) => to !== from && !ALLOWED[from].includes(to));
  return {
    name: `boundary-${from}`,
    comment: `src/${from} may only import: ${ALLOWED[from].join(", ") || "(no internal modules)"}`,
    severity: "error",
    from: { path: at(from) },
    to: { path: `(^|/)src/(${forbidden.join("|")})/` },
  };
});

module.exports = {
  forbidden: [
    ...moduleRules,
    {
      name: "sqlite-only-in-store",
      comment: "Only src/store touches SQLite or Postgres.",
      severity: "error",
      from: { path: "(^|/)src/", pathNot: at("store") },
      to: { path: "^(node:)?sqlite$|better-sqlite3|(^|/)node_modules/pg/", dependencyTypes: ["core", "npm", "npm-dev", "unknown", "undetermined"] },
    },
    {
      name: "processes-only-in-adapters",
      comment: "Only src/claude, src/mux and src/cli spawn processes.",
      severity: "error",
      from: { path: "(^|/)src/", pathNot: "(^|/)src/(claude|mux|cli)/" },
      to: { path: "^(node:)?child_process$", dependencyTypes: ["core"] },
    },
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: { extensions: [".ts", ".js", ".json"] },
  },
};
