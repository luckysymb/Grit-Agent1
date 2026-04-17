interface StdoutTakeoverState {
	rawStdoutWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	rawStderrWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	originalStdoutWrite: typeof process.stdout.write;
}

/** Docker / pipe consumers may close stdout early (e.g. output cap); treat as non-fatal for CLI exit code. */
function isIgnorableStdoutStreamError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const code = String((err as NodeJS.ErrnoException).code ?? "");
	return (
		code === "EPIPE" ||
		code === "ECONNRESET" ||
		code === "ERR_STREAM_WRITE_AFTER_END" ||
		code === "ERR_STREAM_DESTROYED"
	);
}

let stdoutTakeoverState: StdoutTakeoverState | undefined;

export function takeOverStdout(): void {
	if (stdoutTakeoverState) {
		return;
	}

	const rawStdoutWrite = process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
	const rawStderrWrite = process.stderr.write.bind(process.stderr) as StdoutTakeoverState["rawStderrWrite"];
	const originalStdoutWrite = process.stdout.write;

	process.stdout.write = ((
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	): boolean => {
		if (typeof encodingOrCallback === "function") {
			return rawStderrWrite(String(chunk), encodingOrCallback);
		}
		return rawStderrWrite(String(chunk), callback);
	}) as typeof process.stdout.write;

	stdoutTakeoverState = {
		rawStdoutWrite,
		rawStderrWrite,
		originalStdoutWrite,
	};
}

export function restoreStdout(): void {
	if (!stdoutTakeoverState) {
		return;
	}

	process.stdout.write = stdoutTakeoverState.originalStdoutWrite;
	stdoutTakeoverState = undefined;
}

export function isStdoutTakenOver(): boolean {
	return stdoutTakeoverState !== undefined;
}

export function writeRawStdout(text: string): void {
	try {
		if (stdoutTakeoverState) {
			stdoutTakeoverState.rawStdoutWrite(text);
			return;
		}
		process.stdout.write(text);
	} catch (err) {
		if (!isIgnorableStdoutStreamError(err)) throw err;
	}
}

export async function flushRawStdout(): Promise<void> {
	try {
		if (stdoutTakeoverState) {
			await new Promise<void>((resolve, reject) => {
				stdoutTakeoverState?.rawStdoutWrite("", (err) => {
					if (err) reject(err);
					else resolve();
				});
			});
			return;
		}

		await new Promise<void>((resolve, reject) => {
			process.stdout.write("", (err) => {
				if (err) reject(err);
				else resolve();
			});
		});
	} catch (err) {
		if (!isIgnorableStdoutStreamError(err)) throw err;
	}
}
