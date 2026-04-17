/**
 * `edit_notebook` — tau/Cursor_Tools.json
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

const editNotebookSchema = Type.Object({
	target_notebook: Type.String({
		description:
			"The path to the notebook file you want to edit. You can use either a relative path in the workspace or an absolute path.",
	}),
	cell_idx: Type.Number({ description: "The index of the cell to edit (0-based)" }),
	is_new_cell: Type.Boolean({
		description:
			"If true, a new cell will be created at the specified cell index. If false, the cell at the specified cell index will be edited.",
	}),
	cell_language: Type.String({
		description:
			"The language of the cell to edit. Should be STRICTLY one of these: 'python', 'markdown', 'javascript', 'typescript', 'r', 'sql', 'shell', 'raw' or 'other'.",
	}),
	old_string: Type.String({
		description:
			"The text to replace (must be unique within the cell, and must match the cell contents exactly, including all whitespace and indentation).",
	}),
	new_string: Type.String({
		description: "The edited text to replace the old_string or the content for the new cell.",
	}),
});

export type EditNotebookToolInput = Static<typeof editNotebookSchema>;

interface IpynbCell {
	cell_type: string;
	source: string | string[];
	metadata?: Record<string, unknown>;
}

interface Ipynb {
	cells: IpynbCell[];
	nbformat?: number;
	nbformat_minor?: number;
	metadata?: Record<string, unknown>;
}

function getCellSource(cell: IpynbCell): string {
	if (Array.isArray(cell.source)) return cell.source.join("");
	return cell.source ?? "";
}

function setCellSource(cell: IpynbCell, text: string): void {
	cell.source = text.split("\n").map((line, i, arr) => (i < arr.length - 1 ? `${line}\n` : line));
}

export function createEditNotebookToolDefinition(cwd: string): ToolDefinition<typeof editNotebookSchema, undefined> {
	return {
		name: "edit_notebook",
		label: "edit_notebook",
		description: "Edit or create one Jupyter notebook cell (.ipynb).",
		parameters: editNotebookSchema,
		async execute(
			_toolCallId,
			args: {
				target_notebook: string;
				cell_idx: number;
				is_new_cell: boolean;
				cell_language: string;
				old_string: string;
				new_string: string;
			},
			_signal,
			_onUpdate,
			_ctx: ExtensionContext,
		) {
			const abs = resolveToCwd(args.target_notebook, cwd);
			let nb: Ipynb;
			if (!existsSync(abs)) {
				if (!args.is_new_cell || args.cell_idx !== 0) {
					throw new Error("Notebook does not exist; create with is_new_cell=true and cell_idx=0");
				}
				nb = { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] };
			} else {
				const raw = await fsReadFile(abs, "utf-8");
				nb = JSON.parse(raw) as Ipynb;
			}
			if (!Array.isArray(nb.cells)) throw new Error("Invalid .ipynb: missing cells");

			const idx = Math.floor(args.cell_idx);
			if (idx < 0 || idx > nb.cells.length) throw new Error(`cell_idx ${idx} out of range`);

			if (args.is_new_cell) {
				const ct =
					args.cell_language === "markdown"
						? "markdown"
						: args.cell_language === "raw"
							? "raw"
							: "code";
				const cell: IpynbCell = {
					cell_type: ct === "markdown" ? "markdown" : "code",
					metadata: {},
					source: args.new_string,
				};
				if (cell.cell_type === "code") {
					(cell as IpynbCell & { outputs?: unknown[]; execution_count?: null }).outputs = [];
					(cell as IpynbCell & { execution_count?: null }).execution_count = null;
				}
				nb.cells.splice(idx, 0, cell);
			} else {
				const cell = nb.cells[idx];
				if (!cell) throw new Error(`No cell at index ${idx}`);
				const src = getCellSource(cell);
				if (args.old_string === "") {
					setCellSource(cell, args.new_string);
				} else {
					const count = src.split(args.old_string).length - 1;
					if (count === 0) throw new Error("old_string not found in cell");
					if (count > 1) throw new Error("old_string matches multiple times in cell");
					setCellSource(cell, src.replace(args.old_string, args.new_string));
				}
			}

			await fsWriteFile(abs, `${JSON.stringify(nb, null, 2)}\n`, "utf-8");
			return {
				content: [{ type: "text", text: `Updated notebook ${args.target_notebook} cell ${idx}` }],
				details: undefined,
			};
		},
		renderCall(args, theme, context) {
			const p = str(args?.target_notebook);
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(theme.fg("toolTitle", theme.bold("edit_notebook")) + " " + theme.fg("accent", p ?? "?"));
			return text;
		},
	};
}

export function createEditNotebookTool(cwd: string): AgentTool {
	return wrapToolDefinition(createEditNotebookToolDefinition(cwd));
}

export const editNotebookToolDefinition = createEditNotebookToolDefinition(process.cwd());
export const editNotebookTool = wrapToolDefinition(editNotebookToolDefinition);
