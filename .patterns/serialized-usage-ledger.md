# Serialized usage ledger

The spend recorder holds one filesystem lock across identity comparison, append, sync and read-back.
Its caller gets a value describing success or failure, so recording does not fail the original task.

## Current implementation

[usage-ledger.ts](../packages/fabrika-cli/src/spend/usage-ledger.ts) resolves the existing file, or
its existing parent directory on first use, before choosing `<ledger>.lock`. A nonrecursive directory
creation claims that lock. Only `AlreadyExists` causes a bounded retry; other filesystem failures
return immediately. A scoped finalizer releases the lock. Release failure is itself reported.

The entire read, identity comparison and append happens while the lock is held. Comparing before
acquiring the lock lets two processes both see an absent record. A retry with an already persisted
record still syncs and verifies it, covering a prior failure after append but before acknowledgment.
Changed measurements under one identity refuse instead of silently replacing earlier counters.
The sole binding refinement fills an unknown issue while retaining every other field, as defined
in the [identity contract](../packages/fabrika-cli/docs/usage-recording.md#identity-and-storage).
That append uses the same lock and read-back checks.

The shared [appendFile](../packages/fabrika-cli/src/io/fs.ts) inserts a newline after an interrupted
tail. It retains the damaged bytes. The versioned reader counts that damaged line, while a new row
remains readable. Exact duplicate lines collapse on read too; conflicting variants remain visible.

The real-filesystem test runs this case:

```ts
writeFileSync(path, '{"v":2,"kind":');
const results = await Promise.all(
	Array.from({length: 20}, () => live(recordUsage(path, fixture))),
);
```

[usage-ledger.unit.test.ts](../packages/fabrika-cli/src/spend/usage-ledger.unit.test.ts) proves one
recorded result, nineteen duplicates and one retained malformed-line diagnostic.
[record.cli.test.ts](../packages/fabrika-cli/src/spend/record.cli.test.ts) also drives competing
recorder processes and reads the result in another process.

## Limits

This is a local, cooperating-writer protocol. It does not cover hard-link aliases, raw appenders,
network filesystem semantics or power loss before a new directory is durable. Locks are never
stolen based on time. After a killed process, stop all writers, explicitly remove the abandoned
lock directory and replay the record. A crash may leave a partial append, but not an invented zero.

Effect resource ownership follows [LLMS.md, Managing resources and Scopes](https://github.com/Effect-TS/effect/blob/main/LLMS.md#managing-resources-and-scopes)
and the pinned `FileSystem.open`/`File.sync` contract. The host-facing field and result definitions
live in [usage-recording.md](../packages/fabrika-cli/docs/usage-recording.md).
