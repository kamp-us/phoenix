---
id: 0445
title: A Tuval port is declared over a plain synchronous validator, never a transforming schema
status: accepted
date: 2026-09-30
tags: [tuval, ports, authoring, schema]
---

# 0445 — A Tuval port is declared over a plain synchronous validator, never a transforming schema

**What this decides:** a port's schema only checks a payload. It never turns the wire value into a
different value, so an `update` cell receives exactly the payload that arrived, after it passed the
check. A schema whose decode is asynchronous is out of bounds too. Decoding on arrival is deferred
to its own ticket.

Transcribes the ruling on
[#8746](https://github.com/kamp-us/phoenix/issues/8746#issuecomment-5625041873) (2026-09-10 PT),
taken under the founder's standing ruling on #8807 (R4.1) that engine calls are the driver's:
"Build option B now: keep the plain-validator rule, state it where the author meets the type error,
correct epic #8716's R13.1 wording, and rule #8749's async-filter case out of bounds the same way.
File A (decode on arrival) as its own ticket for the first port that actually needs a transform."

## Context

`port.in`, `port.out` and `port.request`
([`packages/tuval/src/authoring/port.ts`](../packages/tuval/src/authoring/port.ts)) take a schema
typed `PortCodec<T> = Schema.Codec<T, T, never, unknown>`. They compile it to the registry row's
`accepts`, which is `Schema.is(schema)`. The row types that test as
`(payload: unknown) => payload is T`, and `Receiver<M>` as `(payload: never) => M` over the payload
that passed it ([`packages/tuval/src/registry/program.ts`](../packages/tuval/src/registry/program.ts)).
A type predicate narrows the value it was handed and cannot return another one, and nothing between
the port pump (`packages/tuval/src/ports/wiring.ts`) and the program's `update` runs a decode.

Epic #8716 said the opposite in prose: "an in-port arrival is an `update` event carrying the decoded
payload", and "`accepts` is the schema's own decode". So a port over `Schema.DateFromString` (a string on the
wire, a `Date` in the program) was refused at the declaration with a bare type error and no rule
behind it. #8746 asked which side was wrong: A, the arrival path decodes, or B, the constraint is the
rule.

The sibling case, #8749: a schema built with `Schema.decode` over `SchemaGetter.checkEffect` keeps
its encoded side equal to its decoded side and its `R` at `never`, so it satisfies `PortCodec`. If
that effect is asynchronous, `Schema.is` throws instead of answering `false`. The pin says so in
`effect@4.0.0-rc.112`'s `SchemaParser.ts`: "Causes that contain defects, interruptions, or
asynchronous work at this synchronous boundary throw an `Error` whose cause is the underlying
`Cause`."

## Decision

**A Tuval port's schema is a plain synchronous validator: its encoded form is its decoded form, its
decode needs no service, and its decode completes synchronously.**

1. **Option B stands.** `PortCodec` keeps its encoded-equals-decoded and no-service halves. A
   transforming schema (`Schema.DateFromString`, `Schema.NumberFromString`, any `Schema.decodeTo`
   transform) is refused where the author declares the port.
2. **The rule is stated where the author meets the type error.** That is `PortCodec`'s docblock in
   `port.ts`, which the editor shows on the refused argument, and it links here.
3. **What `update` receives is the admitted payload.** It is the wire value that passed `accepts`,
   unchanged. Because the schema is a plain validator, the admitted payload and the decoded one are
   the same value; that identity is the only sense in which an arrival is "decoded". This corrects
   epic #8716's R13.1 prose ("carrying the decoded payload", "`accepts` is the schema's own decode")
   and the matching sentences in
   [`packages/tuval/src/authoring/define-program.ts`](../packages/tuval/src/authoring/define-program.ts).
4. **An asynchronous decode is out of bounds on the same rule.** `PortCodec`'s type cannot see
   whether a decode is synchronous, so the stated rule covers what the type does not. Making a bad
   payload on such a port come out as a refusal instead of a defect in `emit` is #8749's work, built
   under this rule: close it at the declaration or at the pump. Neither route legalises async
   decode.
5. **Decode on arrival (option A) is deferred, not rejected.** It is filed as
   [#10296](https://github.com/kamp-us/phoenix/issues/10296), to build when the first port needs a
   transform. Landing it supersedes this record.

**Binding constraints.**

- No port declaration widens `PortCodec` past `Schema.Codec<T, T, never, unknown>` while this record
  stands.
- No code or doc describes an in-port arrival as carrying a transformed or decoded-into-a-new-value
  payload. The payload `update` receives is the admitted wire value.
- A hand-written row's published schema (`PortPayloadSchema` in `registry/program.ts`, `PayloadSchema`
  in `packages/tuval/src/ai-agent/ports/payloads.ts`) obeys the same three halves.

## Consequences

- An author who wants a `Date` or a parsed id on a port sends the plain wire form and converts inside
  `update`. That costs one line per cell and keeps the arrival path free of a decode stage.
- `testProgram` still runs `Schema.decodeUnknownResult` over an arrival
  (`packages/tuval/src/authoring/test-program.ts`). Under this rule that decode is the identity, so
  the helper and the kernel agree. If #10296 lands, the two must change together.
- Epic [#8716](https://github.com/kamp-us/phoenix/issues/8716)'s body now says "admitted payload"
  where its plan said "decoded payload", and each correction links here. The verbatim original
  brief keeps its wording, with a correction note beside the sentence.
