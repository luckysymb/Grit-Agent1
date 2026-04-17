/**
 * Normalizes raw tool-call payloads from Gemini and other providers before
 * per-tool prepareArguments + AJV validation.
 */

import { asRecord } from "../core/tools/flexible-tool-args.js";

function tryParseJsonObject(s: string): Record<string, unknown> | null {
	const t = s.trim();
	if (!t || (!t.startsWith("{") && !t.startsWith("["))) return null;
	try {
		const v = JSON.parse(t) as unknown;
		if (v && typeof v === "object" && !Array.isArray(v)) {
			return v as Record<string, unknown>;
		}
	} catch {
		/* ignore */
	}
	return null;
}

function mergeRecords(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
	return { ...base, ...overlay };
}

/**
 * Unwrap JSON-string roots, nested `arguments` / `args` / `params` / `input`, stringified inner JSON.
 */
export function sanitizeRawToolArguments(_toolName: string, raw: unknown): unknown {
	let v: unknown = raw;

	if (typeof v === "string") {
		const parsed = tryParseJsonObject(v);
		if (parsed) v = parsed;
		else return raw;
	}

	if (!v || typeof v !== "object" || Array.isArray(v)) {
		return v;
	}

	let o = asRecord(v);

	// `arguments`: string JSON | object
	if (typeof o.arguments === "string") {
		const inner = tryParseJsonObject(o.arguments);
		if (inner) {
			o = mergeRecords(inner, o);
		}
		delete o.arguments;
	} else if (o.arguments && typeof o.arguments === "object" && !Array.isArray(o.arguments)) {
		o = mergeRecords(o.arguments as Record<string, unknown>, o);
		delete o.arguments;
	}

	for (const key of ["args", "params", "parameters"] as const) {
		const x = o[key];
		if (x && typeof x === "object" && !Array.isArray(x)) {
			o = mergeRecords(x as Record<string, unknown>, o);
			delete o[key];
		}
	}

	// `input`: string JSON | object (common in Gemini function calling)
	if (typeof o.input === "string") {
		const inner = tryParseJsonObject(o.input);
		if (inner) {
			o = mergeRecords(inner, o);
		}
		delete o.input;
	} else if (o.input && typeof o.input === "object" && !Array.isArray(o.input)) {
		o = mergeRecords(o.input as Record<string, unknown>, o);
		delete o.input;
	}

	return o;
}
