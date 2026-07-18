/**
 * Best-effort teardown at the JS Promise boundary (#3515).
 *
 * The run-scoped shared-stage teardown attempts one `Core.destroy` per run and is meant to be
 * STRICTLY best-effort: the leaked stage is swept out-of-band (#690), so a teardown failure must
 * NEVER red a green `test:integration` run. Neutralizing failures INSIDE the destroy Effect
 * (`Effect.catchCause`) is not enough — `Core.run` is `Effect.runPromise(toEffect(...))`, and
 * `toEffect` provides the `Cloudflare.state()` / `providers()` layers, the config load, and
 * `Effect.scoped(...)` finalization OUTSIDE that inner catch. A transient credential/network
 * failure in layer acquisition, or a scope-finalization defect, therefore escapes the inner catch
 * and rejects the returned teardown promise. A rejected vitest `globalSetup` teardown promise fails
 * the whole run (`ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL`) and dequeues an otherwise-clean PR from the
 * merge queue — the exact recurrence #3515 tracks. (#813's closed-PR `cleanup`-job "Verify
 * teardown" guard in `deploy.yml` is a different surface and never covered this path.) Best-effort
 * belongs at the boundary that actually gates the run — the returned Promise — not one Effect layer
 * beneath it, which is the boundary this helper enforces. See #3514 for the sibling structural
 * merge_group-vs-PR-head skip defect.
 */
export async function runBestEffortTeardown(
	teardown: () => Promise<unknown>,
	onLeak: (error: unknown) => void,
): Promise<void> {
	try {
		await teardown();
	} catch (error) {
		onLeak(error);
	}
}
