import pkg from "../package.json" with {type: "json"};

// Derived, never declared — see the same note in packages/pipeline-cli/src/version.ts (#5714).
export const VERSION = pkg.version;
