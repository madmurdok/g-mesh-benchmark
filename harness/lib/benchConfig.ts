import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Arm, type BuiltinArm } from "./types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_CONFIG_PATH = path.join(ROOT, "g-mesh-bench.config.json");

export type RepetitionPreset = "low" | "normal" | "max";
export type ExcalidrawScopePreset = "low" | "normal" | "high";
export type WarmCacheMode = "prompt" | boolean;

/**
 * One comparison arm backed by an MCP server this repo knows nothing about —
 * the config-file counterpart to the built-in `kungfu` arm (a real MCP server
 * plus a curated tool allowlist and a deny list), registered without touching
 * any source file.
 *
 * Deliberately limited to *bare* arms: there is no CLAUDE.md-loaded
 * (`-configured`) variant of a custom arm, because that path is wired to the
 * literal `gmesh-configured`/`kungfu-configured` arm names in
 * token-economy.ts. Documented as a known gap in README's "Custom arms"
 * section rather than half-supported here.
 */
export interface CustomArmDefinition {
  /** Executable to spawn for this arm's MCP server (`mcpServers.<arm>.command`). Resolved by the OS at spawn time, so a bare name uses PATH. */
  command: string;
  /** Argv for that executable, e.g. `["mcp"]`. Required (write `[]` explicitly) so a server needing no args says so rather than looking half-configured. */
  args: string[];
  /**
   * The arm's `--tools` allow list, `mcp__<arm>__<tool>`-namespaced.
   * `Read,Grep,Glob` are prepended by armConfig.ts's armTools() — every arm
   * gets them, so listing them here would only produce duplicates.
   */
  tools: string[];
  /**
   * `--disallowedTools`. Needed because `--tools` only restricts *built-in*
   * tools and has zero effect on `mcp__`-namespaced ones — see
   * armConfig.ts's KUNGFU_DENIED_TOOLS for the full explanation and how that
   * list was produced. A server exposing more tools than `tools` above must
   * enumerate the rest here, or the model still sees (and can call) them.
   */
  deniedTools?: string[];
  /**
   * True if the tool writes state into the project directory it is pointed at
   * (kungfu's `.kungfu/` index, say — as opposed to g-mesh, which indexes into
   * `~/.g-mesh`). Such an arm gets its own throwaway clone per corpus instead
   * of sharing the warm checkout, which must never be modified. Default false.
   */
  writesToProjectDir?: boolean;
}

