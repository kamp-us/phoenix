# CI-legible integration tests — fail fast, name the cause in CI stdout

Integration tests (the real-Cloudflare deployed tier — [alchemy-test-harness.md](./alchemy-test-harness.md),
[ADR 0082](../.decisions/0082-two-test-tiers-unit-integration.md)) run **only in
CI**. No agent runs them locally — no agent is issued a Cloudflare deploy token — and
there is **no local / unit-tier fake** standing in for a real-Cloudflare path
(ADR: `integration-tier-is-ci-only`, [0154](../.decisions/0154-integration-tier-is-ci-only.md)).
That is tolerable **only because** every integration test is made *CI-legible*: when
it fails, it fails fast and **names its cause in the CI stdout line itself** — never a
blind suite-timeout that names nothing. This doc makes that discipline the default for
every integration test, so no future test regresses to the ~50-minute blind loop #2049
became before it was fixed (a former ~50-minute guess-loop → a ~2-second named cause).

An agent reading CI is otherwise blind: worker logs go to Cloudflare's log stream, not
CI stdout, and a held-open SSE stream never closes — so a test that waits on delivery
with no bound and no direct-response assertion hangs until the suite timeout and prints
only `timed out`, telling the agent nothing about *which* stage broke. These rules make
the failure line the diagnosis.

## The three rules

