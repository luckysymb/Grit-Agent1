import { accessSync, constants } from "node:fs";
import * as os from "node:os";
import { isAbsolute, normalize as normalizePath, resolve as resolvePath } from "node:path";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NARROW_NO_BREAK_SPACE = "\u202F";
function normalizeUnicodeSpaces(str: string): string {
	return str.replace(UNICODE_SPACES, " ");
}

function tryMacOSScreenshotPath(filePath: string): string {
	return filePath.replace(/ (AM|PM)\./g, `${NARROW_NO_BREAK_SPACE}$1.`);
}

function tryNFDVariant(filePath: string): string {
	// macOS stores filenames in NFD (decomposed) form, try converting user input to NFD
	return filePath.normalize("NFD");
}

function tryCurlyQuoteVariant(filePath: string): string {
	// macOS uses U+2019 (right single quotation mark) in screenshot names like "Capture d'écran"
	// Users typically type U+0027 (straight apostrophe)
	return filePath.replace(/'/g, "\u2019");
}

function fileExists(filePath: string): boolean {
	try {
		accessSync(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function normalizeAtPrefix(filePath: string): string {
	return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}

export function expandPath(filePath: string): string {
	const normalized = normalizeUnicodeSpaces(normalizeAtPrefix(filePath));
	if (normalized === "~") {
		return os.homedir();
	}
	if (normalized.startsWith("~/")) {
		return os.homedir() + normalized.slice(1);
	}
	return normalized;
}

/**
 * Resolve a path relative to the given cwd.
 * Handles ~ expansion and absolute paths.
 */
export function resolveToCwd(filePath: string, cwd: string): string {
	const expanded = expandPath(filePath);
	if (isAbsolute(expanded)) {
		return expanded;
	}
	return resolvePath(cwd, expanded);
}

/**
 * LLMs often duplicate the Next.js app-router **route group** folder name as the next path segment
 * (e.g. `src/app/(client)/client/dashboard/page.tsx` instead of `.../(client)/dashboard/page.tsx`).
 * Collapse `(name)/name/` → `(name)/` repeatedly until stable.
 */
export function dedupeAppRouterRouteGroupSegment(pathStr: string): string {
	let s = pathStr.replace(/\\/g, "/");
	let prev = "";
	while (s !== prev) {
		prev = s;
		s = s.replace(/\(([^)]+)\)\/\1\//g, "($1)/");
	}
	return s;
}

/**
 * Models often omit parentheses around a Next.js **route group** folder (`app/admin` vs `app/(admin)`).
 * Try wrapping a single path segment as `(segment)` when that path exists (files or directories).
 * Prefers segments under an `app` directory when present to avoid false positives (e.g. `(work)`).
 */
export function tryAppRouterRouteGroupInsertion(resolvedPath: string): string | null {
	const slash = resolvedPath.replace(/\\/g, "/");
	const parts = slash.split("/").filter((p) => p.length > 0);
	const appIdx = parts.indexOf("app");
	const start = appIdx >= 0 ? appIdx + 1 : 0;
	for (let i = start; i < parts.length; i++) {
		const seg = parts[i]!;
		if (seg.includes("(") || seg.includes(")")) continue;
		if (!/^[a-zA-Z0-9_-]+$/.test(seg)) continue;
		const altParts = [...parts.slice(0, i), `(${seg})`, ...parts.slice(i + 1)];
		const joined = slash.startsWith("/") ? `/${altParts.join("/")}` : altParts.join("/");
		const candidate = normalizePath(joined);
		if (fileExists(candidate)) {
			return candidate;
		}
	}
	return null;
}

export function resolveReadPath(filePath: string, cwd: string): string {
	const resolved = resolveToCwd(filePath, cwd);

	if (fileExists(resolved)) {
		return resolved;
	}

	// Same path with duplicate route-group segment removed (common Gemini path bug)
	const slash = resolved.replace(/\\/g, "/");
	const dedupedSlash = dedupeAppRouterRouteGroupSegment(slash);
	if (dedupedSlash !== slash) {
		const normalizedDeduped = normalizePath(dedupedSlash);
		for (const candidate of [dedupedSlash, normalizedDeduped]) {
			if (candidate !== resolved && fileExists(candidate)) {
				return candidate;
			}
		}
	}

	// `src/app/admin` → `src/app/(admin)` when only the grouped folder exists
	const inserted = tryAppRouterRouteGroupInsertion(slash);
	if (inserted) {
		return inserted;
	}
	if (dedupedSlash !== slash) {
		const insertedDeduped = tryAppRouterRouteGroupInsertion(dedupedSlash);
		if (insertedDeduped) {
			return insertedDeduped;
		}
	}

	// Try macOS AM/PM variant (narrow no-break space before AM/PM)
	const amPmVariant = tryMacOSScreenshotPath(resolved);
	if (amPmVariant !== resolved && fileExists(amPmVariant)) {
		return amPmVariant;
	}

	// Try NFD variant (macOS stores filenames in NFD form)
	const nfdVariant = tryNFDVariant(resolved);
	if (nfdVariant !== resolved && fileExists(nfdVariant)) {
		return nfdVariant;
	}

	// Try curly quote variant (macOS uses U+2019 in screenshot names)
	const curlyVariant = tryCurlyQuoteVariant(resolved);
	if (curlyVariant !== resolved && fileExists(curlyVariant)) {
		return curlyVariant;
	}

	// Try combined NFD + curly quote (for French macOS screenshots like "Capture d'écran")
	const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
	if (nfdCurlyVariant !== resolved && fileExists(nfdCurlyVariant)) {
		return nfdCurlyVariant;
	}

	return resolved;
}
