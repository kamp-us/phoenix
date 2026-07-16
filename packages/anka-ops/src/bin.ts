#!/usr/bin/env node
/**
 * `anka-ops` — the operator CLI for anka-built apps (`effect/unstable/cli`, the same shell shape
 * as `@kampus/cf-utils` / `@kampus/orphan-sweep`). The framework-tier skeleton (epic #2089,
 * ADR 0045): only the `auth` verb group ships here.
 *
 *   node src/bin.ts auth login              paste a scoped operator token → OS keychain
 *   node src/bin.ts auth status             report where credentials resolve from + whether they authenticate
 *   node src/bin.ts auth logout             clear the stored credentials
 *
 * Credentials resolve keychain-first (`auth login`), falling back to $CLOUDFLARE_API_TOKEN /
 * $CLOUDFLARE_ACCOUNT_ID — the env path CI keeps using. A missing/unauthorized credential
 * surfaces a typed error on the `E` channel, rendered by `NodeRuntime.runMain` (never a raw
 * stack trace). The command tree, the verb-group registry, and the credential seam live in
 * `cli.ts`; this shell just runs them.
 */
import {NodeRuntime} from "@effect/platform-node";
import {Effect} from "effect";
import {Command} from "effect/unstable/cli";
import {AnkaOpsRuntimeLayer, ankaOps} from "./cli.ts";

ankaOps.pipe(
	Command.run({version: "0.0.0"}),
	Effect.provide(AnkaOpsRuntimeLayer),
	NodeRuntime.runMain,
);
