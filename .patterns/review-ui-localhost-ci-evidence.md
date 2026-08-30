# Trusted CI evidence for localhost-only rendered products

A rendered product that is deliberately reachable only on loopback cannot use the ordinary PR
preview. Its `review-ui` evidence may come from CI only when the harness is declared in
[`.github/review-ui-localhost-harnesses.json`](../.github/review-ui-localhost-harnesses.json).
Preview remains the default for every undeclared product.

## Authority and producer

The declaration fixes the harness id, workflow path, check name, event, artifact name, capture
command, server command, readiness signal, and complete surface/state list. The consumer reads this
document from the repository default branch through GitHub, never from the PR checkout. The
producer workflow runs on `pull_request_target`, so GitHub executes the base branch's workflow while
the subject is checked out separately at the PR's exact 40-character head. The job has read-only
repository permissions and receives no product or deployment secrets.

The trusted CLI leg runs the declared browser journey, starts the loopback server, and captures the
declared surfaces with both `pageerror` and `console.error` channels attached. An uncaught page
error fails the producer. It asserts the subject checkout's full Git head before writing the versioned
manifest; the consumer separately binds that head to the live PR before accepting it.
The artifact is therefore produced by CI; neither a builder-authored capture nor a caller-selected
workflow, run, artifact, manifest, or local path can enter this path.

## Consumer and verdict

Use `fabrika review-ui fetch <pr> --harness <id> --out <set>`. The verb requires one successful,
completed run whose workflow, event, repository, PR association, and exact head match the governed
declaration. It then requires the named successful check and one non-expired artifact. The artifact
is extracted only after every member name passes the traversal and duplicate guard.

The positive manifest binds schema version, repository, PR, full head, declaration digest, harness,
workflow, check, event, run, artifact name, and every declared surface. Each capture binds a relative
artifact member, dimensions, SHA-256, and bounded browser-error evidence. The consumer re-derives
the hashes and dimensions, rejects unreadable error coverage, re-reads the live head, and copies the
validated set into reviewer-owned scratch and writes a consumer provenance receipt binding the
manifest hash to the observed run, check, and artifact ids. The artifact cannot supply that receipt:
its member allowlist excludes it.

`review-ui post` requires that receipt, recognizes the CI manifest, revalidates every capture and the live head again,
verified-uploads the pixels, records the producer and browser-error coverage in the verdict, and
emits the ordinary `review-ui` marker. `ship` needs no alternate marker or bypass: missing or invalid
CI evidence leaves the normal namespace empty and shipping remains blocked.

## Tuval unblock

For PR #7190, merge or rebase the platform change into its head so a `synchronize` event starts
`review-ui localhost evidence / tuval`. An independent reviewer then fetches `--harness tuval`,
judges the downloaded desktop and mobile pixels plus browser-error evidence, and posts with the
fetched set. The flow runs Tuval only on the isolated CI runner; it adds no `apps/web` route, preview
deployment, Cloudflare binding, or production endpoint.
