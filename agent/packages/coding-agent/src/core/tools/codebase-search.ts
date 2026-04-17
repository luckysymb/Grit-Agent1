/**
 * Cursor-style "codebase_search": keyword / ripgrep–based exploration over the repo.
 * Runs 5 refinement rounds: ripgrep → read top-10 hit files → NLP keyword augmentation (loyal to query+explanation) → repeat.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import { ensureTool } from "../../utils/tools-manager.js";
import type { ExtensionContext, ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { augmentKeywordsNlp, buildSeedKeywords, extractLoyalPhrases } from "./codebase-search-nlp.js";
import { resolveToCwd } from "./path-utils.js";
import { getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate.js";

const SEARCH_ROUNDS = 5;
const TOP_FILES_TO_READ = 10;
/** Cap per high-hit file when mining tokens for augmentation (bytes). */
const NLP_READ_BYTES = 64 * 1024;

const codebaseSearchSchema = Type.Object({
	query: Type.String({
		description:
			"The search query to find relevant code. You should reuse the user's exact query/most recent message with their wording unless there is a clear reason not to.",
	}),
	target_directories: Type.Optional(
		Type.Array(Type.String(), {
			description: "Glob patterns for directories to search over",
		}),
	),
	explanation: Type.Optional(
		Type.String({
			description:
				"One sentence explanation as to why this tool is being used, and how it contributes to the goal. Used to anchor multi-round keyword expansion.",
		}),
	),
});

export type CodebaseSearchToolInput = Static<typeof codebaseSearchSchema>;

const DEFAULT_FILE_LIMIT = 25;
const SNIPPET_LINES = 4;

function escapeRgLiteral(s: string): string {
	return s.replace(/[\\.*+?^${}()|[\]\\]/g, "\\$&");
}

function dedupeKeywordsPreserveOrder(keywords: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const k of keywords) {
		const lk = k.toLowerCase();
		if (seen.has(lk)) continue;
		seen.add(lk);
		out.push(k);
	}
	return out;
}

function buildInitialKeywordSet(query: string, explanation?: string): string[] {
	const seeds = buildSeedKeywords(query, explanation);
	const loyal = `${query}\n${explanation ?? ""}`;
	const phrases = extractLoyalPhrases(loyal, 8);
	const merged = dedupeKeywordsPreserveOrder([...seeds, ...phrases]);
	return merged;
}

function isPathInsideRoot(absFile: string, repoRoot: string): boolean {
	const root = path.resolve(repoRoot);
	const target = path.resolve(absFile);
	return target === root || target.startsWith(root + path.sep);
}

interface RipgrepOutcome {
	fileHits: Map<string, number>;
	samples: Map<string, Array<{ line: number; text: string }>>;
	stderr: string;
	exitCode: number | null;
}

function runRipgrepPass(
	rgPath: string,
	searchRoots: string[],
	keywords: string[],
	signal: AbortSignal | undefined,
): Promise<RipgrepOutcome> {
	return new Promise((resolve, reject) => {
		if (keywords.length === 0) {
			resolve({ fileHits: new Map(), samples: new Map(), stderr: "", exitCode: 0 });
			return;
		}
		if (signal?.aborted) {
			reject(new Error("Operation aborted"));
			return;
		}

		const pattern = keywords.map(escapeRgLiteral).join("|");
		const args: string[] = [
			"--json",
			"--line-number",
			"--color=never",
			"--hidden",
			"--ignore-case",
			"--fixed-strings",
			pattern,
			...searchRoots,
		];

		const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
		const rl = createInterface({ input: child.stdout });
		const fileHits = new Map<string, number>();
		const samples = new Map<string, Array<{ line: number; text: string }>>();

		const onAbort = () => {
			child.kill();
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		let stderr = "";
		child.stderr?.on("data", (c) => {
			stderr += c.toString();
		});

		rl.on("line", (line) => {
			let event: {
				type?: string;
				data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
			};
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event.type !== "match" || !event.data?.path?.text) return;
			const fp = event.data.path.text;
			fileHits.set(fp, (fileHits.get(fp) ?? 0) + 1);
			const ln = event.data.line_number ?? 0;
			const text = (event.data.lines?.text ?? "").replace(/\r/g, "").trim();
			if (!samples.has(fp)) samples.set(fp, []);
			const arr = samples.get(fp)!;
			if (arr.length < SNIPPET_LINES && text) {
				arr.push({ line: ln, text: text.length > 240 ? `${text.slice(0, 240)}…` : text });
			}
		});

		rl.on("close", () => {
			signal?.removeEventListener("abort", onAbort);
		});

		child.on("error", (err) => {
			signal?.removeEventListener("abort", onAbort);
			reject(err);
		});

		child.on("close", (code) => {
			signal?.removeEventListener("abort", onAbort);
			if (signal?.aborted) {
				reject(new Error("Operation aborted"));
				return;
			}
			resolve({ fileHits, samples, stderr, exitCode: code });
		});
	});
}

function formatCall(
	args: { query?: string; target_directories?: string[] } | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): string {
	const q = str(args?.query);
	const scope =
		args?.target_directories?.length && args.target_directories[0]
			? args.target_directories.map((d) => shortenPath(d)).join(", ")
			: ".";
	const invalidArg = invalidArgText(theme);
	return (
		theme.fg("toolTitle", theme.bold("codebase_search")) +
		" " +
		(q === null ? invalidArg : theme.fg("accent", (q || "").slice(0, 80))) +
		theme.fg("toolOutput", ` in ${scope}`)
	);
}

