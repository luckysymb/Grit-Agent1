/**
 * `edit_file` — tau/Cursor_Tools.json
 */
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import { existsSync } from "fs";
import { readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.js";
import { resolveToCwd } from "./path-utils.js";
import { str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { detectLineEnding, normalizeToLF, restoreLineEndings, stripBom } from "./edit-diff.js";

const editFileSchema = Type.Object({
	target_file: Type.String({
		description:
			"The target file to modify. Always specify the target file as the first argument. You can use either a relative path in the workspace or an absolute path.",
	}),
	instructions: Type.String({
		description:
			"A single sentence instruction describing what you are going to do for the sketched edit. This is used to assist the less intelligent model in applying the edit.",
	}),
	code_edit: Type.String({
		description:
			"Specify ONLY the precise lines of code that you wish to edit. **NEVER specify or write out unchanged code**. Instead, represent all unchanged code using the comment of the language you're editing in - example: `// ... existing code ...`",
	}),
});

export type CursorEditFileToolInput = Static<typeof editFileSchema>;

function isPlaceholderLine(line: string): boolean {
	const t = line.trim();
	return (
		/^(\/\/|#|<!--)\s*\.\.\.\s*existing\s+code\s*\.\.\./.test(t) ||
		/^\/\*\s*\.\.\.\s*existing\s+code\s*\.\.\./.test(t)
	);
}

/** Split sketch by standalone placeholder lines → text segments between markers. */
function segmentsFromSketch(sketch: string): string[] {
	const lines = sketch.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	const segments: string[] = [];
	let buf: string[] = [];
	for (const line of lines) {
		if (isPlaceholderLine(line)) {
			segments.push(buf.join("\n"));
			buf = [];
		} else {
			buf.push(line);
		}
	}
	segments.push(buf.join("\n"));
	return segments;
}

export function createCursorEditFileToolDefinition(cwd: string): ToolDefinition<typeof editFileSchema, undefined> {
	return {
		name: "edit_file",
		label: "edit_file",
		description:
			"Apply a sketch edit. New file: writes code_edit (placeholder lines removed). Existing file: with two placeholder blocks, replaces the region of the original file between the first and last non-placeholder segments (head/tail anchors). Without placeholders, overwrites the file with code_edit.",
		parameters: editFileSchema,
		async execute(
			_toolCallId,
			args: { target_file: string; instructions: string; code_edit: string },
			signal: AbortSignal | undefined,
			_onUpdate,
			_ctx: ExtensionContext,
		) {
			const abs = resolveToCwd(args.target_file, cwd);
			const sketch = args.code_edit.replace(/\r\n/g, "\n");
			const segs = segmentsFromSketch(sketch);
			const hasPh = sketch.split("\n").some(isPlaceholderLine);

			if (!existsSync(abs)) {
				const cleaned = segs.join("\n");
				await fsWriteFile(abs, cleaned, "utf-8");
				return { content: [{ type: "text", text: `Created ${args.target_file}` }], details: undefined };
			}

			const raw = await fsReadFile(abs, "utf-8");
			const { bom, text } = stripBom(raw);
			const normalized = normalizeToLF(text);
			const le = detectLineEnding(text);

			if (!hasPh) {
				if (signal?.aborted) throw new Error("aborted");
				await fsWriteFile(abs, bom + restoreLineEndings(normalizeToLF(sketch), le), "utf-8");
				return { content: [{ type: "text", text: `Overwrote ${args.target_file}` }], details: undefined };
			}

			if (segs.length < 3) {
				throw new Error("edit_file: use two // ... existing code ... lines to delimit head, middle, tail segments, or use search_replace.");
			}

			const head = segs[0];
			const mid = segs[1];
			const tail = segs[segs.length - 1];
			const merged = mergeHeadMidTail(normalized, head, mid, tail);
			if (merged === null) {
				throw new Error("edit_file: could not anchor head/tail in the original file. Use search_replace with exact old_string.");
			}
			if (signal?.aborted) throw new Error("aborted");
			await fsWriteFile(abs, bom + restoreLineEndings(merged, le), "utf-8");
			return { content: [{ type: "text", text: `Edited ${args.target_file}` }], details: undefined };
		},
		renderCall(args, theme, context) {
			const p = str(args?.target_file);
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(theme.fg("toolTitle", theme.bold("edit_file")) + " " + theme.fg("accent", p ?? "?"));
			return text;
		},
	};
}

function mergeHeadMidTail(orig: string, head: string, mid: string, tail: string): string | null {
	const h = head.trimEnd();
	const t = tail.trimStart();
	const i0 = orig.indexOf(h);
	if (i0 === -1) return null;
	const i1 = orig.lastIndexOf(t);
	if (i1 === -1 || i1 < i0 + h.length) return null;
	return orig.slice(0, i0 + h.length) + mid + orig.slice(i1);
}

export function createCursorEditFileTool(cwd: string): AgentTool {
	return wrapToolDefinition(createCursorEditFileToolDefinition(cwd));
}

export const cursorEditFileToolDefinition = createCursorEditFileToolDefinition(process.cwd());
export const cursorEditFileTool = wrapToolDefinition(cursorEditFileToolDefinition);
