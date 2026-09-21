/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "Cycles hide initialization order and couple unrelated changes.",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-unresolvable",
      severity: "error",
      comment: "Every import must resolve from a clean checkout.",
      from: {},
      to: {
        couldNotResolve: true,
        pathNot: "^@automerge/automerge/automerge[.]wasm[?]url$",
      },
    },
    {
      name: "production-does-not-import-tests",
      severity: "error",
      from: { pathNot: "[.](?:test|spec)[.]ts$" },
      to: { path: "[.](?:test|spec)[.]ts$" },
    },
    {
      name: "domain-does-not-depend-on-infrastructure",
      severity: "error",
      comment: "Domain stays usable without Vue, storage, or sync runtimes.",
      from: { path: "^src/domain/" },
      to: {
        path: "^src/(?:components|ui|sync)(?:/|$)|^src/storage[.]ts$",
      },
    },
    {
      name: "ui-does-not-own-infrastructure",
      severity: "error",
      comment: "UI should call an application boundary, not storage or sync directly.",
      from: { path: "^src/(?:components|ui)/" },
      to: { path: "^src/(?:storage[.]ts|sync/)" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "^(?:dist|iroh-wasm|vendor)/" },
    tsConfig: { fileName: "tsconfig.app.json" },
    enhancedResolveOptions: {
      extensions: [".js", ".mjs", ".cjs", ".ts", ".d.ts", ".vue", ".json"],
      conditionNames: ["import", "browser", "default", "types"],
      exportsFields: ["exports"],
    },
    skipAnalysisNotInRules: true,
  },
};
