/**
 * Built-in tools aligned with tau/Cursor_Tools.json (Cursor-compatible names/parameters).
 * Legacy pi tools (read, bash, edit, write, grep, find, ls) remain available as exports from their modules for callers that import them directly.
 */
export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	bashTool,
	bashToolDefinition,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.js";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
	editTool,
	editToolDefinition,
} from "./edit.js";
export { withFileMutationQueue } from "./file-mutation-queue.js";
export {
	createFindTool,
	createFindToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
	findTool,
	findToolDefinition,
} from "./find.js";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
	grepTool,
	grepToolDefinition,
} from "./grep.js";
export {
	createLsTool,
	createLsToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
	lsTool,
	lsToolDefinition,
} from "./ls.js";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
	readTool,
	readToolDefinition,
} from "./read.js";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.js";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
	writeTool,
	writeToolDefinition,
} from "./write.js";

export {
	codebaseSearchTool,
	codebaseSearchToolDefinition,
	createCodebaseSearchTool,
	createCodebaseSearchToolDefinition,
	type CodebaseSearchToolInput,
} from "./codebase-search.js";
export {
	createDeleteFileTool,
	createDeleteFileToolDefinition,
	deleteFileTool,
	deleteFileToolDefinition,
	type DeleteFileToolInput,
} from "./delete-file.js";
export {
	createListDirTool,
	createListDirToolDefinition,
	listDirTool,
	listDirToolDefinition,
	type ListDirToolInput,
} from "./list-dir.js";
export {
	createReadFileTool,
	createReadFileToolDefinition,
	readFileTool,
	readFileToolDefinition,
	type ReadFileToolInput,
} from "./read-file.js";
export {
	createRunTerminalCmdTool,
	createRunTerminalCmdToolDefinition,
	runTerminalCmdTool,
	runTerminalCmdToolDefinition,
	type RunTerminalCmdToolInput,
} from "./run-terminal-cmd.js";
export {
	createGrepSearchTool,
	createGrepSearchToolDefinition,
	grepSearchTool,
	grepSearchToolDefinition,
	type GrepSearchToolInput,
} from "./grep-search.js";
export {
	createCursorEditFileTool,
	createCursorEditFileToolDefinition,
	cursorEditFileTool,
	cursorEditFileToolDefinition,
	type CursorEditFileToolInput,
} from "./cursor-edit-file.js";
export {
	createSearchReplaceTool,
	createSearchReplaceToolDefinition,
	searchReplaceTool,
	searchReplaceToolDefinition,
	type CursorSearchReplaceToolInput,
} from "./cursor-search-replace.js";
export {
	createFileSearchTool,
	createFileSearchToolDefinition,
	fileSearchTool,
	fileSearchToolDefinition,
	type FileSearchToolInput,
} from "./file-search.js";
export {
	createReapplyTool,
	createReapplyToolDefinition,
	reapplyTool,
	reapplyToolDefinition,
	type ReapplyToolInput,
} from "./reapply.js";
export {
	createEditNotebookTool,
	createEditNotebookToolDefinition,
	editNotebookTool,
	editNotebookToolDefinition,
	type EditNotebookToolInput,
} from "./edit-notebook.js";

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ToolDefinition } from "../extensions/types.js";
import {
	createCodebaseSearchTool,
	createCodebaseSearchToolDefinition,
	codebaseSearchTool,
	codebaseSearchToolDefinition,
} from "./codebase-search.js";
import {
	createDeleteFileTool,
	createDeleteFileToolDefinition,
	deleteFileTool,
	deleteFileToolDefinition,
} from "./delete-file.js";
import {
	createListDirTool,
	createListDirToolDefinition,
	listDirTool,
	listDirToolDefinition,
} from "./list-dir.js";
import {
	createReadFileTool,
	createReadFileToolDefinition,
	readFileTool,
	readFileToolDefinition,
} from "./read-file.js";
import {
	createRunTerminalCmdTool,
	createRunTerminalCmdToolDefinition,
	runTerminalCmdTool,
	runTerminalCmdToolDefinition,
} from "./run-terminal-cmd.js";
import {
	createGrepSearchTool,
	createGrepSearchToolDefinition,
	grepSearchTool,
	grepSearchToolDefinition,
} from "./grep-search.js";
import {
	createCursorEditFileTool,
	createCursorEditFileToolDefinition,
	cursorEditFileTool,
	cursorEditFileToolDefinition,
} from "./cursor-edit-file.js";
import {
	createSearchReplaceTool,
	createSearchReplaceToolDefinition,
	searchReplaceTool,
	searchReplaceToolDefinition,
} from "./cursor-search-replace.js";
import {
	createFileSearchTool,
	createFileSearchToolDefinition,
	fileSearchTool,
	fileSearchToolDefinition,
} from "./file-search.js";
import {
	createReapplyTool,
	createReapplyToolDefinition,
	reapplyTool,
	reapplyToolDefinition,
} from "./reapply.js";
import {
	createEditNotebookTool,
	createEditNotebookToolDefinition,
	editNotebookTool,
	editNotebookToolDefinition,
} from "./edit-notebook.js";
import type { ReadToolOptions } from "./read.js";
import type { BashToolOptions } from "./bash.js";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;

