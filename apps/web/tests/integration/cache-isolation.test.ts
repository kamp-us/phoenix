import {describe, expect, it} from "vitest";
import {sharedStack} from "./_integration.ts";
import {nsToken} from "./_stage-name.ts";

const h = sharedStack();
const NS = nsToken(import.meta.url);
const sessionPath = `/api/auth/get-session?cacheRegression=${NS}`;
const shellPath = `/?cacheRegression=${NS}`;

const expectPrivate = (response: Response) => {
	expect(response.status).toBe(200);
	expect(response.headers.get("cache-control")).toBe("private, no-store");
	expect(response.headers.get("cf-cache-status")).not.toBe("HIT");
};

async function sessionUser(cookie?: string): Promise<string | null> {
	const response = await h.req(sessionPath, cookie ? {headers: {cookie}} : undefined);
	expectPrivate(response);
	const body = (await response.json()) as {user: {id: string}} | null;
	return body?.user.id ?? null;
}

async function shellUser(cookie?: string): Promise<string | null> {
	const response = await h.req(shellPath, cookie ? {headers: {cookie}} : undefined);
	expectPrivate(response);
	const html = await response.text();
	const boot = html.match(/<script>window\.__BOOT__=(.*?)<\/script>/s);
	expect(boot, "the deployed HTML must contain its resolved boot state").not.toBeNull();
	const payload = JSON.parse(boot![1]!) as {user: {id: string} | null};
	return payload.user?.id ?? null;
}

describe("session and shell responses stay private with Workers Cache enabled", () => {
	it("uses fresh identity at the same URL before signup, across users, and after logout", async () => {
		// The first anonymous reads would populate the shared cache without no-store.
		expect(await sessionUser()).toBeNull();
		expect(await shellUser()).toBeNull();
		const first = await h.signUp(`${NS}-first@test.local`, "hunter2hunter2", "First");
		expect(await sessionUser(first.cookie)).toBe(first.userId);
		expect(await shellUser(first.cookie)).toBe(first.userId);
		const second = await h.signUp(`${NS}-second@test.local`, "hunter2hunter2", "Second");
		expect(await sessionUser(second.cookie)).toBe(second.userId);
		expect(await shellUser(second.cookie)).toBe(second.userId);
		expect(await sessionUser()).toBeNull();
		expect(await shellUser()).toBeNull();

		const signedOut = await h.json("/api/auth/sign-out", {}, first.cookie);
		expect(signedOut.status).toBe(200);
		expect(await sessionUser(first.cookie)).toBeNull();
		expect(await shellUser(first.cookie)).toBeNull();
		expect(await sessionUser(second.cookie)).toBe(second.userId);
	});
});
