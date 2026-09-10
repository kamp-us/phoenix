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

`spend read --ledger <path> [--json]` emits JSON with `records`, `legacy` and `diagnostics`.
The ledger mode always emits JSON. `records` holds the version-2 envelopes, including notices;
`legacy` holds decoded version-1 evaluation rows without invented issue attribution. Diagnostics
count `malformed`, `newerVersion`, `duplicates` and `conflicts`. Conflicting records remain visible;
consumers cannot sum them as independent responses. A successful read is not a completeness claim.
An empty ledger yields empty arrays, with no measured zero or complete run manufactured.
Exit 7 means the path is absent; exit 11 means it could not be read.

The positional `spend read <transcript>` interface retains the legacy Claude-shaped reconstruction.
It cannot be combined with `--ledger`. `spend rollup` still uses the version-1 evaluation reader;
it reports version-2 rows as skipped newer rows. Use ledger-mode `spend read` for attributed records.
Issue/run/model aggregation belongs to the later summary slice.

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
```

These are independent processes. [record.cli.test.ts](../src/spend/record.cli.test.ts) exercises
that journey, copied history and competing processes. [usage-ledger.unit.test.ts](../src/spend/usage-ledger.unit.test.ts)
uses actual files for interrupted appends, replay, legacy reads and recording failure recovery.
