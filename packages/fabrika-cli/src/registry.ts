/**
 * The fabrika verb-group registry — the extension seam.
 *
 * One row per verb group exposed as `fabrika <group> <verb> …`. The root command and its
 * `--help` index both read this array, so a group appears under `--help` by being registered and
 * nowhere else: the index is **derived from the registry, never hand-maintained**, which is the
 * defect a parallel hand-written list reintroduces the moment it drifts.
 *
 * The `Name`/`Input` slots sit at `any` because the Effect CLI types demand it here: both
 * are contravariant, so a concrete literal name (`"adr"`) is not assignable to `string` and a
 * group's concrete flag shape is not assignable from `object`. Only `any` admits groups with
 * different names and inputs into one array. The requirement row is bounded by the Node platform
 * services the bin provides; a group needing more bakes its own layer in with `Command.provide`
 * before registering.
 */
import type {NodeServices} from "@effect/platform-node";
import type {Command} from "effect/unstable/cli";
import {adrCommand} from "./adr/command.ts";
import {buildCommand} from "./build/command.ts";
import {glossaryCommand} from "./glossary/command.ts";
import {governanceCommand} from "./governance/command.ts";
import {graduateCommand} from "./graduate/command.ts";
import {grillCommand} from "./grill/command.ts";
import {handoffCommand} from "./handoff/command.ts";
import {healCiCommand} from "./heal-ci/command.ts";
import {hookCommand} from "./hook/command.ts";
import {laneCommand} from "./lane/command.ts";
import {ledgerCommand} from "./ledger/command.ts";
import {mapCommand} from "./map/command.ts";
import {patternCommand} from "./pattern/command.ts";
import {planCommand} from "./plan/command.ts";
import {reportCommand} from "./report/command.ts";
import {reviewCommand} from "./review/command.ts";
import {reviewUiCommand} from "./review-ui/command.ts";
import {shipCommand} from "./ship/command.ts";
import {spendCommand} from "./spend/command.ts";
import {spikeCommand} from "./spike/command.ts";
import {statusCommand} from "./status/command.ts";
import {triageCommand} from "./triage/command.ts";
import {uiCommand} from "./ui/command.ts";
import {wireCommand} from "./wire/command.ts";

/** A registered verb group: a top-level `Command` whose name is the `fabrika <name>` selector. */
export type VerbGroup = Command.Command<any, any, object, unknown, NodeServices.NodeServices>;

/** The registered groups, in the order they list under `--help`. */
export const registeredGroups: ReadonlyArray<VerbGroup> = [
	adrCommand,
	buildCommand,
	glossaryCommand,
	governanceCommand,
	graduateCommand,
	grillCommand,
	handoffCommand,
	healCiCommand,
	hookCommand,
	laneCommand,
	ledgerCommand,
	mapCommand,
	patternCommand,
	planCommand,
	reportCommand,
	reviewCommand,
	reviewUiCommand,
	shipCommand,
	spendCommand,
	spikeCommand,
	statusCommand,
	triageCommand,
	uiCommand,
	wireCommand,
];
