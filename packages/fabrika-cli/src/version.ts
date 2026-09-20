import pkg from "../package.json" with {type: "json"};

// Derived from the manifest, never declared as a second literal that can drift from it.
export const VERSION = pkg.version;
