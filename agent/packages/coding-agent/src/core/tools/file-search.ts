/**
 * `file_search` — fuzzy path match; many results for monorepo discovery (tau).
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import { existsSync } from "fs";
import { ensureTool } from "../../utils/tools-manager.js";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.js";
import { resolveToCwd } from "./path-utils.js";
import { str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const MAX_RESULTS = 80;

const fileSearchSchema = Type.Object({
	query: Type.String({ description: "Fuzzy filename to search for" }),
	explanation: Type.String({
		description: "One sentence explanation as to why this tool is being used, and how it contributes to the goal.",
	}),
});

export type FileSearchToolInput = Static<typeof fileSearchSchema>;

function scorePathSingle(rel: string, token: string): number {
	const lower = rel.toLowerCase();
	const qq = token.toLowerCase();
	if (!qq.length) return 0;
	if (lower.includes(qq)) return 100 + qq.length;
	let s = 0;
	for (const ch of qq) {
		const idx = lower.indexOf(ch, s);
		if (idx === -1) return -1;
		s = idx + 1;
	}
	return 50;
}

/** Score path against full query and path segments (dashboard, sessionModel, etc.). */
function scorePath(rel: string, q: string): number {
	const trimmed = q.trim();
	if (!trimmed) return 0;
	const parts = trimmed
		.split(/[/\\\s,_-]+/g)
		.map((p) => p.trim())
		.filter((p) => p.length >= 2);
	if (parts.length <= 1) {
		const one = scorePathSingle(rel, parts[0] ?? trimmed);
		return one;
	}
	let sum = 0;
	let ok = 0;
	for (const p of parts) {
		const sc = scorePathSingle(rel, p);
		if (sc >= 0) {
			sum += sc;
			ok++;
		}
	}
	if (ok === 0) return -1;
	return sum / ok + (ok > 1 ? 25 : 0);
}

export function createFileSearchToolDefinition(cwd: string): ToolDefinition<typeof fileSearchSchema, undefined> {
	return {
		name: "file_search",
		label: "file_search",
		description:
			"Fuzzy search over file paths (substring / character-order score; multi-token queries boost paths matching several segments). Up to 80 results.",
		parameters: fileSearchSchema,
		async execute(
			_toolCallId,
			args: { query: string; explanation: string },
			_signal,
			_onUpdate,
			_ctx: ExtensionContext,
		) {
			const fdPath = await ensureTool("fd", true);
			if (!fdPath) throw new Error("fd is not available");
			const root = resolveToCwd(".", cwd);
			if (!existsSync(root)) throw new Error("workspace not found");

			const r = spawnSync(fdPath, [".", "--type", "f", "--color=never", "--hidden", "--max-results", "200000"], {
				cwd: root,
				encoding: "utf-8",
				maxBuffer: 50 * 1024 * 1024,
			});
			const out = r.stdout?.trim() || "";
			const paths = out
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean)
				.map((abs) => path.relative(cwd, abs).replace(/\\/g, "/"))
				.filter((rel) => !rel.startsWith(".."));

			const ranked = paths
				.map((rel) => ({ rel, sc: scorePath(rel, args.query) }))
				.filter((x) => x.sc >= 0)
				.sort((a, b) => b.sc - a.sc)
				.slice(0, MAX_RESULTS);

			if (ranked.length === 0) {
				return { content: [{ type: "text", text: "No matching file paths." }], details: undefined };
			}
			return { content: [{ type: "text", text: ranked.map((x) => x.rel).join("\n") }], details: undefined };
		},
		renderCall(args, theme, context) {
			const q = str(args?.query);
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(theme.fg("toolTitle", theme.bold("file_search")) + " " + theme.fg("accent", q ?? "?"));
			return text;
		},
	};
}

export function createFileSearchTool(cwd: string): AgentTool {
	return wrapToolDefinition(createFileSearchToolDefinition(cwd));
}

export const fileSearchToolDefinition = createFileSearchToolDefinition(process.cwd());
export const fileSearchTool = wrapToolDefinition(fileSearchToolDefinition);
