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
node, edge, and panel entries name stable keys and package-contained assets. Public package identity
is a branded schema admitting npm-style unscoped names or one `@scope/name` separator; path, URL,
dot-segment, control-character, and encoded-separator forms fail decoding. Generated fallback
identities use the same decoder. Diagnostics use a closed reason union and can carry only that public
identity plus a validated contribution kind/key; they do not retain manifest asset/module/export,
pi source, or filesystem values.

For every package with a Tuval manifest, the backend canonicalizes its root with Effect
`FileSystem.realPath`. It resolves each frontend asset and backend module through the same real-path
operation, checks that the canonical candidate is a file beneath the canonical root, then opens each
frontend asset with no-follow semantics. Thus an in-package symlink to an in-package file is accepted,
while an outside symlink, directory, oversized asset, or swap to a symlink fails closed. Frontend
assets are not imported by the backend: at startup, at most 4 MiB of each accepted asset is read into
the validated catalog snapshot.

The emitted browser catalog replaces each asset with an opaque same-origin
`/api/contribution-assets/v1-<n>.js` URL. The startup catalog retains the only exact URL-to-immutable-
bytes map, and the HTTP route never decodes client input into a filesystem path or reopens a package
file. Unknown URLs return a path-free 404. Valid responses use a JavaScript content type, disable
cache reuse without revalidation, and set `X-Content-Type-Options: nosniff` for dynamic import. The current implementation is
[`package-contributions.ts`](../packages/tuval/src/backend/package-contributions.ts), with the
compatibility and fail-closed cases pinned by
[`package-contributions.test.ts`](../packages/tuval/test/package-contributions.test.ts) and
[`server.test.ts`](../packages/tuval/test/server.test.ts).

Fail closed at package granularity. An unsupported or malformed contract, duplicate key, shadowed
key, unavailable canonical file, outside-target symlink, non-file asset, or invalid backend export
excludes that package's entire Tuval contribution while preserving valid packages. The first package
in pi's resolved order owns a key.
Package resolution failure produces a typed package diagnostic and an empty contribution source; it
does not abort independent workspace restoration. Backend Layers activate per package in a child
scope before that package's registration or replayable extension state becomes visible. If any Layer
in the package fails, the child scope rolls back, the package's backend/frontend registration and
retained extension projection are removed and persisted, and healthy packages remain active.

A built-in Tuval capability uses the same route: Tuval's own `package.json` declares an ordinary pi
extension and optional Tuval manifest. Do not add a privileged server bootstrap for built-ins.
