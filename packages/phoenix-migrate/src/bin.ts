#!/usr/bin/env -S node --experimental-strip-types
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Command from "effect/unstable/cli/Command";
import {command} from "./index.ts";

const cli = Command.run(command, {version: "0.0.0"});

cli.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
