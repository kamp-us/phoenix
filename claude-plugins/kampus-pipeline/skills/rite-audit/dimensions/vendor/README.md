# Vendored assets — `accessibility` dimension

## `axe.min.js` — axe-core, pinned

| | |
| --- | --- |
| Package | [`axe-core`](https://github.com/dequelabs/axe-core) (Deque Systems) |
| **Pinned version** | **4.10.2** |
| File | `axe.min.js` (the minified UMD build, `package/axe.min.js` from the npm tarball) |
| sha256 | `b511cd9dec01c76f4b2ad1723b66b6db37d4c2eb4ed199076e1829d9ee7b75e3` |
| License | **MPL-2.0** — the copyright + license notice is preserved verbatim in the file's header banner, as the MPL requires |
| Source | `https://registry.npmjs.org/axe-core/-/axe-core-4.10.2.tgz` |

### Why vendored, not CDN (Q2 ruling)

The `accessibility` dimension's `axe-scan` (A1) and `color-contrast` (A5) checks inject
axe-core into the page and run it via the Playwright-MCP `browser_evaluate` seam. The asset is
**vendored and version-pinned** rather than loaded from a CDN so the audit is:

- **CSP-immune** — the build is inlined into the `browser_evaluate` body, never fetched, so a
  stage Content-Security-Policy that blocks third-party script can't break the scan.
- **Deterministic** — every run scans with the *same* axe-core version and rule set; a CDN
  "latest" would silently shift the rule corpus run-over-run and break #1516's diff.
- **Network-free** — no outbound request from the audit, so the scan never flakes on a CDN
  outage or a sandboxed-network stage.

### Updating the pin

Bump deliberately: download the new tarball, replace `axe.min.js`, update the version + sha256
here, and note the bump in the dimension file. A version change shifts the rule corpus, so it is
a reviewed change, not an incidental one.
