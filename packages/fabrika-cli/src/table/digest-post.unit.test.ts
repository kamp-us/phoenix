/**
 * The webhook post over real HTTP, against a server on the loopback interface: the request each
 * tool is sent, and that a failure names no part of the URL.
 */
import {createServer, type Server} from "node:http";
import type {AddressInfo} from "node:net";
import {Effect} from "effect";
import {afterEach, describe, expect, it} from "vitest";
import {postWebhook} from "./digest-post.ts";

interface Seen {
	readonly method: string;
	readonly url: string;
	readonly contentType: string;
	readonly body: unknown;
}

let server: Server | null = null;

afterEach(async () => {
	const open = server;
	server = null;
	if (open !== null) await new Promise((done) => open.close(done));
});

const standIn = async (status: number, answer: string) => {
	const seen: Seen[] = [];
	const listening = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			seen.push({
				method: request.method ?? "",
				url: request.url ?? "",
				contentType: request.headers["content-type"] ?? "",
				body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
			});
			response.writeHead(status);
			response.end(answer);
		});
	});
	server = listening;
	await new Promise<void>((done) => listening.listen(0, "127.0.0.1", done));
	const {port} = listening.address() as AddressInfo;
	return {seen, url: new URL(`http://127.0.0.1:${port}/hooks/secret-token`)};
};

describe("postWebhook", () => {
	it("sends Slack a JSON `text`", async () => {
		const {seen, url} = await standIn(200, "ok");

		expect(await Effect.runPromise(postWebhook("slack", url, "hello"))).toEqual({
			_tag: "Ok",
			value: null,
		});
		expect(seen).toEqual([
			{
				method: "POST",
				url: "/hooks/secret-token",
				contentType: "application/json",
				body: {text: "hello"},
			},
		]);
	});

	it("sends Discord a JSON `content` and asks it to wait for the save", async () => {
		const {seen, url} = await standIn(200, "{}");

		expect((await Effect.runPromise(postWebhook("discord", url, "hello")))._tag).toBe("Ok");
		expect(seen).toEqual([
			{
				method: "POST",
				url: "/hooks/secret-token?wait=true",
				contentType: "application/json",
				body: {content: "hello", allowed_mentions: {parse: []}, flags: 4},
			},
		]);
	});

	it("names the status and the tool's error token on a refused post, and no part of the URL", async () => {
		const {url} = await standIn(400, "invalid_payload");
		const refused = await Effect.runPromise(postWebhook("slack", url, "hello"));

		expect(refused).toEqual({_tag: "Failure", reason: "HTTP 400 (invalid_payload)"});
	});

	it("names only the platform's error code when the request never completes", async () => {
		const {url} = await standIn(200, "ok");
		const closing = server as Server;
		server = null;
		await new Promise((done) => closing.close(done));
		const failed = await Effect.runPromise(postWebhook("discord", url, "hello"));

		expect(failed).toEqual({
			_tag: "Failure",
			reason: "the request did not complete (ECONNREFUSED)",
		});
	});
});
