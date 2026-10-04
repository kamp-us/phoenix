import {NodeServices} from "@effect/platform-node";
import {Effect, Layer} from "effect";
import {Command} from "effect/unstable/cli";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {afterEach, describe, expect, it, vi} from "vitest";
import {EXCESS_OPERAND_NAME} from "../excess-operand.ts";
import {fabrikaCommand} from "../root-command.ts";
import {FAILED} from "../verb.ts";
import {setupCommand} from "./command.ts";

/** A `Param` as this test reads it: a combinator chain over a `Single` that carries the name. */
interface ParamNode {
	readonly _tag?: string;
	readonly name?: string;
	readonly param?: ParamNode;
}

const declaredName = (param: ParamNode): string | undefined => {
	let node: ParamNode | undefined = param;
	while (node !== undefined && node._tag !== "Single") node = node.param;
	return node?.name;
};

describe("`fabrika setup` takes flags only", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// A positional of its own would bind the first word after `setup`, so a sub-command added under
	// it later could never be reached.
	it("declares no positional argument beyond the shared stray-word guard", () => {
		const declared = (setupCommand as {config?: {arguments?: ReadonlyArray<ParamNode>}}).config
			?.arguments;
		expect(declared?.map(declaredName)).toEqual([EXCESS_OPERAND_NAME]);
	});

	it("refuses a stray word with a non-zero exit before any step runs", async () => {
		const exit = vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("exit");
		});
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		await Effect.runPromiseExit(
			Command.runWith(fabrikaCommand, {version: "test"})(["setup", "stray"]).pipe(
				Effect.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer)),
			),
		);

		expect(exit).toHaveBeenCalledWith(FAILED);
		expect(stderr).toHaveBeenCalledWith(
			'fabrika: unexpected operand "stray" for "fabrika setup" — the verb declares no argument to bind it to\n',
		);
		expect(stdout).not.toHaveBeenCalled();
	});
});
