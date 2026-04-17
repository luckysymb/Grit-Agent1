import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import { existsSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.js";
import { resolveToCwd } from "./path-utils.js";
import { getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const deleteFileSchema = Type.Object({
	target_file: Type.String({
		description: "The path of the file to delete, relative to the workspace root.",
	}),
	explanation: Type.Optional(
		Type.String({
			description: "One sentence explanation as to why this tool is being used, and how it contributes to the goal.",
		}),
	),
});

export type DeleteFileToolInput = Static<typeof deleteFileSchema>;

function isInsideRoot(root: string, target: string): boolean {
	const r = path.resolve(root);
	const t = path.resolve(target);
	const rel = path.relative(r, t);
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function createDeleteFileToolDefinition(cwd: string): ToolDefinition<typeof deleteFileSchema, undefined> {
	return {
		name: "delete_file",
		label: "delete_file",
		description:
			"Delete a file in the workspace. Fails if the path is outside the workspace, is a directory, or does not exist.",
		parameters: deleteFileSchema,
		async execute(
			_toolCallId,
			{ target_file }: { target_file: string; explanation?: string },
			_signal,
			_onUpdate,
			_ctx: ExtensionContext,
		) {
			const abs = resolveToCwd(target_file, cwd);
			if (!isInsideRoot(cwd, abs)) {
				throw new Error(`Refusing to delete outside workspace: ${target_file}`);
			}
			if (!existsSync(abs)) {
				return { content: [{ type: "text", text: `File not found: ${target_file}` }], details: undefined };
			}
			if (!statSync(abs).isFile()) {
				throw new Error(`Not a file (use bash to remove directories): ${target_file}`);
			}
			rmSync(abs, { force: false });
			return {
				content: [{ type: "text", text: `Deleted ${path.relative(cwd, abs).replace(/\\/g, "/") || target_file}` }],
				details: undefined,
			};
		},
		renderCall(args, theme, context) {
			const raw = str(args?.target_file);
			const invalidArg = invalidArgText(theme);
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				theme.fg("toolTitle", theme.bold("delete_file")) +
					" " +
					(raw === null ? invalidArg : theme.fg("accent", shortenPath(raw || ""))),
			);
			return text;
		},
		renderResult(result, options, theme, context) {
			const output = getTextOutput(result, context.showImages).trim();
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			if (output) {
				const lines = output.split("\n");
				const maxLines = options.expanded ? lines.length : 12;
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

export function createDeleteFileTool(cwd: string): AgentTool {
	return wrapToolDefinition(createDeleteFileToolDefinition(cwd));
}

export const deleteFileToolDefinition = createDeleteFileToolDefinition(process.cwd());
export const deleteFileTool = wrapToolDefinition(deleteFileToolDefinition);
