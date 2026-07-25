/**
 * The OS boundary of claim presence, asserted against the real machine — the one thing the pure
 * tests cannot reach: that the stamp identity fingerprints a MACHINE and not the hostname (why
 * that distinction decides whether a live agent gets evicted: `presence-io.ts` `readMachineId`).
 */
import {hostname} from "node:os";
import {assert, describe, it} from "@effect/vitest";
import {machineFingerprint} from "./claim-presence.ts";
import {localPresence, readMachineId} from "./presence-io.ts";

describe("localPresence — the stamp identity is machine-scoped, never hostname-scoped", () => {
	const machineId = readMachineId();

	it("fingerprints this machine's id, and NOT its hostname", () => {
		const host = localPresence().host;
		if (machineId === null) {
			// No resolvable machine identity on this platform ⇒ inconclusive by construction.
			assert.strictEqual(host, null);
			return;
		}
		assert.strictEqual(host, machineFingerprint(machineId));
		assert.notStrictEqual(host, machineFingerprint(hostname()));
	});

	it("resolves the same fingerprint on every read (stable within a machine)", () => {
		assert.strictEqual(localPresence().host, localPresence().host);
	});

	it("a probe of an impossible pid is `gone`, and of pid 1 is never `gone`", () => {
		// The real boundary, not a stub: `gone` (ESRCH) is the sole eviction signal, and a
		// live-but-unownable pid must read `unprobeable` rather than misread as death.
		const {probePid} = localPresence();
		assert.strictEqual(probePid(0x7ffffff), "gone");
		assert.notStrictEqual(probePid(1), "gone");
	});
});
