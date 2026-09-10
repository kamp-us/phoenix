# Usage recording contract

The common recorder accepts native usage facts from host integrations. It owns validation,
identity comparison and storage. Host adapters own native parsing, launch bindings and descendant
discovery. The recorder never starts a model or changes its settings or task result.

## Entry points

`spend record [--ledger <path>]` reads one version-2 JSON envelope from stdin. The default path is
`.fabrika/spend-ledger.jsonl`. Stdout is `{"status":"recorded"}` or `{"status":"duplicate"}`.
Exit 11 reports invalid input, unreadable input, contention, conflicting identity or a failed
write/read-back on stderr. Retry the same envelope after fixing the reported problem. A host
must report recorder failures separately from its original task exit status.

`spend read --ledger <path> [--json]` emits JSON with `records`, `legacy`, `diagnostics` and `usage`.
The ledger mode always emits JSON. `records` holds the version-2 envelopes, including notices;
`legacy` holds decoded version-1 evaluation rows without invented issue attribution. Diagnostics
count `malformed`, `newerVersion`, `duplicates` and `conflicts`. Conflicting records remain visible;
consumers cannot sum them as independent responses. A successful read is not a completeness claim.
An empty ledger yields empty arrays, with no measured zero or complete run manufactured.
Exit 7 means the path is absent; exit 11 means it could not be read.

The positional `spend read <transcript>` interface retains the legacy Claude-shaped reconstruction.
It cannot be combined with `--ledger`. This historical calculation keeps the last observed model;
it cannot establish per-response model attribution. `spend rollup` reads both ledger versions.
Its `usage` object summarizes version-2 responses; the existing top-level totals and capped
day/skill/stage-arm lists describe historical rows only.

## Issue and run summaries

`spend rollup [--ledger <path>] [--issue <number>] [--run <id>] [--repo <owner/repo>] [--json]`
intersects exact recorded bindings. With no binding flags it includes every response in that
ledger. It does not discover other ledger files. Claude writes per checkout; Codex writes in the
primary checkout. Select each ledger explicitly when those locations differ.

JSON retains `window`, `totals`, `skipped`, `undatedRows`, `byDay`, `bySkill` and `byStageArm` for
legacy consumers, and adds `legacy` metadata and `usage`. Text retains the historical lines and
appends `legacy<TAB><JSON>` and `usage.<field><TAB><JSON>` for every field below. Both formats carry
the same values. Iterate every counter/model/coverage row; those lists are the requested answer.

| `usage` field | Meaning |
|---|---|
| `scope` | Selected repo, issue and run; null means no filter |
| `responses` | Distinct, nonconflicting response records counted; not a token measurement |
| `counters` | Native category totals across models, grouped by host, format, provider, field, category and arithmetic meaning |
| `byModel` | Every host/format/provider/model group, with its response count and counter totals; unknown identities remain null |
| `excluded` | Cumulative snapshots, conflicting measurement variants and unbound response records excluded by an issue filter |
| `unattributed` | Count and counters for included responses whose issue is null |
| `coverage` | Overall state, host availability, and per-root groups with discovery, participants, measured sessions, missing participants and retained notices |
| `diagnostics` | Ledger-wide malformed, future-version, duplicate and conflict counts; bad rows cannot be assigned to a narrower scope |

A counter total retains the native `field`, normalized `category` and `meaning`. `tokens` sums only
measured values of that field. It is null when none were measured, and zero when measured values
sum to zero. `states` counts measured, absent, unsupported, unavailable and not-applicable records.
A field omitted from another response in the same host/format/provider group contributes an absent
state. A partial sum therefore remains visibly partial. There is no provider-blind grand total:
subsets and aggregates remain labelled and are never added to their parents.

The shared ledger reader removes exact duplicates. The summary excludes every conflicting variant
of an identity before applying issue/run filters. It counts response records across descendants,
attempts and model changes, and never adds cumulative snapshots. An issue filter excludes unknown
issue bindings and reports their count. Run and overall summaries retain them under `unattributed`.
Unbound coverage notices for a selected root remain visible without assigning its unbound usage
to that issue.

Coverage is conservative. A session with a response can still have missing work. Participant
notices retain their attempt and whether a matching response was found; an earlier attempt cannot
prove a later one measured. Old missing notices remain visible after recovery. Unmatched tool-call
identities remain unresolved when the ledger supplies no alias linking them to a recovered child.
The current host collectors cannot prove an exhaustive inventory, so their totals remain partial.
Pi's observer is unavailable, including when no Pi record exists; no all-host completion is claimed.
No observed responses yields unavailable coverage, not measured zero usage.