/** Cursor_Tools.json tool set — default for the agent session. */
export const allTools = {
	codebase_search: codebaseSearchTool,
	read_file: readFileTool,
	run_terminal_cmd: runTerminalCmdTool,
	list_dir: listDirTool,
	grep_search: grepSearchTool,
	edit_file: cursorEditFileTool,
	search_replace: searchReplaceTool,
	file_search: fileSearchTool,
	delete_file: deleteFileTool,
	reapply: reapplyTool,
	edit_notebook: editNotebookTool,
} as const;

export const allToolDefinitions = {
	codebase_search: codebaseSearchToolDefinition,
	read_file: readFileToolDefinition,
	run_terminal_cmd: runTerminalCmdToolDefinition,
	list_dir: listDirToolDefinition,
	grep_search: grepSearchToolDefinition,
	edit_file: cursorEditFileToolDefinition,
	search_replace: searchReplaceToolDefinition,
	file_search: fileSearchToolDefinition,
	delete_file: deleteFileToolDefinition,
	reapply: reapplyToolDefinition,
	edit_notebook: editNotebookToolDefinition,
} as const;

export type ToolName = keyof typeof allTools;

/** Subset that mutate files or run commands (for UI grouping). */
export const codingTools: Tool[] = [
	cursorEditFileTool,
	searchReplaceTool,
	deleteFileTool,
	runTerminalCmdTool,
	editNotebookTool,
];

export const readOnlyTools: Tool[] = [
	readFileTool,
	grepSearchTool,
	fileSearchTool,
	codebaseSearchTool,
	listDirTool,
	reapplyTool,
];

export interface ToolsOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createCursorEditFileToolDefinition(cwd),
		createSearchReplaceToolDefinition(cwd),
		createDeleteFileToolDefinition(cwd),
		createRunTerminalCmdToolDefinition(cwd),
		createEditNotebookToolDefinition(cwd),
	];
}

export function createReadOnlyToolDefinitions(cwd: string, _options?: ToolsOptions): ToolDef[] {
	return [
		createReadFileToolDefinition(cwd),
		createGrepSearchToolDefinition(cwd),
		createFileSearchToolDefinition(cwd),
		createCodebaseSearchToolDefinition(cwd),
		createListDirToolDefinition(cwd),
		createReapplyToolDefinition(),
	];
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	return {
		codebase_search: createCodebaseSearchToolDefinition(cwd),
		read_file: createReadFileToolDefinition(cwd),
		run_terminal_cmd: createRunTerminalCmdToolDefinition(cwd),
		list_dir: createListDirToolDefinition(cwd),
		grep_search: createGrepSearchToolDefinition(cwd),
		edit_file: createCursorEditFileToolDefinition(cwd),
		search_replace: createSearchReplaceToolDefinition(cwd),
		file_search: createFileSearchToolDefinition(cwd),
		delete_file: createDeleteFileToolDefinition(cwd),
		reapply: createReapplyToolDefinition(),
		edit_notebook: createEditNotebookToolDefinition(cwd),
	};
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createCursorEditFileTool(cwd),
		createSearchReplaceTool(cwd),
		createDeleteFileTool(cwd),
		createRunTerminalCmdTool(cwd),
		createEditNotebookTool(cwd),
	];
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadFileTool(cwd),
		createGrepSearchTool(cwd),
		createFileSearchTool(cwd),
		createCodebaseSearchTool(cwd),
		createListDirTool(cwd),
		createReapplyTool(),
	];
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		codebase_search: createCodebaseSearchTool(cwd),
		read_file: createReadFileTool(cwd),
		run_terminal_cmd: createRunTerminalCmdTool(cwd),
		list_dir: createListDirTool(cwd),
		grep_search: createGrepSearchTool(cwd),
		edit_file: createCursorEditFileTool(cwd),
		search_replace: createSearchReplaceTool(cwd),
		file_search: createFileSearchTool(cwd),
		delete_file: createDeleteFileTool(cwd),
		reapply: createReapplyTool(),
		edit_notebook: createEditNotebookTool(cwd),
	};
}
