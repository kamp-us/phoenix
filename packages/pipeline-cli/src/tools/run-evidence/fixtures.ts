/**
 * Test fixtures for `run-evidence`: a real ZIP writer and a valid ADR 0054 §2 manifest.
 *
 * The archive is assembled byte-by-byte rather than mocked so the reader is exercised against an
 * actual central directory — a stubbed "unzip returns this string" fixture would prove nothing about
 * the case that mattered, an error body arriving where an archive was expected.
 */
import {deflateRawSync} from "node:zlib";
import type {Manifest} from "../crabbox-manifest/Manifest.ts";

const encoder = new TextEncoder();

export interface ZipEntryInput {
	readonly name: string;
	readonly content: string;
	/** `stored` (method 0) or `deflated` (method 8) — both shapes a real artifact can carry. */
	readonly compression?: "stored" | "deflated";
}

const u16 = (view: DataView, at: number, value: number): void => view.setUint16(at, value, true);
const u32 = (view: DataView, at: number, value: number): void => view.setUint32(at, value, true);

/** Assemble a minimal but genuinely well-formed ZIP archive. CRCs are zeroed — the reader ignores them. */
export const makeZip = (entries: ReadonlyArray<ZipEntryInput>): Uint8Array => {
	const prepared = entries.map((entry) => {
		const raw = encoder.encode(entry.content);
		const deflated = entry.compression === "deflated";
		const data = deflated ? new Uint8Array(deflateRawSync(raw)) : raw;
		return {name: encoder.encode(entry.name), data, uncompressed: raw.length, deflated};
	});

	const localSize = prepared.reduce((sum, e) => sum + 30 + e.name.length + e.data.length, 0);
	const centralSize = prepared.reduce((sum, e) => sum + 46 + e.name.length, 0);
	const out = new Uint8Array(localSize + centralSize + 22);
	const view = new DataView(out.buffer);

	let at = 0;
	const offsets: Array<number> = [];
	for (const entry of prepared) {
		offsets.push(at);
		u32(view, at, 0x04034b50);
		u16(view, at + 4, 20);
		u16(view, at + 8, entry.deflated ? 8 : 0);
		u32(view, at + 18, entry.data.length);
		u32(view, at + 22, entry.uncompressed);
		u16(view, at + 26, entry.name.length);
		out.set(entry.name, at + 30);
		out.set(entry.data, at + 30 + entry.name.length);
		at += 30 + entry.name.length + entry.data.length;
	}

	const centralStart = at;
	for (const [index, entry] of prepared.entries()) {
		u32(view, at, 0x02014b50);
		u16(view, at + 4, 20);
		u16(view, at + 6, 20);
		u16(view, at + 10, entry.deflated ? 8 : 0);
		u32(view, at + 20, entry.data.length);
		u32(view, at + 24, entry.uncompressed);
		u16(view, at + 28, entry.name.length);
		u32(view, at + 42, offsets[index] ?? 0);
		out.set(entry.name, at + 46);
		at += 46 + entry.name.length;
	}

	u32(view, at, 0x06054b50);
	u16(view, at + 8, prepared.length);
	u16(view, at + 10, prepared.length);
	u32(view, at + 12, centralSize);
	u32(view, at + 16, centralStart);
	return out;
};

/** A valid manifest for `commit`, with `checks` all pass and a clean test summary. */
export const manifestFor = (commit: string): Manifest => ({
	schemaVersion: 1,
	commit,
	run: {producer: "crabbox", timestamp: "2026-07-25T04:57:44Z", environment: "ci"},
	checks: [
		{name: "unit", status: "pass", exitCode: 0},
		{name: "bundle-node-core-free", status: "pass", exitCode: 0},
	],
	tests: {total: 2362, passed: 2362, failed: 0, skipped: 0, failures: []},
	logs: {ref: "run-log"},
});

/** The `run-evidence` artifact archive a producer publishes for `commit`. */
export const bundleZipFor = (commit: string): Uint8Array =>
	makeZip([
		{name: "manifest.json", content: JSON.stringify(manifestFor(commit)), compression: "deflated"},
		{name: "junit.xml", content: "<testsuites/>"},
	]);
