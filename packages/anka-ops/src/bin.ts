#!/usr/bin/env node
/**
 * `anka-ops` — the operator CLI for anka-built apps (ADR 0045).
 *
 * Credentials resolve keychain-first (`auth login`), falling back to $CLOUDFLARE_API_TOKEN /
 * $CLOUDFLARE_ACCOUNT_ID — the env path CI keeps using. The command tree, the verb-group
 * registry, and the credential seam live in `cli.ts`; this shell just runs them.
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
