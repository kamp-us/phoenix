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

The subject checkout is input only to the base-owned Dockerfile. Image construction installs fixed
producer tools and performs `pnpm fetch --ignore-scripts --ignore-pnpmfile` as the unprivileged
`node` user; pnpm defines `fetch` as lockfile package acquisition into the virtual store rather than
installation ([pnpm fetch](https://pnpm.io/cli/fetch)), and the two flags disable lifecycle and
PR-supplied pnpmfile hooks, so no PR-controlled code executes in that build step. An offline `pnpm
install` then runs every
PR-controlled lifecycle script and the governed test in one disposable workspace volume under a
read-only root filesystem, `--cap-drop ALL`, `no-new-privileges`, and `--network none`. The server
reuses the installed workspace read-only under the same root/capability restrictions and receives
only the read-only fixture. Neither container receives Actions credentials, the authority checkout,
Docker socket, or artifact-output mount. Docker documents those root, capability, network, security,
and mount controls in the
[`docker run` reference](https://docs.docker.com/reference/cli/docker/container/run/) and
[bind-mount reference](https://docs.docker.com/engine/storage/bind-mounts/). The trusted host drives
Playwright and alone writes the captures and manifest.

## Producer record

The producer proves the subject checkout's full Git head before image construction. Its positive
manifest binds schema version, repository, PR, full head, declaration digest, harness, workflow,
check, event, run, artifact name, and every declared surface. Each capture binds a relative artifact
member, dimensions, SHA-256, and bounded `pageerror` / `console.error` evidence. The bounded rows
place every uncaught `pageerror` ahead of console errors, so console noise cannot push the hard-fail
kind into the untyped overflow count. The producer keeps
that artifact publishable even when it records an uncaught page error; the trusted consumer owns the
red-render exit so the pixels and error record remain independently reviewable.

## Consumer and verdict

`review-ui fetch` requires one successful completed run whose workflow, event, repository, PR
association, and exact head match the declaration. It requires the named successful check and one
artifact whose `expired` field is present, boolean, and false. Member names are checked for traversal
and duplicates before extraction. Capture surfaces are checked for duplicates before any `Set`
comparison, then matched exactly against the declaration.

The consumer re-derives hashes and dimensions, rejects unreadable error coverage, re-reads the live
head, copies the validated set into reviewer-owned scratch, and writes a receipt binding the manifest
hash to the observed run, check, and artifact ids. The artifact cannot supply that receipt because
its member allowlist excludes it. An accepted artifact containing an uncaught page error is still
materialized, then `fetch` exits `13`: this is a proven red render that must be posted as FAIL, not an
unresolved CANT-SEE.

`review-ui post` accepts route-shaped preview sets from `review-ui render`. A CI source or non-route
surface is CI-shaped and must carry the positive CI manifest and matching consumer receipt, so a
preview-shaped local manifest cannot present a governed localhost surface to bypass provenance. The
verb revalidates every capture and the live head, reads the governed declaration again, re-resolves
the exact run/check/artifact ids through GitHub, verified-uploads the pixels, records the workflow,
event, run, check and artifact provenance plus browser-error coverage, and refuses a PASS over any
recorded uncaught page error before it emits the ordinary
`review-ui` marker. `ship` has no alternate marker or
bypass: missing or invalid CI evidence leaves the namespace empty.
