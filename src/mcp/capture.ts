import util from "node:util";

type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug";
const CONSOLE_METHODS: ConsoleMethod[] = ["log", "info", "warn", "error", "debug"];

/**
 * Permanently re-point console.log/info/warn/error/debug to stderr.
 * Called once at server startup, BEFORE the transport connects, so stray logs
 * from any module can never corrupt the stdout JSON-RPC channel.
 */
export function redirectConsoleToStderr(): void {
  for (const method of CONSOLE_METHODS) {
    console[method] = (...args: unknown[]): void => {
      process.stderr.write(util.format(...args) + "\n");
    };
  }
}

export type CapturedRun<T> =
  | { ok: true; value: T; output: string }
  | { ok: false; error: unknown; output: string };

// Module-level promise chain (simple mutex): serialize captures so two
// concurrent tool calls cannot interleave their buffers. Each capture awaits
// the previous one before patching the global sinks.
let captureChain: Promise<void> = Promise.resolve();

type StdoutWrite = typeof process.stdout.write;

/**
 * Run `fn` with console.log/info/warn/error/debug AND process.stdout.write
 * buffered into a string. Always restores the previous sinks in a finally
 * block. Never throws — failures are returned as { ok: false } with whatever
 * output was captured before the error.
 */
export async function captureCommandOutput<T>(
  fn: () => Promise<T>,
): Promise<CapturedRun<T>> {
  // Wait for any in-flight capture to finish before we patch the globals.
  const previous = captureChain;
  let release!: () => void;
  captureChain = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous.catch(() => {});

  let buffer = "";
  const append = (...args: unknown[]): void => {
    buffer += util.format(...args) + "\n";
  };

  const savedConsole: Record<ConsoleMethod, (...args: unknown[]) => void> = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };
  const savedStdoutWrite: StdoutWrite = process.stdout.write;

  for (const method of CONSOLE_METHODS) {
    console[method] = append;
  }
  // Belt-and-braces: commands only use console.* today, but Playwright or
  // transitive deps may write directly to stdout, which is the JSON-RPC channel.
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  }) as StdoutWrite;

  try {
    const value = await fn();
    return { ok: true, value, output: buffer };
  } catch (error) {
    return { ok: false, error, output: buffer };
  } finally {
    for (const method of CONSOLE_METHODS) {
      console[method] = savedConsole[method];
    }
    process.stdout.write = savedStdoutWrite;
    release();
  }
}
