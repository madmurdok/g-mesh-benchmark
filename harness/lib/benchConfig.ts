import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Arm } from "./types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_CONFIG_PATH = path.join(ROOT, "g-mesh-bench.config.json");

export type RepetitionPreset = "low" | "normal" | "max";
export type ExcalidrawScopePreset = "low" | "normal" | "high";
export type WarmCacheMode = "prompt" | boolean;

export interface BenchConfig {
  tokenEconomy: {
    arms: Arm[];
    repetitions: RepetitionPreset;
    excalidrawScope: ExcalidrawScopePreset;
    htmlNarrative: boolean;
    warmCache: WarmCacheMode;
  };
  sessionEconomy: {
    arms: Arm[];
    repetitions: RepetitionPreset;
  };
  searchLatency: {
    samples: number;
  };
  report: {
    htmlNarrative: boolean;
  };
  runClaude: {
    saveTranscripts: boolean;
  };
}

/**
 * The literal ordered default-arm lists, replacing what used to be hardcoded
 * directly in token-economy.ts's/session-economy.ts's main(). Every other
 * field mirrors the literal default each script's own should*()/*Count()
 * helper already fell back to before this file existed — see this task's
 * design notes for how each was verified against the real code.
 */
export const DEFAULT_CONFIG: BenchConfig = {
  tokenEconomy: {
    arms: ["gmesh-configured", "baseline"],
    repetitions: "normal",
    excalidrawScope: "low",
    htmlNarrative: true,
    warmCache: "prompt",
  },
  sessionEconomy: {
    arms: ["gmesh", "baseline"],
    repetitions: "normal",
  },
  searchLatency: {
    samples: 20,
  },
  report: {
    htmlNarrative: true,
  },
  runClaude: {
    saveTranscripts: false,
  },
};

const ARM_VALUES: readonly Arm[] = [
  "gmesh",
  "baseline",
  "gmesh-trusted",
  "kungfu",
  "gmesh-configured",
  "kungfu-configured",
];

const REPETITION_PRESET_VALUES: readonly RepetitionPreset[] = ["low", "normal", "max"];
const EXCALIDRAW_SCOPE_VALUES: readonly ExcalidrawScopePreset[] = ["low", "normal", "high"];

const KNOWN_SECTIONS = ["tokenEconomy", "sessionEconomy", "searchLatency", "report", "runClaude"] as const;
const TOKEN_ECONOMY_FIELDS = ["arms", "repetitions", "excalidrawScope", "htmlNarrative", "warmCache"] as const;
const SESSION_ECONOMY_FIELDS = ["arms", "repetitions"] as const;
const SEARCH_LATENCY_FIELDS = ["samples"] as const;
const REPORT_FIELDS = ["htmlNarrative"] as const;
const RUN_CLAUDE_FIELDS = ["saveTranscripts"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Throws a single, JSON-path-qualified error naming the config file, matching
 * this codebase's existing `Invalid X value "Y"; expected ...` phrasing (see
 * e.g. token-economy.ts's repetitionCount()).
 */
function invalid(configPath: string, jsonPath: string, detail: string): never {
  throw new Error(`Invalid ${path.basename(configPath)}: ${jsonPath} ${detail}`);
}

function formatAllowedList(allowed: readonly string[]): string {
  const quoted = allowed.map((a) => `"${a}"`);
  if (quoted.length === 1) return quoted[0]!;
  return `${quoted.slice(0, -1).join(", ")}, or ${quoted[quoted.length - 1]}`;
}

function checkKnownKeys(section: Record<string, unknown>, known: readonly string[], jsonPathPrefix: string, configPath: string): void {
  for (const key of Object.keys(section)) {
    if (!known.includes(key)) {
      invalid(configPath, `${jsonPathPrefix}.${key}`, "is not a recognized field.");
    }
  }
}

function validateArms(value: unknown, jsonPath: string, configPath: string): Arm[] {
  if (!Array.isArray(value)) {
    invalid(configPath, jsonPath, `must be an array of arm names (got ${JSON.stringify(value)}).`);
  }
  return value.map((v, i) => {
    if (typeof v !== "string" || !ARM_VALUES.includes(v as Arm)) {
      invalid(
        configPath,
        `${jsonPath}[${i}]`,
        `must be one of ${formatAllowedList(ARM_VALUES)} (got ${JSON.stringify(v)}).`,
      );
    }
    return v as Arm;
  });
}

function validateEnum<T extends string>(
  value: unknown,
  jsonPath: string,
  allowed: readonly T[],
  configPath: string,
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    invalid(configPath, jsonPath, `must be ${formatAllowedList(allowed)} (got ${JSON.stringify(value)}).`);
  }
  return value as T;
}

