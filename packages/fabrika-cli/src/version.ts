import pkg from "../package.json" with {type: "json"};

// Derived, never declared — see #5714.
export const VERSION = pkg.version;
