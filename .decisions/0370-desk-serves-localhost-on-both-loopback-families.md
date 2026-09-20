---
id: 0370
title: The Tuval desk serves localhost on both loopback families, and refuses a requested port either one has taken
status: accepted
date: 2026-09-09
tags: [tuval, page, dev-server, localhost, ports]
---

# 0370 — The Tuval desk serves localhost on both loopback families, and refuses a requested port either one has taken

**What this decides:** `localhost:<port>` is the Tuval desk's supported address. The page server
binds both loopback addresses — `127.0.0.1` and `::1` — so whichever one the browser resolves
reaches the desk. A *requested* port that either family has already taken refuses the start, naming
the taken address; the default `port: 0` keeps its fallback and simply picks a port free on both.
The desk stays loopback-only: nothing here widens it to the LAN.

Founder ruling: <https://github.com/kamp-us/phoenix/issues/8593#issuecomment-5609491263> — "Ruled:
the Tuval desk page server binds both the IPv4 and IPv6 loopback addresses."

## Context

The incident (#8593): the desk ran on `127.0.0.1:5173` and a bare `vite` from another worktree ran
on `[::1]:5173`. Neither failed to bind. Chrome resolved `localhost` to `::1`, so the founder opened
his desk's URL and got the other app, with no error anywhere.

The obvious fix — `host: "localhost"` — does not do it, and Vite says so in
[`server.host`'s docs](https://vite.dev/config/server-options#server-host). The installed source
agrees (`vite@8.1.5`, `dist/node/chunks/node.js`): `resolveHostname` returns **one** `host` string,
`startServer` hands that one string to `httpServerStart`, and `httpServerStart` calls
`tryBindServer(httpServer, port, host)` — one `listen`, one address. `strictPort` only stops the
port scan; it has nothing to say about the other family.

So covering both families takes an explicit second listener, and the desk's address contract has to
say what happens when only one of them is free.

## Decision

1. **`localhost:<port>` is the supported desk address.** The page server binds every loopback
   address it can, and prints the `localhost` URL — the address a founder types.
2. **A requested port binds both families or neither.** Falling back would put the desk on some
   other port while whatever it collided with keeps answering the URL the founder typed: the same
   silent swap with an extra step. The refusal names the taken address (`[::1]:5173`), because that
   is what tells the founder which program to go find.
3. **`port: 0` keeps its fallback.** That is `pnpm dev`'s "any free port", and it now means a port
   free on *both* families.
4. **A family this machine does not have is not a collision.** Binding `::1` on a host with IPv6
   switched off answers `EADDRNOTAVAIL`, and the desk serves the families it has.
5. **Loopback only.** No wildcard host, no LAN.

## Implementation

- [`apps/tuval/src/page/loopback.ts`](../apps/tuval/src/page/loopback.ts) — `reserveLoopbackPort`
  settles the port across both families before Vite exists, and `forwardLoopback` accepts on the
  family Vite did not bind, handing each connection to the page's own `http.Server` with
  `emit("connection", …)`. One HTTP server answers both addresses, so there is one middleware stack,
  one HMR websocket and one module graph — a proxy would have had to re-implement all three.
- [`apps/tuval/src/page/dev-server.ts`](../apps/tuval/src/page/dev-server.ts) — `servePage` takes the
  reservation, hands Vite `strictPort: true` on the reserved port, binds the forwarder inside the
  caller's `Scope`, and returns the `localhost` URL plus the addresses behind it.
- [`apps/tuval/src/bin.ts`](../apps/tuval/src/bin.ts) — prints
  `tuval: desk at http://localhost:<port>/ — 127.0.0.1 and [::1]` once both are bound.
- The `strictPort` option and the pi proof's `--strict-port` flag are gone: a requested port is now
  always bound exactly or refused, which is what that flag asked for (#7992).

**The verification case** is the reported one and it is a unit test
([`loopback.unit.test.ts`](../apps/tuval/src/page/loopback.unit.test.ts)): a listener holding
`[::1]:<port>` makes a start on that explicit port refuse, naming `[::1]`. That is distinct from a
collision on the desk's own bound address (`127.0.0.1:<port>`), which refuses naming `127.0.0.1`,
and from the `port: 0` path, where a taken `[::1]` is skipped rather than refused.

## Consequences

- The reservation is released before Vite binds it, so a program that takes the port in that window
  still wins the race. The loss is loud — `strictPort: true` refuses — never a silent move.
- Two desks can still run at once: they take different ports, because `port: 0` is the default.
- A `[::1]`-only program on a requested port now blocks the desk's start where it used to be
  invisible. That is the point: the collision is reported instead of served.
- The forwarder ends the connections it accepted before it closes. They are adopted by the page
  server, which is torn down after it, so waiting on them instead would never settle — and the wait
  would land on Ctrl-C, in front of the kernel's checkpoint.

## Records

`no vocabulary impact` — "reservation" and "forwarder" name two values inside
`apps/tuval/src/page/loopback.ts` and are not corpus-level terms; nothing in `.glossary/` changes.
