/**
 * `search_replace` — single occurrence replace; tau/Cursor_Tools.json
 */
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.js";
import { firstStringOrJoinedArray, firstStringOrSingleElementArray, toBoolFlexible } from "./flexible-tool-args.js";
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

const searchReplaceSchema = Type.Object({
	file_path: Type.String({
		description:
			"The path to the file you want to search and replace in. You can use either a relative path in the workspace or an absolute path.",
	}),
	old_string: Type.String({
		description:
			"The text to replace (must match file contents exactly, including whitespace). If it appears multiple times, see replace_first_match_only / replace_all.",
	}),
	new_string: Type.String({
		description: "The edited text to replace the old_string (must be different from the old_string)",
	}),
	replace_first_match_only: Type.Optional(
		Type.Boolean({
			description:
				"If true (default), when old_string matches more than once, only the first occurrence is replaced. Set false to require a unique old_string instead of erroring.",
		}),
	),
	replace_all: Type.Optional(
		Type.Boolean({
			description:
				"If true, replace every non-overlapping occurrence of old_string. Takes precedence over replace_first_match_only when both apply.",
		}),
	),
});

export type CursorSearchReplaceToolInput = Static<typeof searchReplaceSchema>;

function prepareSearchReplaceArguments(raw: unknown): CursorSearchReplaceToolInput {
	const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	let file_path =
		firstStringOrSingleElementArray(o, ["file_path", "path", "target_file", "file", "filename", "filepath", "uri"]) ?? "";
	file_path = dedupeAppRouterRouteGroupSegment(file_path.replace(/\\/g, "/"));
	const replace_all = toBoolFlexible(o.replace_all) ?? false;
	let replace_first_match_only = toBoolFlexible(o.replace_first_match_only);
	if (replace_first_match_only === undefined) {
		replace_first_match_only = toBoolFlexible(o.first_match_only);
	}
	if (replace_first_match_only === undefined) {
		replace_first_match_only = toBoolFlexible(o.replace_first);
	}
	// Default true: Gemini often duplicates blocks; replacing first avoids hard failures (caller can repeat).
	if (replace_first_match_only === undefined) {
		replace_first_match_only = true;
	}
	const out: CursorSearchReplaceToolInput = {
		file_path,
		old_string: firstStringOrJoinedArray(o, ["old_string", "oldString", "old", "from"]) ?? "",
		new_string: firstStringOrJoinedArray(o, ["new_string", "newString", "new", "to", "replacement"]) ?? "",
		replace_all,
		replace_first_match_only,
	};
	return out;
}

