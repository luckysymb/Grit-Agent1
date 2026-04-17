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
import { resolveReadPath } from "./path-utils.js";
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
	should_read_entire_file: Type.Boolean({
		description: "Whether to read the entire file. Defaults to false.",
	}),
	start_line_one_indexed: Type.Integer({
		description: "The one-indexed line number to start reading from (inclusive).",
		minimum: 1,
	}),
	end_line_one_indexed_inclusive: Type.Integer({
		description: "The one-indexed line number to end reading at (inclusive).",
		minimum: 1,
	}),
	explanation: Type.Optional(
		Type.String({
			description: "One sentence explanation as to why this tool is being used, and how it contributes to the goal.",
		}),
	),
});

export type ReadFileToolInput = Static<typeof readFileSchema>;

export interface ReadFileToolDetails {
	truncation?: TruncationResult;
}

export function createReadFileToolDefinition(cwd: string): ToolDefinition<typeof readFileSchema, ReadFileToolDetails | undefined> {
	return {
		name: "read_file",
		label: "read_file",
		description: `Read file contents with 1-indexed line numbers. At most ${MAX_LINES_PER_CALL} lines per call unless reading entire file (subject to byte limits).`,
		parameters: readFileSchema,
		async execute(
			_toolCallId,
			args: {
				target_file: string;
				should_read_entire_file: boolean;
				start_line_one_indexed: number;
				end_line_one_indexed_inclusive: number;
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

			let start = Math.max(1, args.start_line_one_indexed);
			let end = Math.max(start, args.end_line_one_indexed_inclusive);

			if (args.should_read_entire_file) {
				start = 1;
				end = lines.length;
			} else {
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
			}

			const total = lines.length;
			const before = start > 1 ? `(lines 1–${start - 1} not shown: ${start - 1} line(s))\n` : "";
			const after = end < total ? `\n(lines ${end + 1}–${total} not shown: ${total - end} line(s))` : "";

			const slice = lines.slice(start - 1, end);
			const numbered = slice.map((line, i) => `${String(start + i).padStart(6, " ")}|${replaceTabs(line)}`);
			const body = numbered.join("\n");

			const summary = `${before}${body}${after}`;
			const truncation = truncateHead(summary, {
				maxLines: args.should_read_entire_file ? DEFAULT_MAX_LINES : MAX_LINES_PER_CALL + 50,
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
