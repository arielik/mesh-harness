#!/usr/bin/env node
import pkg from "../package.json" with { type: "json" };
import { dispatch, type Command } from "./cli/index.ts";

const commands: Command[] = [];

const code = await dispatch(process.argv.slice(2), commands, pkg.version, (s) => process.stdout.write(`${s}\n`));
process.exitCode = code;