export function createSearchReplaceToolDefinition(cwd: string): ToolDefinition<typeof searchReplaceSchema, undefined> {
	return {
		name: "search_replace",
		label: "search_replace",
		description:
			"Replace old_string with new_string in a file. Copy text from read_file; line-number columns from read_file are stripped. Exact match first, then fuzzy (quotes/whitespace/tabs). If old_string appears multiple times: replace_all replaces every occurrence; otherwise replace_first_match_only (default true) changes only the first match so the tool does not fail. If old_string and new_string are identical after normalization, succeeds with no file change (not an error). Primary tool for editing existing files.",
		parameters: searchReplaceSchema,
		prepareArguments: prepareSearchReplaceArguments,
		async execute(
			_toolCallId,
			args: {
				file_path: string;
				old_string: string;
				new_string: string;
				replace_first_match_only?: boolean;
				replace_all?: boolean;
			},
			signal: AbortSignal | undefined,
			_onUpdate,
			_ctx: ExtensionContext,
		) {
			const oldStr = stripReadFileLineNumberPrefixes(normalizeToLF(args.old_string));
			const newStr = stripReadFileLineNumberPrefixes(normalizeToLF(args.new_string));
			if (oldStr === newStr) {
				// Not an error: model sometimes repeats a no-op; avoids wasting a turn on isError + retry churn.
				return {
					content: [
						{
							type: "text",
							text: `No change needed for ${args.file_path}: old_string and new_string are identical after normalization (file unchanged).`,
						},
					],
					details: undefined,
				};
			}
			const replaceAll = args.replace_all === true;
			// Default true via prepareArguments: duplicate blocks no longer hard-fail.
			const firstOnly = args.replace_first_match_only !== false;
			const abs = resolveReadPath(args.file_path, cwd);
			await fsAccess(abs, constants.R_OK | constants.W_OK);
			const raw = await fsReadFile(abs, "utf-8");
			const { bom, text } = stripBom(raw);
			const normalized = normalizeToLF(text);

			const exactCount = splitCount(normalized, oldStr);
			if (exactCount > 1) {
				const le = detectLineEnding(text);
				let updated: string;
				let note = "";
				if (replaceAll) {
					updated = replaceAllOccurrences(normalized, oldStr, newStr);
					note = ` (${exactCount} occurrences replaced)`;
				} else if (firstOnly) {
					updated = normalized.replace(oldStr, newStr);
					note = ` (first of ${exactCount} matches replaced; call again or use replace_all)`;
				} else {
					throw new Error(
						`old_string matched ${exactCount} times; widen the snippet for uniqueness, set replace_first_match_only true, or replace_all true.`,
					);
				}
				const out = bom + restoreLineEndings(updated, le);
				if (signal?.aborted) throw new Error("aborted");
				await fsWriteFile(abs, out, "utf-8");
				return {
					content: [{ type: "text", text: `Updated ${args.file_path}${note}` }],
					details: undefined,
				};
			}
			if (exactCount === 1) {
				const le = detectLineEnding(text);
				const updated = normalized.replace(oldStr, newStr);
				const out = bom + restoreLineEndings(updated, le);
				if (signal?.aborted) throw new Error("aborted");
				await fsWriteFile(abs, out, "utf-8");
				return { content: [{ type: "text", text: `Updated ${args.file_path}` }], details: undefined };
			}

			// No exact match: try fuzzy match (quotes/whitespace/unicode) like applyEditsToNormalizedContent
			const fuzzyHay = normalizeForFuzzyMatch(normalized);
			const fuzzyOld = normalizeForFuzzyMatch(oldStr);
			if (!fuzzyOld.length) {
				throw new Error("old_string not found in file");
			}
			let fuzzyCount = splitCount(fuzzyHay, fuzzyOld);
			let hayForReplace = fuzzyHay;
			let oldForReplace = fuzzyOld;
			let newForReplace = normalizeForFuzzyMatch(newStr);

			if (fuzzyCount === 0) {
				// Third pass: tab vs spaces drift (common when the model copies from an editor with different tab width)
				const tabHay = expandTabsToTwoSpaces(normalized);
				const tabOld = expandTabsToTwoSpaces(oldStr);
				const tabNew = expandTabsToTwoSpaces(newStr);
				const fTabHay = normalizeForFuzzyMatch(tabHay);
				const fTabOld = normalizeForFuzzyMatch(tabOld);
				fuzzyCount = splitCount(fTabHay, fTabOld);
				if (fuzzyCount === 1) {
					newForReplace = normalizeForFuzzyMatch(tabNew);
					const idx = fTabHay.indexOf(fTabOld);
					const updated = fTabHay.slice(0, idx) + newForReplace + fTabHay.slice(idx + fTabOld.length);
					const le = detectLineEnding(text);
					const out = bom + restoreLineEndings(updated, le);
					if (signal?.aborted) throw new Error("aborted");
					await fsWriteFile(abs, out, "utf-8");
					return { content: [{ type: "text", text: `Updated ${args.file_path}` }], details: undefined };
				}
				throw new Error("old_string not found in file");
			}
			if (fuzzyCount > 1) {
				const le = detectLineEnding(text);
				let updatedF: string;
				let note = "";
				if (replaceAll) {
					updatedF = replaceAllOccurrences(hayForReplace, oldForReplace, newForReplace);
					note = ` (${fuzzyCount} fuzzy matches replaced)`;
				} else if (firstOnly) {
					const idx0 = hayForReplace.indexOf(oldForReplace);
					updatedF =
						hayForReplace.slice(0, idx0) + newForReplace + hayForReplace.slice(idx0 + oldForReplace.length);
					note = ` (first of ${fuzzyCount} fuzzy matches; call again or use replace_all)`;
				} else {
					throw new Error(
						`old_string matched ${fuzzyCount} times (fuzzy); widen old_string or set replace_first_match_only / replace_all.`,
					);
				}
				const out = bom + restoreLineEndings(updatedF, le);
				if (signal?.aborted) throw new Error("aborted");
				await fsWriteFile(abs, out, "utf-8");
				return {
					content: [{ type: "text", text: `Updated ${args.file_path}${note}` }],
					details: undefined,
				};
			}
			const idx = hayForReplace.indexOf(oldForReplace);
			const updated = hayForReplace.slice(0, idx) + newForReplace + hayForReplace.slice(idx + oldForReplace.length);
			const le = detectLineEnding(text);
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

/** Replace every non-overlapping occurrence (left-to-right). Guarded against pathological loops. */
function replaceAllOccurrences(hay: string, needle: string, replacement: string): string {
	if (!needle) return hay;
	let out = hay;
	for (let guard = 0; guard < 50_000; guard++) {
		const j = out.indexOf(needle);
		if (j === -1) break;
		out = out.slice(0, j) + replacement + out.slice(j + needle.length);
	}
	return out;
}

/** Approximate tab width for tolerant matching when the model's old_string uses spaces and the file uses tabs (or vice versa). */
function expandTabsToTwoSpaces(s: string): string {
	return s.replace(/\t/g, "  ");
}

export function createSearchReplaceTool(cwd: string): AgentTool {
	return wrapToolDefinition(createSearchReplaceToolDefinition(cwd));
}

export const searchReplaceToolDefinition = createSearchReplaceToolDefinition(process.cwd());
export const searchReplaceTool = wrapToolDefinition(searchReplaceToolDefinition);