function formatResult(
	result: { content: Array<{ type: string; text?: string }> },
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	if (!output) return "";
	const lines = output.split("\n");
	const maxLines = options.expanded ? lines.length : 40;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let text = `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
	}
	return text;
}

export function createCodebaseSearchToolDefinition(
	cwd: string,
): ToolDefinition<typeof codebaseSearchSchema, undefined> {
	return {
		name: "codebase_search",
		label: "codebase_search",
		description: `Find relevant code via multi-round ripgrep + NLP keyword refinement (5 passes: search → read top-10 hit files → augment keywords loyal to query/explanation → repeat). Not an embedding index; respects .gitignore.`,
		parameters: codebaseSearchSchema,
		async execute(
			_toolCallId,
			{
				query,
				target_directories: targetDirs,
				explanation,
			}: {
				query: string;
				target_directories?: string[];
				explanation?: string;
			},
			signal: AbortSignal | undefined,
			_onUpdate,
			_ctx: ExtensionContext,
		) {
			let keywords = buildInitialKeywordSet(query, explanation);
			if (keywords.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "No searchable keywords in query/explanation. Add concrete symbols, file names, or domain words.",
						},
					],
					details: undefined,
				};
			}

			const rgPath = await ensureTool("rg", true);
			if (!rgPath) {
				throw new Error("ripgrep (rg) is not available and could not be downloaded");
			}

			const searchRoots =
				targetDirs?.length && targetDirs.some((d) => d?.trim())
					? targetDirs.filter((d) => d?.trim()).map((d) => resolveToCwd(d.trim(), cwd))
					: [resolveToCwd(".", cwd)];

			const fileLimit = DEFAULT_FILE_LIMIT;
			const cumulativeHits = new Map<string, number>();
			const roundSummaries: string[] = [];
			const mergedSamples = new Map<string, Array<{ line: number; text: string }>>();

			for (let round = 1; round <= SEARCH_ROUNDS; round++) {
				if (signal?.aborted) {
					throw new Error("Operation aborted");
				}

				const { fileHits, samples, stderr, exitCode } = await runRipgrepPass(rgPath, searchRoots, keywords, signal);

				for (const [fp, n] of fileHits) {
					cumulativeHits.set(fp, (cumulativeHits.get(fp) ?? 0) + n);
				}

				for (const [fp, sn] of samples) {
					if (sn.length) mergedSamples.set(fp, sn);
				}

				const ranked = [...fileHits.entries()].sort((a, b) => b[1] - a[1]);

				roundSummaries.push(
					`Round ${round}/${SEARCH_ROUNDS} — ${fileHits.size} file(s) with matches, keywords (${keywords.length}): ${keywords.slice(0, 20).join(", ")}${keywords.length > 20 ? " …" : ""}`,
				);
				if (stderr.trim() && exitCode !== 0 && exitCode !== 1) {
					roundSummaries.push(`[rg] ${stderr.trim().slice(0, 200)}`);
				}

				if (round < SEARCH_ROUNDS && ranked.length > 0) {
					const topPaths = ranked.slice(0, TOP_FILES_TO_READ).map(([p]) => p);
					const texts: string[] = [];
					for (const abs of topPaths) {
						if (!isPathInsideRoot(abs, cwd)) continue;
						try {
							const buf = await readFile(abs);
							const slice = buf.subarray(0, Math.min(buf.length, NLP_READ_BYTES));
							texts.push(slice.toString("utf8"));
						} catch {
							texts.push("");
						}
					}
					keywords = augmentKeywordsNlp(query, explanation, keywords, texts);
					if (keywords.length === 0) {
						keywords = buildInitialKeywordSet(query, explanation);
					}
				}
			}

			if (cumulativeHits.size === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No matches after ${SEARCH_ROUNDS} rounds. ${roundSummaries.join("\n")}`,
						},
					],
					details: undefined,
				};
			}

			const finalRanked = [...cumulativeHits.entries()].sort((a, b) => b[1] - a[1]).slice(0, fileLimit);

			const linesOut: string[] = [
				`Multi-round codebase_search (${SEARCH_ROUNDS} passes, top ${TOP_FILES_TO_READ} files/read used for NLP augmentation between passes).`,
				"Loyalty: augmented terms are weighted toward your query + explanation and co-occurring identifiers in high-hit lines.",
				"",
				...roundSummaries,
				"",
				`Final ranking by cumulative hits across rounds — top ${finalRanked.length} file(s):`,
				"",
			];

			for (const [abs, hits] of finalRanked) {
				let rel = path.relative(cwd, abs).replace(/\\/g, "/");
				if (!rel || rel.startsWith("..")) rel = abs;
				linesOut.push(`• ${rel} (${hits} cumulative hits)`);
				const sn = mergedSamples.get(abs);
				if (sn?.length) {
					for (const s of sn) {
						linesOut.push(`    ${s.line}: ${s.text}`);
					}
				}
				linesOut.push("");
			}

			const raw = linesOut.join("\n").trimEnd();
			const truncation = truncateHead(raw, { maxLines: Number.MAX_SAFE_INTEGER });
			let text = truncation.content;
			if (truncation.truncated) {
				text += `\n\n[Truncated at ${formatSize(DEFAULT_MAX_BYTES)}]`;
			}
			return { content: [{ type: "text", text }], details: undefined };
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatResult(result, options, theme, context.showImages));
			return text;
		},
	};
}

export function createCodebaseSearchTool(cwd: string): AgentTool {
	return wrapToolDefinition(createCodebaseSearchToolDefinition(cwd));
}

export const codebaseSearchToolDefinition = createCodebaseSearchToolDefinition(process.cwd());
export const codebaseSearchTool = wrapToolDefinition(codebaseSearchToolDefinition);
