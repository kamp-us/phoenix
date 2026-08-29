# Pi-native Tuval package contributions

> Derived from `@earendil-works/pi-coding-agent@0.84.3`; re-verify on pin bump.

Tuval extends an installed pi package without creating a second package registry. Package selection,
scope precedence, resource filters, and enablement belong to pi. Tuval starts with a
`SettingsManager`, asks `DefaultPackageManager.resolve()` for enabled extension resources, and
examines the package roots carried by their `PathMetadata`. It never reads a Tuval-specific install
list or enable setting.

This follows pi 0.84.3's [Scope and Deduplication contract](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/docs/packages.md#scope-and-deduplication):
project package entries win over matching global entries. The pinned
[`resolve()` implementation](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/core/package-manager.ts#L912-L964)
reads those settings, resolves project packages first, deduplicates them, and returns resources with
an `enabled` flag and package `baseDir`. The pinned
[`DefaultResourceLoader.reload()` implementation](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/core/resource-loader.ts#L388-L456)
uses that same answer and loads only enabled resources. Those contracts are the supported bridge from
pi's package decision to an optional Tuval manifest.

A package keeps its ordinary `pi` manifest and may add a sibling `tuval` manifest with
`contractVersion: 1`. Backend entries name zero-argument exports returning Effect Layers. Frontend
node, edge, and panel entries name stable keys and package-contained assets. The backend validates
metadata and asset existence but does not import frontend assets. The current implementation is
[`package-contributions.ts`](../packages/tuval/src/backend/package-contributions.ts), with the
compatibility and fail-closed cases pinned by
[`package-contributions.test.ts`](../packages/tuval/test/package-contributions.test.ts).

Fail closed at package granularity. An unsupported or malformed contract, duplicate key, shadowed
key, escaping path, missing asset, or invalid backend export excludes that package's entire Tuval
contribution while preserving valid packages. The first package in pi's resolved order owns a key.
A backend module or factory exception and a Layer construction failure are startup failures because
a partially initialized backend is not a valid runtime.

A built-in Tuval capability uses the same route: Tuval's own `package.json` declares an ordinary pi
extension and optional Tuval manifest. Do not add a privileged server bootstrap for built-ins.
