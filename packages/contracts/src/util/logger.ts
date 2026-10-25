import { redact, redactString } from "./redact";

// Structured JSON logger with secret redaction and request/turn ids (spec 18.3 item 10).
// Every field passes through `redact` before it is written.

export type LogLevel = "debug" | "info" | "warn" | "error";
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Bind fields such as `turnId`, `requestId`, `conversationId` to every subsequent line. */
  child(bindings: LogFields): Logger;
}

export type LogSink = (line: string) => void;

export function createLogger(opts: { level?: LogLevel; bindings?: LogFields; sink?: LogSink } = {}): Logger {
  const level = opts.level ?? "info";
  const sink: LogSink = opts.sink ?? ((line) => process.stdout.write(`${line}\n`));
  const bindings = opts.bindings ?? {};

  const write = (lvl: LogLevel, msg: string, fields?: LogFields) => {
    if (LEVEL_ORDER[lvl] < LEVEL_ORDER[level]) return;
    const record = redact({
      level: lvl,
      time: new Date().toISOString(),
      msg: redactString(msg),
      ...bindings,
      ...fields,
    });
    sink(JSON.stringify(record));
  };

  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    child: (b) => createLogger({ level, sink, bindings: { ...bindings, ...b } }),
  };
}

/** Collects lines in memory; used by tests (e.g. the "no secrets in logs" acceptance test). */
export function createMemoryLogger(level: LogLevel = "debug"): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return { logger: createLogger({ level, sink: (l) => lines.push(l) }), lines };
}

export const silentLogger: Logger = createLogger({ sink: () => {} });
