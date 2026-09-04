/**
 * The Tuval protocol: the one versioned page-to-kernel wire (#7617 R1.3, R3.1).
 *
 * Prior art is the founder's wormhole `packages/wormhole/src/Protocol.ts` — one `Schema.Class` per
 * message, one union per direction, a decode that refuses. Read and re-derived, never imported;
 * wormhole's binary framing is deliberately left behind (see the note at `KernelToPage`).
 */

import {Schema} from "effect";
import {Desk, Window} from "./desk.ts";
import {CallId, Revision, SpellPath, WindowId} from "./ids.ts";
import {ProcessRow} from "./process-row.ts";
import {RegistryDescription} from "./registry-description.ts";

/**
 * Every message carries this, so a page and a kernel from different builds refuse each other by
 * decode rather than by behaviour. Bump it whenever a message's shape changes.
 */
export const PROTOCOL_VERSION = 1 as const;

const Version = Schema.Literal(PROTOCOL_VERSION);

/** The only page-to-kernel message. Windows, keys and the command line all speak this one shape. */
export class SpellCall extends Schema.Class<SpellCall>("SpellCall")({
	type: Schema.Literal("spell.call"),
	version: Version,
	id: CallId,
	path: SpellPath,
	/** Opaque here: the executor decodes it against the spell's own `params`. */
	args: Schema.Unknown,
	/** The window the call came from. The kernel resolves the scope; the page never names a process. */
	window: Schema.optionalKey(WindowId),
}) {}

/** A failed call, as the page reads it: enough to render the error inline under the palette input. */
export const SpellFailure = Schema.Struct({
	tag: Schema.String,
	message: Schema.String,
	/** The spell path the failure is about, when the failure has one. */
	path: Schema.optionalKey(SpellPath),
	/** What the argument at fault should have been. */
	expected: Schema.optionalKey(Schema.String),
	didYouMean: Schema.optionalKey(Schema.String),
});
export type SpellFailure = typeof SpellFailure.Type;

// `ok` and its payload travel together so a reply carrying both a result and an error cannot be
// built or decoded; the class holds the union rather than flattening it into optional fields.
const Succeeded = Schema.Struct({ok: Schema.Literal(true), result: Schema.Unknown});
const Failed = Schema.Struct({ok: Schema.Literal(false), error: SpellFailure});

export const SpellOutcome = Schema.Union([Succeeded, Failed]);
export type SpellOutcome = typeof SpellOutcome.Type;

export class SpellReply extends Schema.Class<SpellReply>("SpellReply")({
	type: Schema.Literal("spell.reply"),
	version: Version,
	id: CallId,
	outcome: SpellOutcome,
}) {}

/** The whole desk as the kernel holds it. A tab keeps only tab-ephemeral state (#7617 R1.3). */
export class Snapshot extends Schema.Class<Snapshot>("Snapshot")({
	type: Schema.Literal("snapshot"),
	version: Version,
	rev: Revision,
	desk: Desk,
	windows: Schema.Record(WindowId, Window),
	processes: Schema.Array(ProcessRow),
	registry: RegistryDescription,
}) {}

/** One path-addressed replace on the snapshot shape. */
export const Replace = Schema.Struct({
	op: Schema.Literal("replace"),
	/** Object keys and array indices, from the snapshot's root. */
	path: Schema.Array(Schema.String),
	value: Schema.Unknown,
});
export type Replace = typeof Replace.Type;

export class Patch extends Schema.Class<Patch>("Patch")({
	type: Schema.Literal("patch"),
	version: Version,
	/** The revision this patch produces; it applies only over the revision just below it. */
	rev: Revision,
	changes: Schema.Array(Replace),
}) {}

export const PageToKernel = Schema.Union([SpellCall]);
export type PageToKernel = typeof PageToKernel.Type;

/*
 * One union per direction, and JSON text is the whole wire: no binary framing and no channels
 * (#7617 R3.1). wormhole needed both because it carries raw terminal bytes; Tuval carries spell
 * calls and desk state, which are structured values, and a second framing layer would buy nothing
 * but a second thing to version. A program that streams raw bytes is what reopens this.
 */
export const KernelToPage = Schema.Union([SpellReply, Snapshot, Patch]);
export type KernelToPage = typeof KernelToPage.Type;
