/**
 * `grep_search` — regex ripgrep; high match cap for full file discovery (tau).
 */

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import { ensureTool } from "../../utils/tools-manager.js";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.js";
import { asRecord, firstString, firstStringOrJoinedArray, toBoolFlexible } from "./flexible-tool-args.js";
import { resolveReadPath, resolveToCwd } from "./path-utils.js";
import { str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { truncateLine } from "./truncate.js";

/** High cap so layered discovery can enumerate callsites across large apps without truncating too early. */
const MATCH_CAP = 1500;

/** Same idea as codebase_search offline pass — skip heavy / non-text trees. */
const OFFLINE_SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"out",
	".next",
	"target",
	"coverage",
	".turbo",
	"__pycache__",
]);
const OFFLINE_TEXT_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|yaml|yml|toml|go|rs|py|java|kt|vue|svelte|css|scss|html|sql|sh)$/i;

/**
 * When ripgrep cannot run (offline Docker, download failed, broken binary), scan text files with JS RegExp.
 */
function resolveGrepScopeRoot(pathArg: string | undefined, cwd: string): string {
	const repoRoot = resolveToCwd(".", cwd);
	if (!pathArg?.trim()) return repoRoot;
	const abs = resolveReadPath(pathArg.trim(), cwd);
	if (!existsSync(abs)) {
		throw new Error(`grep_search: path not found: ${pathArg}`);
	}
	const st = statSync(abs);
	if (st.isFile()) return path.dirname(abs);
	return abs;
}

async function grepSearchOfflineFs(
	cwd: string,
	searchRootAbs: string,
	query: string,
	case_sensitive: boolean | undefined,
	include_pattern: string | undefined,
	exclude_pattern: string | undefined,
	signal: AbortSignal | undefined,
): Promise<string[]> {
	let re: RegExp;
	try {
		re = new RegExp(query, case_sensitive === false ? "i" : "");
	} catch {
		return [];
	}

	const linesOut: string[] = [];
	let n = 0;
	const searchRoot = searchRootAbs;

	function includeOk(relPath: string): boolean {
		if (include_pattern?.trim()) {
			const g = include_pattern.trim();
			if (g.startsWith("*.")) {
				if (!relPath.endsWith(g.slice(1))) return false;
			} else if (!relPath.includes(g.replace(/^\*\*?\/?/, ""))) {
				return false;
			}
		}
		if (exclude_pattern?.trim()) {
			const g = exclude_pattern.trim();
			if (g.startsWith("*.")) {
				if (relPath.endsWith(g.slice(1))) return false;
			} else if (relPath.includes(g.replace(/^\*\*?\/?/, ""))) {
				return false;
			}
		}
		return true;
	}

	async function walkDir(dir: string): Promise<void> {
		if (n >= MATCH_CAP || signal?.aborted) {
			return;
		}
		let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (signal?.aborted) {
				throw new Error("aborted");
			}
			const full = path.join(dir, e.name);
			if (e.isDirectory()) {
				if (OFFLINE_SKIP_DIRS.has(e.name)) continue;
				await walkDir(full);
			} else if (e.isFile()) {
				if (!OFFLINE_TEXT_FILE.test(e.name)) continue;
				const rel = path.relative(cwd, full).replace(/\\/g, "/") || e.name;
				if (!includeOk(rel)) continue;
				let content: string;
				try {
					content = await readFile(full, "utf-8");
				} catch {
					continue;
				}
				if (content.length > 512 * 1024) {
					continue;
				}
				const lines = content.replace(/\r\n/g, "\n").split("\n");
				for (let i = 0; i < lines.length; i++) {
					if (n >= MATCH_CAP) {
						return;
					}
					const line = lines[i] ?? "";
					if (re.test(line)) {
						const { text: tl } = truncateLine(line.replace(/\r/g, ""));
						linesOut.push(`${rel}:${i + 1}: ${tl}`);
						n++;
					}
				}
			}
		}
	}

	await walkDir(searchRoot);
	return linesOut;
}

