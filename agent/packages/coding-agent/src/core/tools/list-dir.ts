/**
 * `list_dir` — tau/Cursor_Tools.json (relative_workspace_path + optional explanation)
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.js";
import { resolveToCwd } from "./path-utils.js";
import { getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate.js";

const listDirSchema = Type.Object({
	relative_workspace_path: Type.String({
		description: "Path to list contents of, relative to the workspace root.",
	}),
	explanation: Type.Optional(
		Type.String({
			description: "One sentence explanation as to why this tool is being used, and how it contributes to the goal.",
		}),
	),
});

export type ListDirToolInput = Static<typeof listDirSchema>;

const ENTRY_LIMIT = 2000;

export function createListDirToolDefinition(cwd: string): ToolDefinition<typeof listDirSchema, undefined> {
	return {
		name: "list_dir",
		label: "list_dir",
		description:
			"List the contents of a directory (non-dot entries; up to 2000 entries). Use for breadth-first discovery across packages before searching or reading files.",
		parameters: listDirSchema,
		async execute(
			_toolCallId,
			args: { relative_workspace_path: string; explanation?: string },
			_signal,
			_onUpdate,
			_ctx: ExtensionContext,
		) {
			const abs = resolveToCwd(args.relative_workspace_path, cwd);
			if (!existsSync(abs)) {
				throw new Error(`Path not found: ${args.relative_workspace_path}`);
			}
			if (!statSync(abs).isDirectory()) {
				throw new Error(`Not a directory: ${args.relative_workspace_path}`);
			}

			const entries = readdirSync(abs, { withFileTypes: true })
				.filter((d) => !d.name.startsWith("."))
				.sort((a, b) => {
					if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
					return a.name.localeCompare(b.name);
				})
				.slice(0, ENTRY_LIMIT);

			const lines = entries.map((e) => `${e.isDirectory() ? "[dir] " : "[file] "}${e.name}`);
			let text = lines.join("\n");
			const trunc = truncateHead(text, { maxLines: Number.MAX_SAFE_INTEGER });
			text = trunc.content;
			if (trunc.truncated) text += `\n\n[Truncated: ${formatSize(DEFAULT_MAX_BYTES)}]`;
			return { content: [{ type: "text", text: text || "(empty directory)" }], details: undefined };
		},
		renderCall(args, theme, context) {
			const raw = str(args?.relative_workspace_path);
			const invalidArg = invalidArgText(theme);
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				theme.fg("toolTitle", theme.bold("list_dir")) +
					" " +
					(raw === null ? invalidArg : theme.fg("accent", shortenPath(raw || "."))),
			);
			return text;
		},
		renderResult(result, options, theme, context) {
			const output = getTextOutput(result, context.showImages).trim();
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			if (output) {
				const lines = output.split("\n");
				const maxLines = options.expanded ? lines.length : 30;
				const displayLines = lines.slice(0, maxLines);
				const remaining = lines.length - maxLines;
				let t = `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
				if (remaining > 0) {
					t += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
				}
				text.setText(t);
			}
			return text;
		},
	};
}

export function createListDirTool(cwd: string): AgentTool {
	return wrapToolDefinition(createListDirToolDefinition(cwd));
}

export const listDirToolDefinition = createListDirToolDefinition(process.cwd());
export const listDirTool = wrapToolDefinition(listDirToolDefinition);
