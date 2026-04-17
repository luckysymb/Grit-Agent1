/**
 * `edit_file` — tau/Cursor_Tools.json
 */
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import { existsSync } from "fs";
import { readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.js";
import { firstString } from "./flexible-tool-args.js";
import { dedupeAppRouterRouteGroupSegment, resolveReadPath } from "./path-utils.js";
import { str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import {
	detectLineEnding,
	normalizeForFuzzyMatch,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
	stripReadFileLineNumberPrefixes,
} from "./edit-diff.js";

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

/** LLMs often send Cursor- or IDE-shaped keys; normalize before schema validation. */
function prepareCursorEditFileArguments(raw: unknown): CursorEditFileToolInput {
	const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	let target_file =
		firstString(o, ["target_file", "file_path", "path", "file", "filename", "filepath"]) ?? "";
	target_file = dedupeAppRouterRouteGroupSegment(target_file.replace(/\\/g, "/"));
	const code_edit =
		firstString(o, ["code_edit", "code", "contents", "content", "patch", "new_code"]) ?? "";
	const instructions =
		firstString(o, ["instructions", "instruction", "description", "summary"]) ?? "Apply the edit in code_edit.";
	return { target_file, instructions, code_edit };
}

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
			"Apply a sketch edit. New file: writes code_edit (placeholder lines removed). Existing file: use // ... existing code ... (or # / HTML comment equivalents) as standalone lines. One placeholder: anchors head above and tail below — the file region between those anchors is replaced with nothing (use for deletions/collapsing). Two placeholders: head, new middle, tail — middle replaces content between anchors. Without placeholders, overwrites the file. Prefer search_replace for small exact replacements after read_file.",
		parameters: editFileSchema,
		prepareArguments: prepareCursorEditFileArguments,
		async execute(
			_toolCallId,
			args: { target_file: string; instructions: string; code_edit: string },
			signal: AbortSignal | undefined,
			_onUpdate,
			_ctx: ExtensionContext,
		) {
			const abs = resolveReadPath(args.target_file, cwd);
			const sketch = stripReadFileLineNumberPrefixes(args.code_edit.replace(/\r\n/g, "\n"));
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

			// One placeholder → [head, tail]: replace the span between anchors with nothing (collapse / delete between).
			// Two or more placeholders → head, first middle, tail (unchanged middle block).
			if (segs.length === 2) {
				const merged2 = mergeHeadMidTail(normalized, segs[0], "", segs[1]);
				if (merged2 === null) {
					throw new Error(
						"edit_file: could not anchor head/tail with one // ... existing code ... line. Add a second placeholder around new middle code, or use search_replace with exact old_string.",
					);
				}
				if (signal?.aborted) throw new Error("aborted");
				await fsWriteFile(abs, bom + restoreLineEndings(merged2, le), "utf-8");
				return { content: [{ type: "text", text: `Edited ${args.target_file}` }], details: undefined };
			}

			if (segs.length < 3) {
				throw new Error(
					"edit_file: use one // ... existing code ... line between head and tail, or two such lines around the middle segment to replace, or use search_replace.",
				);
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
	if (i0 !== -1) {
		const i1 = orig.lastIndexOf(t);
		if (i1 !== -1 && i1 >= i0 + h.length) {
			return orig.slice(0, i0 + h.length) + mid + orig.slice(i1);
		}
	}
	// Second pass: quotes/whitespace/unicode drift (same helper as search_replace fuzzy path)
	const o = normalizeForFuzzyMatch(orig);
	const hf = normalizeForFuzzyMatch(h);
	const tf = normalizeForFuzzyMatch(t);
	const mf = normalizeForFuzzyMatch(mid);
	if (!hf.length || !tf.length) return null;
	const fi0 = o.indexOf(hf);
	const fi1 = o.lastIndexOf(tf);
	if (fi0 !== -1 && fi1 !== -1 && fi1 >= fi0 + hf.length) {
		return o.slice(0, fi0 + hf.length) + mf + o.slice(fi1);
	}
	// Last resort: first substantial line of head + last substantial line of tail (models often drift on middle lines)
	const hLine = head.split("\n").find((l) => l.trim().length > 0)?.trimEnd() ?? "";
	const tLine = [...tail.split("\n")].reverse().find((l) => l.trim().length > 0)?.trimStart() ?? "";
	const minLine = 10;
	if (hLine.length >= minLine && tLine.length >= minLine) {
		const li0 = orig.indexOf(hLine);
		const li1 = orig.lastIndexOf(tLine);
		if (li0 !== -1 && li1 !== -1 && li1 >= li0 + hLine.length) {
			return orig.slice(0, li0 + hLine.length) + mid + orig.slice(li1);
		}
		const hN = normalizeForFuzzyMatch(hLine);
		const tN = normalizeForFuzzyMatch(tLine);
		const oo = normalizeForFuzzyMatch(orig);
		const mi0 = oo.indexOf(hN);
		const mi1 = oo.lastIndexOf(tN);
		if (mi0 !== -1 && mi1 !== -1 && mi1 >= mi0 + hN.length) {
			return oo.slice(0, mi0 + hN.length) + normalizeForFuzzyMatch(mid) + oo.slice(mi1);
		}
	}
	return null;
}

export function createCursorEditFileTool(cwd: string): AgentTool {
	return wrapToolDefinition(createCursorEditFileToolDefinition(cwd));
}

export const cursorEditFileToolDefinition = createCursorEditFileToolDefinition(process.cwd());
export const cursorEditFileTool = wrapToolDefinition(cursorEditFileToolDefinition);
