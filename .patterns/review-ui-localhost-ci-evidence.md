# Trusted CI evidence for localhost-only rendered products

A rendered product deliberately reachable only on loopback may use CI evidence only when its harness
is declared in
[`.github/review-ui-localhost-harnesses.json`](../.github/review-ui-localhost-harnesses.json).
Preview remains the default for every undeclared product. Operational steps live in the
[localhost-evidence runbook](../ops/runbook-review-ui-localhost-evidence.md).

## Authority and isolation

The default-branch
[declaration](../.github/review-ui-localhost-harnesses.json) fixes the harness id, workflow, check,
event, artifact, subject test and server commands, container port, readiness signal, and complete
surface/state list. The base-owned
[producer workflow](../.github/workflows/review-ui-localhost-evidence.yml) and
[governance tests](../packages/fabrika-cli/src/review-ui/localhost-governance.unit.test.ts) pin that
authority to governed repository surfaces. The consumer resolves the default branch to one exact
commit and reads the declaration at that commit, never from the PR checkout. GitHub documents that
`pull_request_target` runs in the base context and warns against executing untrusted code directly
in that privileged event
([event reference](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request_target)).

The subject checkout is input only to the base-owned Dockerfile. Before Docker receives that context,
the producer refuses any subject root `.dockerignore`; PR-controlled context filtering therefore
cannot hide changed source while the manifest still names the full head. Image construction pins
pnpm 10.27.0 and performs `pnpm fetch --ignore-scripts --ignore-pnpmfile` as the unprivileged `node` user.
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

The producer separates the untrusted subject from the authority checkout because a base-owned event
may safely *name* a PR head without granting that head authority over credentials, workflow policy,
or artifact metadata. The governed journey, built server, and capture sidecar therefore run in
distinct isolation roles: subject code can affect the rendered product, while only trusted code can
select the declaration, inspect the resulting bytes, and emit the record. Bounded resources and
cleanup make a failed or hostile subject terminate as a typed UNKNOWN rather than inherit host
state from another attempt.

The exact container arguments, resource ceilings, readiness state machine, cleanup order, manifest
schema, and refusal codes are reference material. They live in the
[`review-ui ci-produce` contract](../claude-plugins/fabrika/skills/review-ui/contract.md#review-ui-ci-produce)
and are pinned by the
[governance tests](../packages/fabrika-cli/src/review-ui/localhost-governance.unit.test.ts). This
pattern intentionally does not duplicate those values. Docker's documented
[`none` network](https://docs.docker.com/engine/network/drivers/none/) and
[container network sharing](https://docs.docker.com/engine/network/#container-networks) ground the
reason the sidecar can reach only the isolated server loopback.

## Producer record

The
[producer implementation](../packages/fabrika-cli/src/review-ui/ci-produce-verb.ts) proves the full
subject and authority heads and the absence of a subject root `.dockerignore` before building. Its
[flow tests](../packages/fabrika-cli/src/review-ui/ci-produce-flow.test.ts) replay the isolation,
server-build, readiness/crash, keeper lifetime and bounds, timeout cleanup, head,
navigation-response, and manifest boundaries. The
[Docker integration test](../packages/fabrika-cli/src/review-ui/ci-produce-docker.integration.test.ts)
requires a prepared `server.mjs` to start from the kept server tmpfs, then requires the exact
sidecar PNG bytes to survive the separate kept capture tmpfs and extraction into an artifact-ready
manifest. The fixture is a complete decodable PNG, and the shared delegated decoder verifies chunk
structure, every CRC, terminal IEND, inflate/raster output, dimensions, and no truncation or trailing
bytes. A passing Docker-backed run proves that end-to-end byte path for its fixture.

The resulting positive record binds the PR source, governed authority, producer identity, declared
journey, captures, integrity measurements, and readable browser-error evidence. That binding lets a
reviewer distinguish an exact-head render from a plausible-looking archive without trusting code or
metadata from the PR. The complete manifest schema, capture and error limits, navigation rules, and
refusal behavior live in the [`review-ui ci-produce`
contract](../claude-plugins/fabrika/skills/review-ui/contract.md#review-ui-ci-produce).

## Consumer and verdict

The [`review-ui fetch`
implementation](../packages/fabrika-cli/src/review-ui/ci-fetch-verb.ts) resolves evidence from the
live PR and current default-branch authority rather than accepting a caller-selected producer.
[Recorded run 33286961054](https://github.com/kamp-us/phoenix/actions/runs/33286961054)
shows why both identities matter: Actions reports the PR head as `head_sha` while `pull_requests` may
be empty. The base-owned run title therefore binds the PR number, subject head, and authority head;
all three must agree with the live GitHub state. GitHub documents those workflow-run fields in
[List workflow runs for a
workflow](https://docs.github.com/en/rest/actions/workflow-runs?apiVersion=2022-11-28#list-workflow-runs-for-a-workflow).

The consumer's
[integrity tests](../packages/fabrika-cli/src/review-ui/ci-fetch-verb.unit.test.ts) cover producer
identity, archive membership, manifest binding, hashes, dimensions, browser-error coverage, and
live-head revalidation. The [`review-ui fetch`
contract](../claude-plugins/fabrika/skills/review-ui/contract.md#review-ui-fetch) is the single
reference for run/check/artifact selection, the manifest and receipt schemas, archive membership,
integrity validation, materialization, and exit meanings. The consumer carries a closed tagged
failure algebra from GitHub selection through fetch: only `ProducerUnavailable` reaches typed exit
`18`; transport, token, authority-read, scratch, unzip, and runtime tags stay UNKNOWN on `11`.
Routing never inspects stderr. In particular, a trusted artifact with an uncaught page error is
materialized for inspection and remains proven FAIL evidence, not an unresolved CANT-SEE.

Preview manifests are also indexes, never local authority. Before posting preview evidence,
`review-ui post` resolves the live preview announcement and independently re-renders every recorded
surface with its recorded state and flags; the fresh dimensions and bytes must match the reviewed
set. A caller-written receipt or key is ignored and cannot import arbitrary local captures.

The CI local receipt is only an index into GitHub identity. Before posting, `review-ui post` resolves
the governed authority and exact run/check/artifact tuple again, re-downloads the artifact, and
requires the local manifest and captures to byte-match it. A forged receipt therefore cannot bless
attacker-chosen local bytes. The full provenance and receipt rules live in the [`review-ui post`
contract](../claude-plugins/fabrika/skills/review-ui/contract.md#review-ui-post).

After provenance succeeds, the
[`review-ui post` implementation](../packages/fabrika-cli/src/review-ui/post-verb.ts) validates each
capture and re-reads the live head. Its
[provenance and post tests](../packages/fabrika-cli/src/review-ui/post-verb.unit.test.ts) cover byte
recomparison, upload verification, page-crash polarity, ordinary marker emission, and ship
consumption. The shared manifest/declaration schema has its own
[integrity tests](../packages/fabrika-cli/src/review-ui/localhost-evidence.unit.test.ts). `ship` has
no alternate marker or bypass: missing or invalid evidence leaves the namespace empty.