`legacy.attribution` is unavailable and `legacy.categories` names the historical four-component
view. `legacy.excludedByScope` counts historical rows omitted by binding filters. Those rows have
no issue/run binding. `--since`/`--until` retain inclusive UTC date filtering for legacy-only ledgers.
They refuse with exit 1 if version-2 records exist, because those records have no timestamp.
Other rollup exits are 7 for an absent ledger, 11 for unreadable input, 12 for no readable rows,
and 13 for an empty legacy date window. Malformed and future-version line counts remain distinct.

### Current host evidence

| Host | Tested evidence and limit |
|---|---|
| Claude | Claude Code 2.1.217 metadata fixtures and lifecycle hook tests; [collector reference](../../../claude-plugins/fabrika/docs/claude-usage.md) and [setup/recovery](../../../claude-plugins/fabrika/docs/claude-usage-setup.md). Provider remains unknown when native records do not supply it. |
| Codex | Native 0.153.4 and 0.154.0 record fixtures, dispatch collection and native callback tests; [source contract and recovery](./codex-usage.md). Unknown versions remain unsupported. |
| Pi | The required observer integration is pending. Availability and descendant inventory remain unknown; no zero-token or complete result is inferred. |

For Effect callers, the package root exports `UsageRecords` and `UsageLedger` namespaces:

```ts
import {UsageLedger, UsageRecords} from "@kampus/fabrika-cli";
import {Effect, Result} from "effect";

const persist = Effect.fn("host.persistUsage")(function* (input: unknown) {
	const decoded = UsageRecords.decodeUsageRecord(input);
	if (Result.isFailure(decoded)) return {status: "invalid" as const};
	return yield* UsageLedger.recordUsage(".fabrika/spend-ledger.jsonl", decoded.success);
});
```

`recordUsage(path, record)` requires Effect `FileSystem` and `Path`. It has no typed failure channel.
Its result is `{status: "recorded" | "duplicate"}` or `{status: "failed", notice: string}`.
Report the notice and retain the envelope for replay. The API validates again before writing.
`loadUsageLedger(path)` uses `FileSystem` and fails when the file cannot be read.
`readUsageLedger(text)` is the pure historical/versioned decoder.

## Shared fields

The authoritative schema is [usage-record.ts](../src/spend/usage-record.ts). Unknown properties
are rejected, including transcript content accidentally spread onto an envelope. Fields contain
usage/identity metadata only. Strings below are identifiers, never prompts, credentials or paths.

| Field | Meaning |
|---|---|
| `v` | Literal `2`; version 1 remains the historical evaluation format |
| `recordId` | Stable adapter event ID, retained across retries of recording |
| `source` | Native `host`, record `format`, and tested source `version` |
| `work` | `repo`, `issue`, `run`, `attempt`; each is explicitly `null` when unknown |
| `agent.session` | Owning participant/session ID, Codex `thread_id`; not the file that contained the record |
| `agent.nativeSession` | Separate native `session_id` when supplied, otherwise `null` |
| `agent.parent` | `{kind: "root"}`, `{kind: "known", session}` or `{kind: "unknown"}` |
| `agent.rootSession` | Native root session ID, or `null` |

An attempt identifies the invocation that performed the work. Every actual retry gets a distinct
attempt. A replay by the recorder retains the original one. Copied parent history keeps its
original session, parent, work and attempt bindings. It never adopts the collecting child's identity.
Unknown issue attribution stays `null` at the known run. No filenames, titles or times infer it.

## Measurements

A `kind: "measurement"` adds nullable native `response`, `turn`, `rootTurn` and `parentTurn` IDs, nullable `provider` and
`model`, a `basis`, and a nonempty `counters` list. Each response keeps its own model/provider.
`basis` is `{kind: "response"}` or `{kind: "cumulative", snapshot, scope: "session" | "turn"}`.
Cumulative records are evidence, never additional response deltas. The snapshot ID must be stable;
a later snapshot has a distinct ID. No total is computed at ingestion.

Each counter names its original `field`, including dotted nested paths, a normalized `category`,
its `value`, and its `meaning`. Native fields outside the listed categories use `other`.

| Value | Meaning |
|---|---|
| `{state: "measured", tokens: 0}` | A measured zero; tokens must be nonnegative safe integers |
| `{state: "absent"}` | The source format supports the field but this record omits it |
| `{state: "unsupported"}` | This source does not expose the field |
| `{state: "unavailable"}` | A counter could not be obtained |
| `{state: "not-applicable"}` | The field does not apply to this measurement |