function validateBoolean(value: unknown, jsonPath: string, configPath: string): boolean {
  if (typeof value !== "boolean") {
    invalid(configPath, jsonPath, `must be a boolean (got ${JSON.stringify(value)}).`);
  }
  return value;
}

function validateWarmCache(value: unknown, jsonPath: string, configPath: string): WarmCacheMode {
  if (value === "prompt" || typeof value === "boolean") return value;
  invalid(configPath, jsonPath, `must be true, false, or "prompt" (got ${JSON.stringify(value)}).`);
}

function validatePositiveInt(value: unknown, jsonPath: string, configPath: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    invalid(configPath, jsonPath, `must be a positive integer (got ${JSON.stringify(value)}).`);
  }
  return value;
}

function mergeTokenEconomy(section: unknown, configPath: string): BenchConfig["tokenEconomy"] {
  const base = DEFAULT_CONFIG.tokenEconomy;
  if (section === undefined) return { ...base };
  if (!isPlainObject(section)) invalid(configPath, "tokenEconomy", "must be an object.");
  checkKnownKeys(section, TOKEN_ECONOMY_FIELDS, "tokenEconomy", configPath);
  return {
    arms: section.arms !== undefined ? validateArms(section.arms, "tokenEconomy.arms", configPath) : base.arms,
    repetitions:
      section.repetitions !== undefined
        ? validateEnum(section.repetitions, "tokenEconomy.repetitions", REPETITION_PRESET_VALUES, configPath)
        : base.repetitions,
    excalidrawScope:
      section.excalidrawScope !== undefined
        ? validateEnum(section.excalidrawScope, "tokenEconomy.excalidrawScope", EXCALIDRAW_SCOPE_VALUES, configPath)
        : base.excalidrawScope,
    htmlNarrative:
      section.htmlNarrative !== undefined
        ? validateBoolean(section.htmlNarrative, "tokenEconomy.htmlNarrative", configPath)
        : base.htmlNarrative,
    warmCache:
      section.warmCache !== undefined
        ? validateWarmCache(section.warmCache, "tokenEconomy.warmCache", configPath)
        : base.warmCache,
  };
}

function mergeSessionEconomy(section: unknown, configPath: string): BenchConfig["sessionEconomy"] {
  const base = DEFAULT_CONFIG.sessionEconomy;
  if (section === undefined) return { ...base };
  if (!isPlainObject(section)) invalid(configPath, "sessionEconomy", "must be an object.");
  checkKnownKeys(section, SESSION_ECONOMY_FIELDS, "sessionEconomy", configPath);
  return {
    arms: section.arms !== undefined ? validateArms(section.arms, "sessionEconomy.arms", configPath) : base.arms,
    repetitions:
      section.repetitions !== undefined
        ? validateEnum(section.repetitions, "sessionEconomy.repetitions", REPETITION_PRESET_VALUES, configPath)
        : base.repetitions,
  };
}

