// Phase 13 remains a stable release-script entry point, while the maintained
// new-UI usability contract lives in the FR-02 core vertical-slice smoke.
// Reuse that workflow so this release gate cannot drift back to deleted UI.
await import("./e2e-fr02-core.mjs");

console.log("Phase 13 new-UI usability smoke passed via the FR-02 core workflow");
