#!/usr/bin/env node
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli-new.ts [args...]
 */
process.title = "pi";
process.emitWarning = (() => {}) as typeof process.emitWarning;

import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { main } from "./main.js";

setGlobalDispatcher(new EnvHttpProxyAgent());

main(process.argv.slice(2)).catch((err: unknown) => {
	const message = err instanceof Error ? err.message : String(err);
	console.error(`Fatal: ${message}`);
	if (err instanceof Error && err.stack) {
		console.error(err.stack);
	}
	process.exitCode = 1;
});
