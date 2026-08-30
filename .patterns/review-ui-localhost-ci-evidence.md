# Trusted CI evidence for localhost-only rendered products

A rendered product deliberately reachable only on loopback may use CI evidence only when its harness
is declared in
[`.github/review-ui-localhost-harnesses.json`](../.github/review-ui-localhost-harnesses.json).
Preview remains the default for every undeclared product. Operational steps live in the
[localhost-evidence runbook](../ops/runbook-review-ui-localhost-evidence.md).

## Authority and isolation

The default-branch declaration fixes the harness id, workflow, check, event, artifact, subject test
and server commands, container port, readiness signal, and complete surface/state list. The consumer
reads it through GitHub, never from the PR checkout. GitHub documents that `pull_request_target` runs
in the base context and warns against executing untrusted code directly in that privileged event
([event reference](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request_target)).

The subject checkout is input only to the base-owned Dockerfile. Image construction pins pnpm
10.27.0 and performs `pnpm fetch --ignore-scripts --ignore-pnpmfile` as the unprivileged `node` user.
At that tag, the
[`fetch` implementation](https://github.com/pnpm/pnpm/blob/v10.27.0/pkg-manager/plugin-commands-installation/src/fetch.ts#L47-L76)
uses an empty package manifest and sets `ignorePackageManifest`; the
[config loader](https://github.com/pnpm/pnpm/blob/v10.27.0/cli/cli-utils/src/getConfig.ts#L39-L62)
loads pnpmfile hooks only when `ignorePnpmfile` is false; and the
[install core](https://github.com/pnpm/pnpm/blob/v10.27.0/pkg-manager/core/src/install/index.ts#L1342-L1376)
gates dependency builds on `ignoreScripts` while its
[root lifecycle runner](https://github.com/pnpm/pnpm/blob/v10.27.0/pkg-manager/core/src/install/index.ts#L1521-L1531)
is under the inverse condition. Those version-matched paths establish that this fetch executes
neither package lifecycle scripts nor the PR's pnpmfile hooks.

An offline `pnpm install` then runs every PR-controlled lifecycle script and the governed test in a
disposable test workspace under a read-only root filesystem, `--cap-drop ALL`,
`no-new-privileges`, and `--network none`. That workspace is never served. A separate server
workspace is freshly copied from the image's immutable exact-head source and installed offline with
both execution-disabling flags before it is mounted read-only into the server under the same
restrictions, including `--network none`; the server publishes no host port and receives only the
read-only fixture. Docker's `none` driver leaves only loopback
([none driver](https://docs.docker.com/engine/network/drivers/none/)). A base-owned capture sidecar
uses `--network container:<server>` to share that isolated network stack
([container networks](https://docs.docker.com/engine/network/#container-networks)), reaching the
server on loopback without external network. The PR server receives no Actions credentials,
authority checkout, Docker socket, or artifact-output mount. The trusted sidecar receives the
authority checkout read-only and prepared output mount only; the host validates its captures and
alone writes the manifest. Docker documents the remaining root, capability, security, and mount
controls in the [`docker run` reference](https://docs.docker.com/reference/cli/docker/container/run/)
and [bind-mount reference](https://docs.docker.com/engine/storage/bind-mounts/).

## Producer record

The producer proves the subject checkout's full Git head before image construction. Its positive
manifest binds schema version, repository, PR, full head, declaration digest, harness, workflow,
check, event, run, artifact name, and every declared surface. Each capture binds a relative artifact
member, dimensions, SHA-256, and bounded `pageerror` / `console.error` evidence. Each row is at most
1,024 UTF-16 code units, and the rows place every uncaught `pageerror` ahead of console errors, so
console noise cannot push the hard-fail kind into the untyped overflow count. The producer keeps an
artifact publishable when a successful journey's browser capture records an uncaught page error; the
trusted consumer owns the red-render exit so the pixels and error record remain independently
reviewable. If the governed journey command itself fails, the producer stops before server start,
capture, manifest creation, and workflow artifact upload.

## Consumer and verdict

`review-ui fetch` requires one successful completed run whose workflow, event, repository, PR
association, and exact head match the declaration. It requires the named successful check and one
artifact whose `expired` field is present, boolean, and false. GitHub's authoritative REST OpenAPI
`Artifact` schema requires `expired`, types it as boolean, and defines it as whether the artifact has
expired
([property](https://github.com/github/rest-api-description/blob/3fa67306b30ebd736a08604ff8b8932a34f68ddf/descriptions/api.github.com/api.github.com.json#L141550-L141553),
[required list](https://github.com/github/rest-api-description/blob/3fa67306b30ebd736a08604ff8b8932a34f68ddf/descriptions/api.github.com/api.github.com.json#L141602-L141612)).
Member names are checked for traversal
and duplicates before extraction. Capture surfaces are checked for duplicates before any `Set`
comparison, then matched exactly against the declaration.

The consumer re-derives hashes and dimensions, rejects unreadable error coverage, re-reads the live
head, copies the validated set into reviewer-owned scratch, and writes a receipt binding the manifest
hash to the observed run, check, and artifact ids. The artifact cannot supply that receipt because
its member allowlist excludes it. An accepted artifact containing an uncaught page error is still
materialized, then `fetch` exits `13`: this is a proven red render that must be posted as FAIL, not an
unresolved CANT-SEE.

`review-ui post` accepts route-shaped preview sets only with the separate `review-ui render`
provenance receipt binding repository, PR, head, app, preview URL, and manifest hash. The receipt is
HMAC-signed by a random capability key held outside the set in reviewer-owned scratch, so set-local
JSON cannot nominate preview provenance. Every preview capture must remain inside that deterministic
set directory, and the receipt must still match the
live preview announcement before posting. Route shape alone does not select this arm. A CI source
must carry the positive CI manifest and matching consumer receipt, so neither an arbitrary
route-shaped manifest nor a preview-shaped local manifest can bypass provenance. The verb revalidates
every capture and the live head, reads the governed declaration again, re-resolves
the exact run/check/artifact ids through GitHub, verified-uploads the pixels, records the workflow,
event, run, check and artifact provenance plus browser-error coverage, and refuses a PASS over any
recorded uncaught page error before it emits the ordinary
`review-ui` marker. `ship` has no alternate marker or
bypass: missing or invalid CI evidence leaves the namespace empty.
