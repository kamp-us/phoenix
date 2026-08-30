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

The subject checkout is therefore inert host data used only as the build context of the base-owned
Dockerfile. PR-controlled install, test, and server execution occurs in a read-only,
capability-dropped container with no Actions credentials, authority checkout, Docker socket, or
artifact-output mount. Docker documents that bind mounts are the mechanism that exposes host paths
and that read-only bind mounts prevent container writes
([bind mounts](https://docs.docker.com/engine/storage/bind-mounts/)); the producer exposes only a
read-only fixture. The trusted host drives Playwright and alone writes the captures and manifest.

## Producer record

The producer proves the subject checkout's full Git head before image construction. Its positive
manifest binds schema version, repository, PR, full head, declaration digest, harness, workflow,
check, event, run, artifact name, and every declared surface. Each capture binds a relative artifact
member, dimensions, SHA-256, and bounded `pageerror` / `console.error` evidence. An uncaught page
error makes the producer red.

## Consumer and verdict

`review-ui fetch` requires one successful completed run whose workflow, event, repository, PR
association, and exact head match the declaration. It requires the named successful check and one
artifact whose `expired` field is present, boolean, and false. Member names are checked for traversal
and duplicates before extraction. Capture surfaces are checked for duplicates before any `Set`
comparison, then matched exactly against the declaration.

The consumer re-derives hashes and dimensions, rejects unreadable error coverage, re-reads the live
head, copies the validated set into reviewer-owned scratch, and writes a receipt binding the manifest
hash to the observed run, check, and artifact ids. The artifact cannot supply that receipt because
its member allowlist excludes it.

`review-ui post` accepts route-shaped preview sets from `review-ui render`. A CI source or non-route
surface is CI-shaped and must carry the positive CI manifest and matching consumer receipt, so a
preview-shaped local manifest cannot present a governed localhost surface to bypass provenance. The
verb revalidates every capture and the live head, verified-uploads the pixels, records provenance and
browser-error coverage, and emits the ordinary `review-ui` marker. `ship` has no alternate marker or
bypass: missing or invalid CI evidence leaves the namespace empty.
