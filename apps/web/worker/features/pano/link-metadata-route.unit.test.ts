/**
 * The SSRF-safe redirect loop of the pano link-metadata route (#1642). The
 * initial-URL guard (`isSafeFetchUrl`) is unit-tested in
 * `link-metadata.unit.test.ts`; this file covers the OTHER SSRF surface — a
 * public URL that 3xx-redirects to a private/metadata target. `fetch` is
 * injected, so the manual-redirect loop is exercised offline: a redirect to a
 * private IP is refused, a chain past {@link MAX_REDIRECT_HOPS} is refused, and
 * a single normal public redirect still resolves.
 */
import {describe, expect, it, vi} from "vitest";
import {MAX_REDIRECT_HOPS} from "./link-metadata.ts";
import {fetchFollowingSafeRedirects} from "./link-metadata-route.ts";

/** A 3xx redirect Response carrying a `Location` header. */
const redirectTo = (location: string, status = 302): Response =>
	new Response(null, {status, headers: {location}});

/** A terminal 200 HTML Response. */
const ok = (body = "<title>ok</title>"): Response =>
	new Response(body, {status: 200, headers: {"content-type": "text/html"}});

const signal = new AbortController().signal;

describe("fetchFollowingSafeRedirects — SSRF via redirect", () => {
	it("refuses a redirect to a private/metadata IP (does not fetch the target)", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(redirectTo("http://169.254.169.254/latest/meta-data/"));

		const res = await fetchFollowingSafeRedirects(
			new URL("https://public.example/start"),
			signal,
			fetchImpl,
		);

		expect(res).toBeNull();
		// only the initial public URL was fetched — the private target never was.
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(fetchImpl).toHaveBeenCalledWith("https://public.example/start", expect.anything());
	});

	it("re-screens every hop — a public→public→private chain is refused mid-chain", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(redirectTo("https://public.example/hop2"))
			.mockResolvedValueOnce(redirectTo("http://10.0.0.1/internal"));

		const res = await fetchFollowingSafeRedirects(
			new URL("https://public.example/start"),
			signal,
			fetchImpl,
		);

		expect(res).toBeNull();
		// followed the first public hop, refused the second — the private target never fetched.
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(fetchImpl).not.toHaveBeenCalledWith("http://10.0.0.1/internal", expect.anything());
	});

	it("refuses a redirect chain that exceeds MAX_REDIRECT_HOPS", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
			// every hop redirects to the next public URL — an unbounded public chain.
			const n = Number(new URL(String(input)).searchParams.get("n") ?? "0");
			return redirectTo(`https://public.example/hop?n=${n + 1}`);
		});

		const res = await fetchFollowingSafeRedirects(
			new URL("https://public.example/hop?n=0"),
			signal,
			fetchImpl,
		);

		expect(res).toBeNull();
		// initial fetch + MAX_REDIRECT_HOPS follows, then refuse — never unbounded.
		expect(fetchImpl).toHaveBeenCalledTimes(MAX_REDIRECT_HOPS + 1);
	});

	it("follows a single normal public redirect and resolves the terminal page", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(redirectTo("https://public.example/final"))
			.mockResolvedValueOnce(ok("<title>final</title>"));

		const res = await fetchFollowingSafeRedirects(
			new URL("https://public.example/start"),
			signal,
			fetchImpl,
		);

		expect(res).not.toBeNull();
		expect(res?.status).toBe(200);
		expect(await res?.text()).toBe("<title>final</title>");
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(fetchImpl).toHaveBeenLastCalledWith("https://public.example/final", expect.anything());
	});

	it("returns the terminal response directly when there is no redirect", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(ok());

		const res = await fetchFollowingSafeRedirects(
			new URL("https://public.example/direct"),
			signal,
			fetchImpl,
		);

		expect(res?.status).toBe(200);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("uses redirect:manual on every hop (never lets fetch auto-follow)", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(redirectTo("https://public.example/final"))
			.mockResolvedValueOnce(ok());

		await fetchFollowingSafeRedirects(new URL("https://public.example/start"), signal, fetchImpl);

		for (const call of fetchImpl.mock.calls) {
			expect((call[1] as RequestInit).redirect).toBe("manual");
		}
	});
});
