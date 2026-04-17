/**
 * `reapply` — tau/Cursor_Tools.json (no secondary apply model in this runtime).
 */
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.js";
import { firstString } from "./flexible-tool-args.js";
import { str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const reapplySchema = Type.Object({
	target_file: Type.String({
		description:
			"The relative path to the file to reapply the last edit to. You can use either a relative path in the workspace or an absolute path.",
	}),
});

export type ReapplyToolInput = Static<typeof reapplySchema>;

function prepareReapplyArguments(raw: unknown): ReapplyToolInput {
	const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	const target_file =
		firstString(o, ["target_file", "path", "file_path", "file", "filename", "filepath"]) ?? "";
	return { target_file };
}

export function createReapplyToolDefinition(): ToolDefinition<typeof reapplySchema, undefined> {
	return {
		name: "reapply",
		label: "reapply",
		description:
			"Cursor re-applies the last edit with a stronger model; this runtime has no such pass. Re-read the file and issue edit_file or search_replace again.",
		parameters: reapplySchema,
		prepareArguments: prepareReapplyArguments,
		async execute(
			_toolCallId,
			_args: { target_file: string },
			_signal,
			_onUpdate,
			_ctx: ExtensionContext,
		) {
			return {
				content: [
					{
						type: "text",
						text: "reapply is not supported in this agent: there is no secondary apply model. Re-read the file with read_file, then use edit_file or search_replace with corrected content.",
					},
				],
				details: undefined,
			};
		},
		renderCall(args, theme, context) {
			const p = str(args?.target_file);
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(theme.fg("toolTitle", theme.bold("reapply")) + " " + theme.fg("accent", p ?? "?"));
			return text;
		},
	};
}

export function createReapplyTool(): AgentTool {
	return wrapToolDefinition(createReapplyToolDefinition());
}

export const reapplyToolDefinition = createReapplyToolDefinition();
export const reapplyTool = wrapToolDefinition(reapplyToolDefinition);
