/**
 * `grep_search` — regex ripgrep; high match cap for full file discovery (tau).
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import { ensureTool } from "../../utils/tools-manager.js";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.js";
import { resolveToCwd } from "./path-utils.js";
import { str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { truncateLine } from "./truncate.js";

const MATCH_CAP = 500;

const grepSearchSchema = Type.Object({
	query: Type.String({ description: "The regex pattern to search for" }),
	case_sensitive: Type.Optional(Type.Boolean({ description: "Whether the search should be case sensitive" })),
	exclude_pattern: Type.Optional(Type.String({ description: "Glob pattern for files to exclude" })),
	include_pattern: Type.Optional(Type.String({ description: "Glob pattern for files to include (e.g. '*.ts')" })),
	explanation: Type.Optional(
		Type.String({
			description: "One sentence explanation as to why this tool is being used, and how it contributes to the goal.",
		}),
	),
});

export type GrepSearchToolInput = Static<typeof grepSearchSchema>;

export function createGrepSearchToolDefinition(cwd: string): ToolDefinition<typeof grepSearchSchema, undefined> {
	return {
		name: "grep_search",
		label: "grep_search",
		description:
			"Fast regex search over text files (ripgrep). Results capped at 500 matches — use multiple queries if needed. Escape regex metacharacters for literal searches.",
		parameters: grepSearchSchema,
		async execute(
			_toolCallId,
			args: {
				query: string;
				case_sensitive?: boolean;
				exclude_pattern?: string;
				include_pattern?: string;
				explanation?: string;
			},
			signal: AbortSignal | undefined,
			_onUpdate,
			_ctx: ExtensionContext,
		) {
			const rgPath = await ensureTool("rg", true);
			if (!rgPath) throw new Error("ripgrep (rg) is not available");

			const searchPath = resolveToCwd(".", cwd);
			const rgArgs: string[] = ["--json", "--line-number", "--color=never", "--hidden"];
			if (args.case_sensitive === false) rgArgs.push("--ignore-case");
			if (args.include_pattern) rgArgs.push("--glob", args.include_pattern);
			if (args.exclude_pattern?.trim()) rgArgs.push("--glob", `!${args.exclude_pattern.trim()}`);
			rgArgs.push(args.query, searchPath);

			return new Promise((resolve, reject) => {
				const child = spawn(rgPath, rgArgs, { stdio: ["ignore", "pipe", "pipe"] });
				const rl = createInterface({ input: child.stdout });
				const linesOut: string[] = [];
				let n = 0;
				const onAbort = () => child.kill();
				signal?.addEventListener("abort", onAbort, { once: true });

				rl.on("line", (line) => {
					if (n >= MATCH_CAP) return;
					let ev: {
						type?: string;
						data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
					};
					try {
						ev = JSON.parse(line);
					} catch {
						return;
					}
					if (ev.type !== "match" || !ev.data?.path?.text) return;
					const rel = path.relative(cwd, ev.data.path.text).replace(/\\/g, "/") || ev.data.path.text;
					const ln = ev.data.line_number ?? 0;
					const t = (ev.data.lines?.text ?? "").replace(/\r/g, "");
					const { text: tl } = truncateLine(t);
					linesOut.push(`${rel}:${ln}: ${tl}`);
					n++;
					if (n >= MATCH_CAP) child.kill();
				});
				child.on("close", () => {
					signal?.removeEventListener("abort", onAbort);
					if (signal?.aborted) {
						reject(new Error("aborted"));
						return;
					}
					if (linesOut.length === 0) {
						resolve({ content: [{ type: "text", text: "No matches (or ripgrep error)." }], details: undefined });
						return;
					}
					let text = linesOut.join("\n");
					if (n >= MATCH_CAP) text += `\n[Truncated at ${MATCH_CAP} matches]`;
					resolve({ content: [{ type: "text", text }], details: undefined });
				});
				child.on("error", reject);
			});
		},
		renderCall(args, theme, context) {
			const q = str(args?.query);
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				theme.fg("toolTitle", theme.bold("grep_search")) + " " + theme.fg("accent", (q ?? "/?/").slice(0, 80)),
			);
			return text;
		},
	};
}

export function createGrepSearchTool(cwd: string): AgentTool {
	return wrapToolDefinition(createGrepSearchToolDefinition(cwd));
}

export const grepSearchToolDefinition = createGrepSearchToolDefinition(process.cwd());
export const grepSearchTool = wrapToolDefinition(grepSearchToolDefinition);
