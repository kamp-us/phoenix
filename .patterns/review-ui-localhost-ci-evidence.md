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

An offline `pnpm install` then runs every PR-controlled lifecycle script and the governed test in a
disposable test workspace under a read-only root filesystem, `--cap-drop ALL`,
`no-new-privileges`, `--network none`, two CPUs, 2 GiB memory with no swap headroom, and 256 PIDs.
Every foreground container is named before it starts, so the producer's unconditional cleanup can
force-remove it after a client timeout. The test and server workspaces are named volumes backed by a
2 GiB tmpfs rather than unbounded writable storage; capture output has a separate 256 MiB tmpfs
ceiling, and cleanup force-removes every volume. The local driver's tmpfs is kept mounted from
sidecar write through read-only extraction by one named keeper container. This is required because
tmpfs data does not survive an unmount
([Linux tmpfs](https://www.kernel.org/doc/html/latest/filesystems/tmpfs.html)); sequential ephemeral
containers otherwise leave no capture bytes for extraction. The authority Dockerfile owns the
volume destination as `node:node` before its first mount, so the unprivileged sidecar has write access
and extraction needs only read access. The keeper receives no authority, credential, subject, Docker
socket, or host-output mount; it uses Docker `none`, a read-only root, dropped capabilities,
`no-new-privileges`, 0.1 CPU, 64 MiB memory with no swap headroom, 16 PIDs, and a 4 MiB temporary
filesystem. It is force-removed on every outcome, including a sidecar timeout.

That workspace is never served. A separate server
workspace is freshly copied from the image's immutable exact-head source, installed offline with
both install-time execution-disabling flags, and built by the declaration's fixed
`serverBuildCommand` under the same no-network restrictions. The resulting workspace is mounted
read-only into the server; the server publishes no host port and receives only the
read-only fixture. Docker's `none` driver leaves only loopback
([none driver](https://docs.docker.com/engine/network/drivers/none/)). A base-owned capture sidecar
uses `--network container:<server>` to share that isolated network stack
([container networks](https://docs.docker.com/engine/network/#container-networks)), reaching the
server on loopback without external network. The PR server receives no Actions credentials,
authority checkout, Docker socket, or artifact-output mount. The trusted sidecar receives the
authority checkout read-only and a 256 MiB tmpfs output volume only. A fixed base-owned extraction
container copies at most that bounded volume into the artifact directory; the host validates those
captures and alone writes the manifest. Docker documents the remaining root, capability, CPU, memory, PID, tmpfs, named-container, and
mount controls in the [`docker run` reference](https://docs.docker.com/reference/cli/docker/container/run/),
[`docker volume create` reference](https://docs.docker.com/reference/cli/docker/volume/create/), and
[bind-mount reference](https://docs.docker.com/engine/storage/bind-mounts/).

## Producer record

The
[producer implementation](../packages/fabrika-cli/src/review-ui/ci-produce-verb.ts) proves the full
subject and authority heads and the absence of a subject root `.dockerignore` before building. Its
[flow tests](../packages/fabrika-cli/src/review-ui/ci-produce-flow.test.ts) replay the isolation,
server-build, readiness/crash, keeper lifetime and bounds, timeout cleanup, head,
navigation-response, and manifest boundaries. The
[Docker integration test](../packages/fabrika-cli/src/review-ui/ci-produce-docker.integration.test.ts)
builds and serves a real read-only volume and proves the exact sidecar PNG bytes survive the kept
capture tmpfs through extraction into an artifact-ready manifest when a Docker daemon is available.

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
integrity validation, materialization, and exit meanings. In particular, a trusted artifact with an
uncaught page error is materialized for inspection and remains proven FAIL evidence, not an
unresolved CANT-SEE.

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