Each is grounded in `apps/web/tests/integration/fate-live-reactions.test.ts` (#2049),
the worked example — a subscribe → react → SSE-delivery test that must distinguish
"the precondition didn't take" from "the frame was lost in delivery" from CI stdout
alone.

### 1. Assert the decisive signal on the direct HTTP response, BEFORE any long/streaming wait

A silent timeout names nothing. The **direct** response of the mutation/write that
drives the test carries the decisive precondition signal — so assert it there, *before*
entering the SSE read. A wrong precondition (a flag that didn't take, a write that
didn't land) then fails in **milliseconds** with a clear message, instead of hanging
the streaming read for the full budget while looking like a delivery failure.

In #2049 both branches of the dark-shipped mutation return `ok: true`, so `ok` alone
cannot tell a working flag from an inert one. The reactor's own emoji on the direct
mutation return is the discriminator — flag-ON stamps `myReaction`, the inert OFF
branch leaves it `null`:

```ts
// CAUSE-1 DISCRIMINATOR (fail fast, before the SSE read). BOTH branches return
// ok:true, so the ok check above cannot tell an effective flag from an inert one —
// only the reactor's own emoji on the DIRECT mutation return does. Asserting it here
// makes a silently ineffective flag override fail in milliseconds instead of hanging
// the SSE read for the full test budget.
const directReaction = (reacted.ok ? reacted.data : undefined) as
	| {reactions?: {myReaction: string | null}}
	| undefined;
expect(
	directReaction?.reactions?.myReaction,
	`expected direct react response myReaction=👍 (flag ON), got ${JSON.stringify(
		directReaction?.reactions?.myReaction ?? null,
	)} — phoenix-reactions flag did not take effect on the deployed stage`,
).toBe("👍");
```

The DO-accept gate is the same shape at the control-message boundary: a `200` envelope
can still carry `results: [{ok: false}]` when the connection DO rejects the register,
which would silently drop the publish and time out the read — so gate on the register
result *before* subscribing to delivery:

```ts
// A 200 envelope can still carry results:[{ok:false}] when the DO rejects the
// register, which would silently drop the publish and time out the read below.
const subResult = (await sub.json()) as {results: Array<{id: string; ok: boolean}>};
expect(subResult.results[0]?.ok).toBe(true);
```

The principle: **every precondition for the eventual delivery gets its own
direct-response assertion up front.** A precondition proven directly can never masquerade
as a delivery timeout.

### 2. Cap every wait well below the suite timeout, with a DISTINCT message per failure mode

A held stream never closes, so `reader.read()` blocks until the whole suite times out
with no signal. Race every streaming read against a **shared deadline set well below**
the suite timeout, and word each deadline's message so the **stdout line itself names
which stage failed** — precondition vs delivery — not just "timed out". Because rule 1
already proved the precondition on the direct response, a deadline that trips *here*
means the publish was **lost in delivery**, and the message says exactly that:

```ts
// CAUSE-2 DISCRIMINATOR (fail at ~10s, not the 120s test budget). The direct response
// above proved the flag is ON and the mutation published, so a missing frame now means
// the publish was LOST in delivery, not that the flag is off. The held stream never
// closes, so readEvent would otherwise block until the whole test times out with no
// signal — race every read against a shared 10s deadline.
const READ_DEADLINE_MS = 10_000;
let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
const deadline = new Promise<never>((_, reject) => {
	deadlineTimer = setTimeout(
		() =>
			reject(
				new Error(
					"no reaction update frame received within 10s (flag ON, publish fired) — frame lost in delivery",
				),
			),
		READ_DEADLINE_MS,
	);
});
try {
	for (let i = 0; i < 10 && payload?.event.data.reactions.myReaction !== "👍"; i++) {
		const frame = await Promise.race([readEvent(reader, decoder, buffer), deadline]);
		payload = frameData<ReactionNext>(frame);
	}
} finally {
	clearTimeout(deadlineTimer);
}
```

Two properties make this legible, not just bounded:

- **The cap sits under the suite timeout** (here 10s vs the 120s Vitest budget), so the
  named error wins the race — the test surfaces *its* message, never Vitest's generic
  timeout.
- **One message per failure mode.** The precondition failure (rule 1) reads "flag did
  not take effect"; the delivery failure reads "frame lost in delivery". The two are
  never confusable, because rule 1 having passed is what licenses rule 2's message to
  blame delivery.

`clearTimeout` in a `finally` keeps the timer from outliving a passing test.

### 3. No `console` probes on the worker / delivery path for diagnostics

The integration tier deploys to **real Cloudflare**; worker logs go to Cloudflare's log
stream, unreadable from CI stdout. A `console.log` on the worker or the delivery path is
pure noise in this loop — it never reaches the agent reading CI. Put the diagnostic
signal where the test client actually reads it: in **assertions on the HTTP / SSE
responses** (rules 1 and 2), whose messages *do* print to CI stdout. The reference test
carries **zero** worker-side probes; every signal it emits is an `expect` message or a
deadline-rejection error on a response the harness read.

## Rules

- **Direct-response first.** Assert the decisive precondition on the direct HTTP/mutation
  response before any streaming or long wait. If a wrong precondition can only surface as
  a downstream timeout, the test is not CI-legible — add the up-front assertion.
- **Cap under the suite budget.** Every wait on delivery is bounded by an explicit
  deadline set well below the Vitest suite timeout, so the named error wins the race.
- **One message per failure mode.** Word each assertion / deadline message so the stdout
  line names *which* stage broke (precondition vs delivery), grounded in what earlier
  assertions already proved.
- **Diagnose through responses, not `console`.** The signal lives in `expect` messages
  and rejection errors on the responses the test client reads — never in a worker-side
  `console` probe that vanishes into Cloudflare's log stream.
- **Clean up the timer.** Clear the deadline timer in a `finally` so it can't outlive a
  passing test.

## Anti-patterns

- **A bare `await reader.read()` on a held-open SSE stream.** The stream never closes; a
  lost publish hangs to the suite timeout and prints only `timed out`. Always race it
  against a capped deadline (rule 2).
- **Gating only on `ok: true` / a `200` status** when a dark-shipped or DO-mediated path
  can return success while doing nothing. Assert the discriminating field on the direct
  response (rule 1).
- **A single generic "timed out" message** for both a precondition miss and a delivery
  miss — it tells the agent nothing. One distinct message per mode (rules 1–2).
- **`console.log` on the worker to debug a red integration test.** It goes to
  Cloudflare's log stream, not CI; move the signal into a response assertion (rule 3).

## See also

- [ADR 0154](../.decisions/0154-integration-tier-is-ci-only.md) — the integration tier
  is CI-only (no local runs, no local fake); this legibility discipline is the condition
  that makes CI-only tolerable. Reference by **slug** in code comments
  (`// See ADR: integration-tier-is-ci-only`) so the ADR-numbering migration (#2058)
  doesn't break the link.
- [ADR 0082](../.decisions/0082-two-test-tiers-unit-integration.md) — the two test tiers;
  establishes the integration tier itself.
- [alchemy-test-harness.md](./alchemy-test-harness.md) — the harness these tests run on
  (`sharedStack()` / `integrationStack`, `openSse` / `liveControl`, the SSE frame
  readers); this doc is *how to write a legible test on that harness*.
- [effect-testing.md](./effect-testing.md) — picking the tier before you write the test.