const grepSearchSchema = Type.Object({
	query: Type.String({ description: "The regex pattern to search for" }),
	/** Optional subtree for thorough scoped sweeps (client/, packages/foo/, etc.). */
	path: Type.Optional(
		Type.String({
			description:
				"Optional directory path relative to the workspace to search under (narrower than whole repo). Omit to search the entire workspace. Use for layered discovery per subtree.",
		}),
	),
	case_sensitive: Type.Optional(Type.Boolean({ description: "Whether the search should be case sensitive" })),
	exclude_pattern: Type.Optional(Type.String({ description: "Glob pattern for files to exclude" })),
	include_pattern: Type.Optional(Type.String({ description: "Glob pattern for files to include (e.g. '*.ts')" })),
	explanation: Type.Optional(
		Type.String({
			description: "One sentence explanation as to why this tool is being used, and how it contributes to the goal.",
		}),
	),
});

export type GrepSearchToolInput = Static<typeof grepSearchSchema>;

function prepareGrepSearchArguments(raw: unknown): GrepSearchToolInput {
	const o = asRecord(raw);
	const query = firstStringOrJoinedArray(o, ["query", "pattern", "regex", "search", "q", "text"]) ?? "";
	let case_sensitive = toBoolFlexible(o.case_sensitive);
	if (case_sensitive === undefined && o.case_insensitive !== undefined) {
		const ci = toBoolFlexible(o.case_insensitive);
		if (ci !== undefined) {
			case_sensitive = !ci;
		}
	}
	const exclude_pattern = firstString(o, ["exclude_pattern", "exclude", "excludeGlob"]);
	const include_pattern = firstString(o, ["include_pattern", "include", "includeGlob", "glob"]);
	const scopePath =
		firstString(o, ["path", "relative_workspace_path", "directory", "dir", "scope", "root", "search_path"]) ??
		undefined;
	const explanation = firstString(o, ["explanation", "reason", "purpose"]);
	const out: GrepSearchToolInput = { query };
	if (scopePath !== undefined && scopePath.trim()) {
		out.path = scopePath.trim();
	}
	if (case_sensitive !== undefined) {
		out.case_sensitive = case_sensitive;
	}
	if (exclude_pattern !== undefined) {
		out.exclude_pattern = exclude_pattern;
	}
	if (include_pattern !== undefined) {
		out.include_pattern = include_pattern;
	}
	if (explanation !== undefined) {
		out.explanation = explanation;
	}
	return out;
}