export interface BenchConfig {
  /**
   * Extra comparison arms, keyed by arm name — the name is both the arm's
   * identity in `tokenEconomy.arms`/`sessionEconomy.arms`/every report, and
   * the MCP server name its tools are namespaced under (`mcp__<name>__…`).
   * Validated before the two arm lists, which accept these names in addition
   * to the built-in ones.
   */
  customArms: Record<string, CustomArmDefinition>;
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
  customArms: {},
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

/** The built-in arms, spelled out so a typo here is a compile error rather than a config file that silently rejects a real arm. */
const ARM_VALUES: readonly BuiltinArm[] = [
  "gmesh",
  "baseline",
  "gmesh-trusted",
  "kungfu",
  "gmesh-configured",
  "kungfu-configured",
];

const REPETITION_PRESET_VALUES: readonly RepetitionPreset[] = ["low", "normal", "max"];
const EXCALIDRAW_SCOPE_VALUES: readonly ExcalidrawScopePreset[] = ["low", "normal", "high"];

const KNOWN_SECTIONS = ["customArms", "tokenEconomy", "sessionEconomy", "searchLatency", "report", "runClaude"] as const;
const CUSTOM_ARM_FIELDS = ["command", "args", "tools", "deniedTools", "writesToProjectDir"] as const;
/**
 * A custom arm's name doubles as an MCP server name and shows up inside
 * `mcp__<name>__<tool>` in a comma-separated `--tools` list, so anything with
 * whitespace or a comma in it would silently mangle that list rather than fail.
 */
const CUSTOM_ARM_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
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

/**
 * `customArmNames` is the set of already-validated `customArms` keys — which
 * is why customArms is parsed before either arm list (see validateAndMerge):
 * a registered custom arm is as legal here as a built-in one, and an arm in
 * neither is still rejected by name, pointing at both places it could have
 * been declared.
 */
function validateArms(
  value: unknown,
  jsonPath: string,
  configPath: string,
  customArmNames: ReadonlySet<string>,
): Arm[] {
  if (!Array.isArray(value)) {
    invalid(configPath, jsonPath, `must be an array of arm names (got ${JSON.stringify(value)}).`);
  }
  return value.map((v, i) => {
    if (typeof v !== "string" || !(ARM_VALUES.includes(v as BuiltinArm) || customArmNames.has(v))) {
      invalid(
        configPath,
        `${jsonPath}[${i}]`,
        `must be one of ${formatAllowedList(ARM_VALUES)}, or a name registered under "customArms" ` +
          `in this file (got ${JSON.stringify(v)}).`,
      );
    }
    return v as Arm;
  });
}

function validateStringArray(
  value: unknown,
  jsonPath: string,
  configPath: string,
  opts: { allowEmpty: boolean },
): string[] {
  if (!Array.isArray(value)) {
    invalid(configPath, jsonPath, `must be an array of strings (got ${JSON.stringify(value)}).`);
  }
  if (!opts.allowEmpty && value.length === 0) {
    invalid(configPath, jsonPath, "must not be empty.");
  }
  return value.map((v, i) => {
    // Empty strings are the typo this catches: `""` in a tool list would emit
    // a stray comma into `--tools`, and an empty argv entry is never intended.
    if (typeof v !== "string" || v.length === 0) {
      invalid(configPath, `${jsonPath}[${i}]`, `must be a non-empty string (got ${JSON.stringify(v)}).`);
    }
    return v;
  });
}

function validateCustomArm(value: unknown, jsonPath: string, configPath: string): CustomArmDefinition {
  if (!isPlainObject(value)) {
    invalid(configPath, jsonPath, `must be an object (got ${JSON.stringify(value)}).`);
  }
  checkKnownKeys(value, CUSTOM_ARM_FIELDS, jsonPath, configPath);

  if (typeof value.command !== "string" || value.command.length === 0) {
    invalid(configPath, `${jsonPath}.command`, `must be a non-empty string (got ${JSON.stringify(value.command)}).`);
  }
  if (value.args === undefined) {
    invalid(configPath, `${jsonPath}.args`, 'is required (use [] for a server that takes no arguments).');
  }
  if (value.tools === undefined) {
    invalid(configPath, `${jsonPath}.tools`, "is required (the arm's mcp__-namespaced tool allow list).");
  }

  const arm: CustomArmDefinition = {
    command: value.command,
    args: validateStringArray(value.args, `${jsonPath}.args`, configPath, { allowEmpty: true }),
    tools: validateStringArray(value.tools, `${jsonPath}.tools`, configPath, { allowEmpty: false }),
    // Normalized to an explicit boolean rather than left undefined, so every
    // consumer reads one shape (`def.writesToProjectDir` is the whole check).
    writesToProjectDir:
      value.writesToProjectDir !== undefined
        ? validateBoolean(value.writesToProjectDir, `${jsonPath}.writesToProjectDir`, configPath)
        : false,
  };
  // Left absent when absent (rather than normalized to []) so it matches how
  // a built-in arm with no deny list behaves: armDisallowedTools() -> undefined.
  if (value.deniedTools !== undefined) {
    arm.deniedTools = validateStringArray(value.deniedTools, `${jsonPath}.deniedTools`, configPath, {
      allowEmpty: true,
    });
  }
  return arm;
}

function mergeCustomArms(section: unknown, configPath: string): Record<string, CustomArmDefinition> {
  if (section === undefined) return {};
  if (!isPlainObject(section)) invalid(configPath, "customArms", "must be an object keyed by arm name.");
  const arms: Record<string, CustomArmDefinition> = {};
  for (const [name, def] of Object.entries(section)) {
    if (!CUSTOM_ARM_NAME_PATTERN.test(name)) {
      invalid(
        configPath,
        `customArms.${name}`,
        "is not a usable arm name; use letters, digits, dots, dashes or underscores only.",
      );
    }
    // A custom arm named after a built-in would be shadowed by armConfig.ts's
    // ARM_DEFINITIONS and silently never used — reject it instead.
    if (ARM_VALUES.includes(name as BuiltinArm)) {
      invalid(configPath, `customArms.${name}`, "reuses a built-in arm name; pick a different one.");
    }
    arms[name] = validateCustomArm(def, `customArms.${name}`, configPath);
  }
  return arms;
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

function mergeTokenEconomy(
  section: unknown,
  configPath: string,
  customArmNames: ReadonlySet<string>,
): BenchConfig["tokenEconomy"] {
  const base = DEFAULT_CONFIG.tokenEconomy;
  if (section === undefined) return { ...base };
  if (!isPlainObject(section)) invalid(configPath, "tokenEconomy", "must be an object.");
  checkKnownKeys(section, TOKEN_ECONOMY_FIELDS, "tokenEconomy", configPath);
  return {
    arms:
      section.arms !== undefined
        ? validateArms(section.arms, "tokenEconomy.arms", configPath, customArmNames)
        : base.arms,
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

function mergeSessionEconomy(
  section: unknown,
  configPath: string,
  customArmNames: ReadonlySet<string>,
): BenchConfig["sessionEconomy"] {
  const base = DEFAULT_CONFIG.sessionEconomy;
  if (section === undefined) return { ...base };
  if (!isPlainObject(section)) invalid(configPath, "sessionEconomy", "must be an object.");
  checkKnownKeys(section, SESSION_ECONOMY_FIELDS, "sessionEconomy", configPath);
  return {
    arms:
      section.arms !== undefined
        ? validateArms(section.arms, "sessionEconomy.arms", configPath, customArmNames)
        : base.arms,
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
  // Strictly first: both arm lists below accept a custom arm's name, so the
  // set of registered names has to exist (and be validated) before they parse.
  const customArms = mergeCustomArms(parsed.customArms, configPath);
  const customArmNames = new Set(Object.keys(customArms));
  return {
    customArms,
    tokenEconomy: mergeTokenEconomy(parsed.tokenEconomy, configPath, customArmNames),
    sessionEconomy: mergeSessionEconomy(parsed.sessionEconomy, configPath, customArmNames),
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
