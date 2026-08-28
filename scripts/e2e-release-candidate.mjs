// A release candidate must exercise the maintained packaged and portable
// new-UI paths. Keep this entry point as orchestration instead of duplicating
// selectors that can drift away from the production interface.
await import("./e2e-packaged-smoke.mjs");
await import("./e2e-portable-smoke.mjs");

console.log("Release-candidate packaged and portable new-UI smokes passed");