An omitted counter remains omitted. In particular, the recorder does not add a cached-output field.
Counter meanings are `additive`, `subset` with an `of` field name, `aggregate` with an `of` list,
or `unknown`. Relationships must reference distinct existing fields without cycles. A measured
reasoning counter must be a subset of output; measured TTL counters must be subsets of cache write.
A `total` cannot be additive. Preserve raw counters whose meaning is unverified as `unknown`.

The [fixture evidence](../src/spend/fixtures/attributed/README.md) grounds the two input conventions:
Claude input, cache read and cache creation are separate components. Codex cached input is a subset
of input. Claude TTL splits and reasoning output are retained as subsets, not extra totals.

## Participant and coverage notices

A `kind: "participant"` record adds nullable `participant`, naming the expected child session,
and `state`: `expected`, `absent`, `unreadable`, `unsupported` or `usage-missing`. Record a launch
notice before collecting usage. Emit a separate missing notice when collection cannot finish.
Notices have no token count. Their `recordId` distinguishes launch and later collection events.

A `kind: "coverage"` record adds `state`, `discovery` and `participants`. `complete` requires
`discovery: "enumerated"` and a nonempty participant list. Other states are `partial`, `unavailable`
and `unsupported`, with discovery either `enumerated` or `unknown`. A source unable to enumerate
descendants must use unknown discovery and a non-complete state, including unavailable Pi support.

These records are the collector's evidence, not a ledger-wide verdict. Consumers must reconcile
expected participants, missing notices, actual responses and read diagnostics before claiming a
complete run. A participant list alone does not establish that its members were measured.

## Identity and storage

Known measurements deduplicate on host, original session, attempt, basis, turn and native response
or snapshot identity. The format/version and model are retained in the compared payload, not used
to split a conflicting identity into two charges. A copied record may have a different `recordId`.
Without sufficient native identity, only the stable adapter `recordId` within its known binding
deduplicates. Such records stay visibly uncertain and cannot establish cross-source completeness.

Exact re-ingestion is a duplicate. A different payload under the same identity is a visible refusal;
the original is retained. The reader also removes exact duplicate lines and counts conflicting
variants without selecting one. Version-1 rows use the historical decoder; malformed version-2 rows
are damage, and valid integer versions above 2 get a distinct future-version diagnostic.

The [write protocol](../../../.patterns/serialized-usage-ledger.md) covers serialization and recovery.
It heals an unterminated tail with a newline, preserves the damaged bytes for diagnosis, syncs the
file, and verifies the appended record. A recorder killed while holding the lock can leave
`<ledger>.lock`. Stop all writers before explicitly removing that directory, then replay the same
envelope. The recorder never steals a lock based on age. This protocol assumes one canonical file
path, a local filesystem, and cooperating recorders; hard-link aliases and unrelated raw appenders
are outside it. No power-loss guarantee for a newly created directory is claimed.

## Executable examples

From the repository root, with no model invocation:

```bash
node packages/fabrika-cli/src/bin.ts spend record --ledger .fabrika/example-usage.jsonl < packages/fabrika-cli/src/spend/fixtures/attributed/codex.json
node packages/fabrika-cli/src/bin.ts spend read --ledger .fabrika/example-usage.jsonl --json
node packages/fabrika-cli/src/bin.ts spend rollup --ledger .fabrika/example-usage.jsonl --issue 42 --json
node packages/fabrika-cli/src/bin.ts spend rollup --ledger .fabrika/example-usage.jsonl --run run-1
```

These are independent processes. [record.cli.test.ts](../src/spend/record.cli.test.ts) exercises
that journey, copied history and competing processes. [usage-ledger.unit.test.ts](../src/spend/usage-ledger.unit.test.ts)
uses actual files for interrupted appends, replay, legacy reads and recording failure recovery.
[usage-journey.cli.test.ts](../src/spend/usage-journey.cli.test.ts) drives Claude and Codex callback
boundaries in fresh processes through interruption, delayed descendants, retries, model switches
and repeated reads. Its eight-response example expects Codex input/output 40/20 and Claude
noncached input/output/cache-read/cache-write 8/28/80/40. The source relationships are grounded in
[Codex `TokenUsageRecord` and `non_cached_input`](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/protocol/src/protocol.rs)
and [Claude's token breakdown](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#understanding-the-token-breakdown).
The tests then add an unbound response and prove only run/overall totals include it. They invoke
no model. All-host epic acceptance still waits for Pi.