export function createGrepSearchToolDefinition(cwd: string): ToolDefinition<typeof grepSearchSchema, undefined> {
	return {
		name: "grep_search",
		label: "grep_search",
		description:
			"Fast regex search (ripgrep; capped at 1500 matches). Use optional `path` to sweep one subtree at a time. Run **separate** calls per important literal/symbol from the task; merge paths into your candidate list. When the host allows multiple tool calls per turn, batch independent greps in parallel. Escape regex metacharacters for literal strings.",
		parameters: grepSearchSchema,
		prepareArguments: prepareGrepSearchArguments,
		async execute(
			_toolCallId,
			args: {
				query: string;
				path?: string;
				case_sensitive?: boolean;
				exclude_pattern?: string;
				include_pattern?: string;
				explanation?: string;
			},
			signal: AbortSignal | undefined,
			_onUpdate,
			_ctx: ExtensionContext,
		) {
			let scopeRoot: string;
			try {
				scopeRoot = resolveGrepScopeRoot(args.path, cwd);
			} catch (e) {
				return {
					content: [
						{
							type: "text" as const,
							text: e instanceof Error ? e.message : String(e),
						},
					],
					details: undefined,
				};
			}
			const rgPath = await ensureTool("rg", true);
			if (!rgPath) {
				const lines = await grepSearchOfflineFs(
					cwd,
					scopeRoot,
					args.query,
					args.case_sensitive,
					args.include_pattern,
					args.exclude_pattern,
					signal,
				);
				const header =
					"[grep_search: ripgrep (rg) unavailable — using built-in filesystem regex scan; install `rg` for full speed.]\n";
				if (lines.length === 0) {
					return {
						content: [{ type: "text" as const, text: `${header}No matches.` }],
						details: undefined,
					};
				}
				let text = header + lines.join("\n");
				if (lines.length >= MATCH_CAP) {
					text += `\n[Truncated at ${MATCH_CAP} matches]`;
				}
				return { content: [{ type: "text" as const, text }], details: undefined };
			}

			const rgArgs: string[] = ["--json", "--line-number", "--color=never", "--hidden"];
			if (args.case_sensitive === false) rgArgs.push("--ignore-case");
			if (args.include_pattern) rgArgs.push("--glob", args.include_pattern);
			if (args.exclude_pattern?.trim()) rgArgs.push("--glob", `!${args.exclude_pattern.trim()}`);
			rgArgs.push(args.query, scopeRoot);

			const finishOffline = async (reason: string) => {
				const lines = await grepSearchOfflineFs(
					cwd,
					scopeRoot,
					args.query,
					args.case_sensitive,
					args.include_pattern,
					args.exclude_pattern,
					signal,
				);
				const header = `[grep_search: ${reason} — using built-in filesystem regex scan.]\n`;
				if (lines.length === 0) {
					return { content: [{ type: "text" as const, text: `${header}No matches.` }], details: undefined };
				}
				let text = header + lines.join("\n");
				if (lines.length >= MATCH_CAP) {
					text += `\n[Truncated at ${MATCH_CAP} matches]`;
				}
				return { content: [{ type: "text" as const, text }], details: undefined };
			};

			try {
				const result = await new Promise<{
					content: Array<{ type: "text"; text: string }>;
				}>((resolve, reject) => {
					const child = spawn(rgPath, rgArgs, { stdio: ["ignore", "pipe", "pipe"] });
					const rl = createInterface({ input: child.stdout });
					const linesOut: string[] = [];
					let n = 0;
					const onAbort = () => child.kill();
					signal?.addEventListener("abort", onAbort, { once: true });

					rl.on("line", (line) => {
						if (n >= MATCH_CAP) return;
						let ev: {
							type?: string;
							data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
						};
						try {
							ev = JSON.parse(line);
						} catch {
							return;
						}
						if (ev.type !== "match" || !ev.data?.path?.text) return;
						const rel = path.relative(cwd, ev.data.path.text).replace(/\\/g, "/") || ev.data.path.text;
						const ln = ev.data.line_number ?? 0;
						const t = (ev.data.lines?.text ?? "").replace(/\r/g, "");
						const { text: tl } = truncateLine(t);
						linesOut.push(`${rel}:${ln}: ${tl}`);
						n++;
						if (n >= MATCH_CAP) child.kill();
					});
					child.on("close", () => {
						signal?.removeEventListener("abort", onAbort);
						if (signal?.aborted) {
							reject(new Error("aborted"));
							return;
						}
						if (linesOut.length === 0) {
							resolve({ content: [{ type: "text" as const, text: "No matches (or ripgrep error)." }] });
							return;
						}
						let text = linesOut.join("\n");
						if (n >= MATCH_CAP) text += `\n[Truncated at ${MATCH_CAP} matches]`;
						resolve({ content: [{ type: "text" as const, text }] });
					});
					child.on("error", reject);
				});
				return { ...result, details: undefined };
			} catch (err) {
				if (signal?.aborted) {
					throw err instanceof Error ? err : new Error(String(err));
				}
				return finishOffline(`ripgrep failed (${err instanceof Error ? err.message : String(err)})`);
			}
		},
		renderCall(args, theme, context) {
			const q = str(args?.query);
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				theme.fg("toolTitle", theme.bold("grep_search")) + " " + theme.fg("accent", (q ?? "/?/").slice(0, 80)),
			);
			return text;
		},
	};
}

export function createGrepSearchTool(cwd: string): AgentTool {
	return wrapToolDefinition(createGrepSearchToolDefinition(cwd));
}

export const grepSearchToolDefinition = createGrepSearchToolDefinition(process.cwd());
export const grepSearchTool = wrapToolDefinition(grepSearchToolDefinition);