function mergeSearchLatency(section: unknown, configPath: string): BenchConfig["searchLatency"] {
  const base = DEFAULT_CONFIG.searchLatency;
  if (section === undefined) return { ...base };
  if (!isPlainObject(section)) invalid(configPath, "searchLatency", "must be an object.");
  checkKnownKeys(section, SEARCH_LATENCY_FIELDS, "searchLatency", configPath);
  return {
    samples:
      section.samples !== undefined
        ? validatePositiveInt(section.samples, "searchLatency.samples", configPath)
        : base.samples,
  };
}

function mergeReport(section: unknown, configPath: string): BenchConfig["report"] {
  const base = DEFAULT_CONFIG.report;
  if (section === undefined) return { ...base };
  if (!isPlainObject(section)) invalid(configPath, "report", "must be an object.");
  checkKnownKeys(section, REPORT_FIELDS, "report", configPath);
  return {
    htmlNarrative:
      section.htmlNarrative !== undefined
        ? validateBoolean(section.htmlNarrative, "report.htmlNarrative", configPath)
        : base.htmlNarrative,
  };
}

function mergeRunClaude(section: unknown, configPath: string): BenchConfig["runClaude"] {
  const base = DEFAULT_CONFIG.runClaude;
  if (section === undefined) return { ...base };
  if (!isPlainObject(section)) invalid(configPath, "runClaude", "must be an object.");
  checkKnownKeys(section, RUN_CLAUDE_FIELDS, "runClaude", configPath);
  return {
    saveTranscripts:
      section.saveTranscripts !== undefined
        ? validateBoolean(section.saveTranscripts, "runClaude.saveTranscripts", configPath)
        : base.saveTranscripts,
  };
}

function validateAndMerge(parsed: unknown, configPath: string): BenchConfig {
  if (!isPlainObject(parsed)) {
    invalid(configPath, "<root>", "must be a JSON object.");
  }
  for (const key of Object.keys(parsed)) {
    if (!(KNOWN_SECTIONS as readonly string[]).includes(key)) {
      invalid(configPath, key, "is not a recognized top-level field.");
    }
  }
  return {
    tokenEconomy: mergeTokenEconomy(parsed.tokenEconomy, configPath),
    sessionEconomy: mergeSessionEconomy(parsed.sessionEconomy, configPath),
    searchLatency: mergeSearchLatency(parsed.searchLatency, configPath),
    report: mergeReport(parsed.report, configPath),
    runClaude: mergeRunClaude(parsed.runClaude, configPath),
  };
}

let cached: BenchConfig | undefined;

/**
 * Loads, validates and caches g-mesh-bench.config.json. A missing file is not
 * an error — every caller must keep working unchanged in a repo that never
 * added one — so this returns DEFAULT_CONFIG verbatim in that case. The
 * `configPath` param exists purely so benchConfig.test.ts can point at a temp
 * fixture without mocking node:fs.
 */
export function loadBenchConfig(configPath: string = DEFAULT_CONFIG_PATH): BenchConfig {
  if (cached !== undefined) return cached;

  if (!existsSync(configPath)) {
    cached = DEFAULT_CONFIG;
    return cached;
  }

  const raw = readFileSync(configPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse ${configPath}: ${(err as Error).message}`);
  }

  cached = validateAndMerge(parsed, configPath);
  return cached;
}

/** Test-only: clears the module cache so a test can load a fresh/mocked file. */
export function resetBenchConfigCache(): void {
  cached = undefined;
}

/**
 * Applies the `shouldInclude*Arm()` env-var toggles on top of a config's base
 * arm list, additively: an arm already present (e.g. because the config file
 * lists it explicitly) is left alone rather than duplicated. Idempotent by
 * construction — calling it twice with the same `toInclude` set changes
 * nothing the second time.
 */
export function applyArmIncludeOverrides(baseArms: readonly Arm[], toInclude: readonly Arm[]): Arm[] {
  const arms = [...baseArms];
  for (const arm of toInclude) {
    if (!arms.includes(arm)) arms.push(arm);
  }
  return arms;
}
