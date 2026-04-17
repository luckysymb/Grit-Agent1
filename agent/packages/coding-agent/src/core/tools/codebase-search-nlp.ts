/**
 * Lightweight NLP-style helpers for `codebase_search`: tokenization, loyalty-weighted
 * keyword augmentation (no external ML deps — deterministic heuristics).
 */

/** Stop words — keep in sync with codebase-search.ts filtering philosophy. */
export const NLP_STOP = new Set([
	"the",
	"and",
	"for",
	"with",
	"that",
	"this",
	"from",
	"should",
	"must",
	"when",
	"each",
	"into",
	"also",
	"have",
	"been",
	"will",
	"they",
	"them",
	"their",
	"there",
	"which",
	"what",
	"where",
	"while",
	"would",
	"could",
	"these",
	"those",
	"then",
	"than",
	"some",
	"more",
	"other",
	"only",
	"just",
	"like",
	"such",
	"make",
	"does",
	"how",
	"are",
	"was",
	"were",
	"being",
	"your",
	"our",
	"not",
	"but",
	"any",
	"all",
	"can",
	"get",
	"use",
	"using",
	"used",
	"new",
	"way",
	"may",
	"its",
	"out",
	"who",
	"did",
	"into",
	"over",
	"very",
	"here",
	"both",
	"done",
	"call",
	"file",
	"code",
	"need",
	"want",
	"help",
	"find",
	"search",
	"look",
]);

const MAX_SEED = 30;
const MAX_TOTAL_KEYWORDS = 68;
function cleanForTokens(raw: string): string {
	return raw.replace(/[`'"[\](){}]/g, " ");
}

/** Split camelCase / PascalCase / snake_case into segments. */
export function splitIdentifierSegments(token: string): string[] {
	const out: string[] = [];
	const snake = token.split(/_+/).filter(Boolean);
	for (const part of snake) {
		const splits = part.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/);
		for (const s of splits) {
			const t = s.trim();
			if (t.length >= 2) out.push(t);
		}
	}
	return out.length ? out : token.length >= 2 ? [token] : [];
}

function baseTokens(line: string): string[] {
	const cleaned = cleanForTokens(line);
	const parts = cleaned.split(/[^a-zA-Z0-9_]+/).filter((w) => w.length >= 2);
	const expanded: string[] = [];
	for (const p of parts) {
		expanded.push(p);
		for (const seg of splitIdentifierSegments(p)) {
			if (seg !== p && seg.length >= 2) expanded.push(seg);
		}
	}
	return expanded;
}

/** Extract seed keywords from query + optional explanation (loyalty anchor). */
export function buildSeedKeywords(query: string, explanation?: string): string[] {
	const combined = [query, explanation ?? ""].join("\n");
	const seen = new Set<string>();
	const out: string[] = [];
	for (const t of baseTokens(combined)) {
		const w = t.toLowerCase();
		if (NLP_STOP.has(w) || seen.has(w)) continue;
		seen.add(w);
		out.push(t.length > 48 ? t.slice(0, 48) : t);
		if (out.length >= MAX_SEED) break;
	}
	return out;
}

/** Multi-word phrases (2–4 words) from loyal text for fixed-string search. */
export function extractLoyalPhrases(loyalText: string, maxPhrases: number): string[] {
	const words = cleanForTokens(loyalText)
		.toLowerCase()
		.split(/[^a-z0-9_]+/)
		.filter((w) => w.length > 2 && !NLP_STOP.has(w));
	const phrases: string[] = [];
	const seen = new Set<string>();
	for (let n = 2; n <= 4 && phrases.length < maxPhrases; n++) {
		for (let i = 0; i + n <= words.length; i++) {
			const slice = words.slice(i, i + n);
			if (slice.some((w) => NLP_STOP.has(w))) continue;
			const p = slice.join(" ");
			if (p.length < 6 || seen.has(p)) continue;
			seen.add(p);
			phrases.push(slice.join(" "));
			if (phrases.length >= maxPhrases) break;
		}
	}
	return phrases.slice(0, maxPhrases);
}

function loyalWordBag(query: string, explanation?: string): Set<string> {
	const bag = new Set<string>();
	for (const t of baseTokens(`${query}\n${explanation ?? ""}`)) {
		const w = t.toLowerCase();
		if (w.length >= 3) bag.add(w);
	}
	return bag;
}

/**
 * Augment keywords after reading high-hit files. Strongly biased toward:
 * - tokens that appear in or align with the original query/explanation (loyalty)
 * - tokens on lines that already matched prior keywords (co-occurrence)
 * - identifier-shaped tokens (camelCase, types, enum-like)
 */
export function augmentKeywordsNlp(
	query: string,
	explanation: string | undefined,
	priorKeywords: string[],
	fileTexts: string[],
): string[] {
	const loyal = `${query}\n${explanation ?? ""}`;
	const loyalLower = loyal.toLowerCase();
	const loyalWords = loyalWordBag(query, explanation);
	const priorLower = new Set(priorKeywords.map((k) => k.toLowerCase()));
	const scored = new Map<string, number>();

	for (const k of priorKeywords) {
		scored.set(k, 10_000);
	}

	const seedLower = priorKeywords.map((k) => k.toLowerCase()).filter((k) => k.length >= 2);

	for (const text of fileTexts) {
		if (!text.trim()) continue;
		const lines = text.split(/\r?\n/);
		for (const line of lines) {
			const lineLower = line.toLowerCase();
			const lineRelevant = seedLower.some((s) => lineLower.includes(s));
			const tokens = baseTokens(line);
			for (const raw of tokens) {
				const t = raw.length > 64 ? raw.slice(0, 64) : raw;
				const lower = t.toLowerCase();
				if (lower.length < 3 || NLP_STOP.has(lower) || priorLower.has(lower)) continue;

				let score = 0;
				if (loyalLower.includes(lower)) score += 80;
				for (const lw of loyalWords) {
					if (lw.length >= 4 && (lower.includes(lw) || lw.includes(lower))) {
						score += 35;
						break;
					}
				}
				if (/^[A-Z][a-zA-Z0-9]{2,}$/.test(t) || /[a-z][A-Z]/.test(t)) score += 22;
				if (/^[a-z]+[A-Z]/.test(t)) score += 18;
				if (lineRelevant) score += 25;
				if (score === 0) continue;

				scored.set(t, (scored.get(t) ?? 0) + score);
			}
		}
	}

	const bestDisplay = new Map<string, { display: string; sc: number }>();
	for (const [k, sc] of scored) {
		const lk = k.toLowerCase();
		const prev = bestDisplay.get(lk);
		if (!prev || sc > prev.sc) bestDisplay.set(lk, { display: k, sc });
	}

	const sorted = [...bestDisplay.values()].sort((a, b) => b.sc - a.sc);

	const out: string[] = [];
	const seen = new Set<string>();
	for (const { display } of sorted) {
		const lk = display.toLowerCase();
		if (seen.has(lk)) continue;
		seen.add(lk);
		out.push(display);
		if (out.length >= MAX_TOTAL_KEYWORDS) break;
	}

	return out.slice(0, MAX_TOTAL_KEYWORDS);
}

export const nlpConstants = {
	MAX_SEED,
	MAX_TOTAL_KEYWORDS,
} as const;
