/**
 * `read_file` — parameters match tau/Cursor_Tools.json
 */
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile } from "fs/promises";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.js";
import { asRecord, firstString, firstStringOrSingleElementArray, toBoolFlexible, toIntFlexible } from "./flexible-tool-args.js";
import { dedupeAppRouterRouteGroupSegment, resolveReadPath } from "./path-utils.js";
import { getTextOutput, invalidArgText, replaceTabs, shortenPath, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

const MAX_LINES_PER_CALL = 250;
const MIN_RANGE_LINES = 1;

const readFileSchema = Type.Object({
	target_file: Type.String({
		description:
			"The path of the file to read. You can use either a relative path in the workspace or an absolute path.",
	}),
	should_read_entire_file: Type.Optional(
		Type.Boolean({
			description:
				"If true, read the whole file (line range may be omitted). If false or omitted and no line range is given, the first chunk of the file is read.",
		}),
	),
	start_line_one_indexed: Type.Optional(
		Type.Integer({
			description:
				"One-indexed start line (inclusive). Optional when should_read_entire_file is true, or when relying on default first-chunk read.",
			minimum: 1,
		}),
	),
	end_line_one_indexed_inclusive: Type.Optional(
		Type.Integer({
			description:
				"One-indexed end line (inclusive). Optional when should_read_entire_file is true, or when relying on default first-chunk read.",
			minimum: 1,
		}),
	),
	explanation: Type.Optional(
		Type.String({
			description: "One sentence explanation as to why this tool is being used, and how it contributes to the goal.",
		}),
	),
});

export type ReadFileToolInput = Static<typeof readFileSchema>;

function prepareReadFileArguments(raw: unknown): ReadFileToolInput {
	const o = asRecord(raw);
	let target_file =
		firstStringOrSingleElementArray(o, ["target_file", "path", "file_path", "file", "filename", "filepath", "target"]) ??
		firstString(o, ["target_file", "path", "file_path", "file", "filename", "filepath", "target"]) ??
		"";
	target_file = dedupeAppRouterRouteGroupSegment(target_file.replace(/\\/g, "/"));
	const explanation = firstString(o, ["explanation", "reason", "purpose"]);
	const should_read_entire_file =
		toBoolFlexible(o.should_read_entire_file) ??
		toBoolFlexible(o.read_entire_file) ??
		toBoolFlexible(o.entire_file) ??
		toBoolFlexible(o.full_file);
	const start_line_one_indexed =
		toIntFlexible(o.start_line_one_indexed) ??
		toIntFlexible(o.start_line) ??
		toIntFlexible(o.startLine) ??
		toIntFlexible(o.line_start) ??
		toIntFlexible(o.begin_line);
	const end_line_one_indexed_inclusive =
		toIntFlexible(o.end_line_one_indexed_inclusive) ??
		toIntFlexible(o.end_line) ??
		toIntFlexible(o.endLine) ??
		toIntFlexible(o.line_end) ??
		toIntFlexible(o.last_line);
	const out: ReadFileToolInput = { target_file };
	if (should_read_entire_file !== undefined) {
		out.should_read_entire_file = should_read_entire_file;
	}
	if (explanation !== undefined) {
		out.explanation = explanation;
	}
	if (start_line_one_indexed !== undefined) {
		out.start_line_one_indexed = start_line_one_indexed;
	}
	if (end_line_one_indexed_inclusive !== undefined) {
		out.end_line_one_indexed_inclusive = end_line_one_indexed_inclusive;
	}
	// Whole-file reads: some model payloads omit line fields; AJV may still expect keys present.
	// Execute ignores these when should_read_entire_file is true (uses full line range).
	if (out.should_read_entire_file === true) {
		out.start_line_one_indexed = 1;
		out.end_line_one_indexed_inclusive = 1;
	}
	return out;
}

export interface ReadFileToolDetails {
	truncation?: TruncationResult;
}

export function createReadFileToolDefinition(cwd: string): ToolDefinition<typeof readFileSchema, ReadFileToolDetails | undefined> {
	return {
		name: "read_file",
		label: "read_file",
		description: `Read file contents with 1-indexed line numbers. At most ${MAX_LINES_PER_CALL} lines per call unless reading entire file (subject to byte limits). Prefer should_read_entire_file true for whole-file reads (start/end may be omitted). For partial reads, pass start_line_one_indexed and end_line_one_indexed_inclusive. For any existing file you will change with search_replace, edit, or edit_file, call read_file on that path first; if the result looks wrong, fix the path and retry.`,
		parameters: readFileSchema,
		prepareArguments: prepareReadFileArguments,
		async execute(
			_toolCallId,
			args: {
				target_file: string;
				should_read_entire_file?: boolean;
				start_line_one_indexed?: number;
				end_line_one_indexed_inclusive?: number;
				explanation?: string;
			},
			_signal,
			_onUpdate,
			_ctx: ExtensionContext,
		) {
			const abs = resolveReadPath(args.target_file, cwd);
			await fsAccess(abs, constants.R_OK);
			const raw = await fsReadFile(abs, "utf-8");
			const lines = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

			const entireRequested = args.should_read_entire_file === true;
			const hasStart = args.start_line_one_indexed !== undefined;
			const hasEnd = args.end_line_one_indexed_inclusive !== undefined;

			let start: number;
			let end: number;

			if (entireRequested) {
				start = 1;
				end = lines.length;
			} else if (hasStart || hasEnd) {
				start = Math.max(1, args.start_line_one_indexed ?? 1);
				let proposedEnd = args.end_line_one_indexed_inclusive;
				if (proposedEnd === undefined) {
					proposedEnd = Math.min(start + MAX_LINES_PER_CALL - 1, Math.max(start, lines.length));
				}
				end = Math.max(start, proposedEnd);
				if (start > lines.length) {
					throw new Error(`start_line_one_indexed ${start} past end of file (${lines.length} lines)`);
				}
				end = Math.min(end, lines.length);
				const span = end - start + 1;
				if (span > MAX_LINES_PER_CALL) {
					end = start + MAX_LINES_PER_CALL - 1;
				}
				if (span < MIN_RANGE_LINES) {
					throw new Error("Invalid line range");
				}
			} else {
				// No line range and not full-file: default to first chunk (models often omit optional fields).
				start = 1;
				end = Math.min(lines.length, MAX_LINES_PER_CALL);
			}

			const total = lines.length;
			const before = start > 1 ? `(lines 1–${start - 1} not shown: ${start - 1} line(s))\n` : "";
			const after = end < total ? `\n(lines ${end + 1}–${total} not shown: ${total - end} line(s))` : "";

			const slice = lines.slice(start - 1, end);
			const numbered = slice.map((line, i) => `${String(start + i).padStart(6, " ")}|${replaceTabs(line)}`);
			const body = numbered.join("\n");

			const summary = `${before}${body}${after}`;
			const truncation = truncateHead(summary, {
				maxLines: entireRequested || (start === 1 && end === lines.length) ? DEFAULT_MAX_LINES : MAX_LINES_PER_CALL + 50,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			const details: ReadFileToolDetails = {};
			if (truncation.truncated) details.truncation = truncation;

			return {
				content: [{ type: "text", text: truncation.content }],
				details: details.truncation ? details : undefined,
			};
		},
		renderCall(args, theme, context) {
			const raw = str(args?.target_file);
			const invalidArg = invalidArgText(theme);
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				theme.fg("toolTitle", theme.bold("read_file")) +
					" " +
					(raw === null ? invalidArg : theme.fg("accent", shortenPath(raw || ""))),
			);
			return text;
		},
		renderResult(result, options, theme, context) {
			const output = getTextOutput(result as any, context.showImages).trim();
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			if (output) {
				const lines = output.split("\n");
				const maxLines = options.expanded ? lines.length : 15;
				const displayLines = lines.slice(0, maxLines);
				const remaining = lines.length - maxLines;
				let t = `\n${displayLines.map((line) => theme.fg("toolOutput", replaceTabs(line))).join("\n")}`;
				if (remaining > 0) {
					t += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
				}
				const tr = (result as { details?: ReadFileToolDetails }).details?.truncation;
				if (tr?.truncated) {
					t += `\n${theme.fg("warning", `[Truncated: ${formatSize(tr.maxBytes ?? DEFAULT_MAX_BYTES)}]`)}`;
				}
				text.setText(t);
			}
			return text;
		},
	};
}

export function createReadFileTool(cwd: string): AgentTool {
	return wrapToolDefinition(createReadFileToolDefinition(cwd));
}

export const readFileToolDefinition = createReadFileToolDefinition(process.cwd());
export const readFileTool = wrapToolDefinition(readFileToolDefinition);
