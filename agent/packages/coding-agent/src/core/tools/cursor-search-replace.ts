/**
 * `search_replace` — single occurrence replace; tau/Cursor_Tools.json
 */
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.js";
import { resolveToCwd } from "./path-utils.js";
import { str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { detectLineEnding, normalizeToLF, restoreLineEndings, stripBom } from "./edit-diff.js";

const searchReplaceSchema = Type.Object({
	file_path: Type.String({
		description:
			"The path to the file you want to search and replace in. You can use either a relative path in the workspace or an absolute path.",
	}),
	old_string: Type.String({
		description:
			"The text to replace (must be unique within the file, and must match the file contents exactly, including all whitespace and indentation)",
	}),
	new_string: Type.String({
		description: "The edited text to replace the old_string (must be different from the old_string)",
	}),
});

export type CursorSearchReplaceToolInput = Static<typeof searchReplaceSchema>;

export function createSearchReplaceToolDefinition(cwd: string): ToolDefinition<typeof searchReplaceSchema, undefined> {
	return {
		name: "search_replace",
		label: "search_replace",
		description: "Replace exactly one occurrence of old_string with new_string in a file.",
		parameters: searchReplaceSchema,
		async execute(
			_toolCallId,
			args: { file_path: string; old_string: string; new_string: string },
			signal: AbortSignal | undefined,
			_onUpdate,
			_ctx: ExtensionContext,
		) {
			if (args.old_string === args.new_string) {
				throw new Error("old_string and new_string must differ");
			}
			const abs = resolveToCwd(args.file_path, cwd);
			await fsAccess(abs, constants.R_OK | constants.W_OK);
			const raw = await fsReadFile(abs, "utf-8");
			const { bom, text } = stripBom(raw);
			const normalized = normalizeToLF(text);
			const count = splitCount(normalized, args.old_string);
			if (count === 0) throw new Error("old_string not found in file");
			if (count > 1) throw new Error(`old_string matched ${count} times; must be unique`);
			const le = detectLineEnding(text);
			const updated = normalized.replace(args.old_string, args.new_string);
			const out = bom + restoreLineEndings(updated, le);
			if (signal?.aborted) throw new Error("aborted");
			await fsWriteFile(abs, out, "utf-8");
			return { content: [{ type: "text", text: `Updated ${args.file_path}` }], details: undefined };
		},
		renderCall(args, theme, context) {
			const p = str(args?.file_path);
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(theme.fg("toolTitle", theme.bold("search_replace")) + " " + theme.fg("accent", p ?? "?"));
			return text;
		},
	};
}

function splitCount(hay: string, needle: string): number {
	if (!needle) return 0;
	let c = 0;
	let i = 0;
	while (i <= hay.length) {
		const j = hay.indexOf(needle, i);
		if (j === -1) break;
		c++;
		i = j + needle.length;
	}
	return c;
}

export function createSearchReplaceTool(cwd: string): AgentTool {
	return wrapToolDefinition(createSearchReplaceToolDefinition(cwd));
}

export const searchReplaceToolDefinition = createSearchReplaceToolDefinition(process.cwd());
export const searchReplaceTool = wrapToolDefinition(searchReplaceToolDefinition);
