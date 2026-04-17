/**
 * Normalizes LLM tool arguments (especially Gemini) before TypeBox/AJV validation.
 * Models often use alternate key names, string booleans, or wrong JSON shapes.
 */

export function asRecord(raw: unknown): Record<string, unknown> {
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		return raw as Record<string, unknown>;
	}
	return {};
}

/** First non-empty string among keys (common LLM aliases). */
export function firstString(o: Record<string, unknown>, keys: string[]): string | undefined {
	for (const k of keys) {
		const v = o[k];
		if (typeof v === "string" && v.length > 0) {
			return v;
		}
	}
	return undefined;
}

/** Gemini sometimes sends `query` as string[] — join into one search string. */
/** Some models send a single path as a one-element array. */
export function firstStringOrSingleElementArray(o: Record<string, unknown>, keys: string[]): string | undefined {
	for (const k of keys) {
		const v = o[k];
		if (typeof v === "string" && v.length > 0) {
			return v;
		}
		if (Array.isArray(v) && v.length === 1 && typeof v[0] === "string" && v[0].length > 0) {
			return v[0];
		}
	}
	return undefined;
}

export function firstStringOrJoinedArray(o: Record<string, unknown>, keys: string[]): string | undefined {
	for (const k of keys) {
		const v = o[k];
		if (typeof v === "string" && v.length > 0) {
			return v;
		}
		if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string")) {
			const joined = v.map((s) => s.trim()).filter(Boolean).join(" ");
			if (joined.length > 0) {
				return joined;
			}
		}
	}
	return undefined;
}

export function toBoolFlexible(v: unknown): boolean | undefined {
	if (typeof v === "boolean") {
		return v;
	}
	if (typeof v === "string") {
		const s = v.trim().toLowerCase();
		if (s === "true" || s === "1" || s === "yes") {
			return true;
		}
		if (s === "false" || s === "0" || s === "no") {
			return false;
		}
	}
	return undefined;
}

export function toIntFlexible(v: unknown): number | undefined {
	if (typeof v === "number" && Number.isFinite(v)) {
		return Math.trunc(v);
	}
	if (typeof v === "string" && /^\s*\d+\s*$/.test(v)) {
		return parseInt(v.trim(), 10);
	}
	return undefined;
}

/**
 * Coerce target_directories to string[] — Gemini often sends a single string or comma-separated list.
 */
export function normalizeTargetDirectoriesField(v: unknown): string[] | undefined {
	if (v === undefined || v === null) {
		return undefined;
	}
	if (Array.isArray(v)) {
		const out = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((s) => s.trim());
		return out.length ? out : undefined;
	}
	if (typeof v === "string") {
		const parts = v
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		return parts.length ? parts : [v.trim()];
	}
	return undefined;
}

/** Single directory scope: models send `target_directory` (string) instead of `target_directories` (array). */
export function coalesceTargetDirectoryField(o: Record<string, unknown>): string[] | undefined {
	const dirs =
		normalizeTargetDirectoriesField(o.target_directories) ??
		(typeof o.target_directory === "string" && o.target_directory.trim()
			? [o.target_directory.trim()]
			: undefined) ??
		normalizeTargetDirectoriesField(o.directories) ??
		(typeof o.directory === "string" && o.directory.trim() ? [o.directory.trim()] : undefined);
	return dirs;
}
