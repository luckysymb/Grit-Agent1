/**
 * `file_search` — fuzzy path match, max 10 results (tau/Cursor_Tools.json).
 */
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import { existsSync } from "fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ensureTool } from "../../utils/tools-manager.js";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.js";
import { resolveToCwd } from "./path-utils.js";
import { str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const MAX_RESULTS = 10;

const fileSearchSchema = Type.Object({
	query: Type.String({ description: "Fuzzy filename to search for" }),
	explanation: Type.String({
		description: "One sentence explanation as to why this tool is being used, and how it contributes to the goal.",
	}),
});

export type FileSearchToolInput = Static<typeof fileSearchSchema>;

function scorePath(rel: string, q: string): number {
	const lower = rel.toLowerCase();
	const qq = q.toLowerCase();
	if (lower.includes(qq)) return 100 + qq.length;
	let s = 0;
	for (const ch of qq) {
		const idx = lower.indexOf(ch, s);
		if (idx === -1) return -1;
		s = idx + 1;
	}
	return 50;
}

export function createFileSearchToolDefinition(cwd: string): ToolDefinition<typeof fileSearchSchema, undefined> {
	return {
		name: "file_search",
		label: "file_search",
		description: "Fuzzy search over file paths (substring / character-order score). At most 10 results.",
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
