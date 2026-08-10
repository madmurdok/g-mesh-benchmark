import type { Oracle } from "./types.js";
import { judgeAnswer } from "./judge.js";

export interface OracleCheckResult {
  passed: boolean;
  missed: string[];
  reason?: string;
  /**
   * judge mode only: what the grading call itself cost. Reported so the caller
   * can bound and record it; it is grading infrastructure and must never be
   * folded into the graded arm's own cost/token numbers.
   */
  judgeCostUsd?: number;
}

function checkSubstring(resultText: string, oracle: Oracle): OracleCheckResult {
  const missed = [...(oracle.mustMentionFiles ?? []), ...(oracle.mustMentionSymbols ?? [])].filter(
    (expected) => !resultText.includes(expected),
  );
  return { passed: missed.length === 0, missed };
}

/**
 * How far (in characters) either side of a candidate mention to look for a
 * negation cue. Sized off a real observed failure (transcript
 * 610bd3a2-21fc-449a-8c3f-56b433c6c88b): a model named a candidate file only
 * to explicitly rule it out — "В `src/domain/status.ts` ... но это другой,
 * одноимённый хелпер, а не вызовы этой функции" — with the negation ~100
 * chars past the mention. Deliberately generous rather than tight, since a
 * missed negation (false pass) is the known failure mode this guard exists
 * to catch; a stray negation word from a neighboring clause causing a false
 * "missed" is the accepted trade-off (see oracleCheck.test.ts).
 */
const NEGATION_CONTEXT_CHARS = 150;

/**
 * Single-token negation markers, checked by exact token match (not
 * substring) so words like "notable" or "cannot" don't false-positive.
 * English and Russian both show up in real resultTexts — this harness's own
 * task/prompt/answer text is English, but gmesh-trusted runs answer in
 * whatever language the model defaults to, which in practice is often
 * Russian (see the transcript above). No other language has shown up in
 * sampled real runs; extend this set if that changes.
 */
const NEGATION_WORDS = new Set([
  "not",
  "isn't",
  "doesn't",
  "aren't",
  "wasn't",
  "weren't",
  "didn't",
  "won't",
  "не", // Russian negation particle ("не является", "а не", ...)
]);

/** Multi-word negation cues, checked as plain substrings — low false-positive risk since they're not single common words. */
const NEGATION_PHRASES = ["rather than", "instead of", "excluding", "except"];

function hasNegationCue(text: string): boolean {
  const lower = text.toLowerCase();
  if (NEGATION_PHRASES.some((phrase) => lower.includes(phrase))) {
    return true;
  }
  const tokens = lower.split(/[^a-zа-яё']+/i).filter(Boolean);
  return tokens.some((token) => NEGATION_WORDS.has(token));
}

function findAllIndices(text: string, needle: string): number[] {
  const indices: number[] = [];
  let idx = text.indexOf(needle);
  while (idx !== -1) {
    indices.push(idx);
    idx = text.indexOf(needle, idx + needle.length);
  }
  return indices;
}

/**
 * A sentence-ending punctuation mark is a '.', '!' or '?' immediately
 * followed by whitespace (or end of string) — deliberately *not* every '.',
 * so this can't mistake a file extension's period for a sentence break: in
 * "status.ts", the period is followed by "t" (a letter), never whitespace,
 * so it's invisible to this check regardless of whether the path is
 * backtick-quoted. Only a period that actually ends a clause (whitespace
 * right after it) counts.
 */
function isSentenceBoundaryChar(text: string, i: number): boolean {
  const ch = text[i];
  if (ch !== "." && ch !== "!" && ch !== "?") return false;
  const next = text[i + 1];
  return next === undefined || /\s/.test(next);
}

/** Nearest sentence-boundary position at or before `idx`, no earlier than `from`; `from` itself if none found. */
function findSentenceStart(text: string, from: number, idx: number): number {
  for (let i = idx - 1; i >= from; i--) {
    if (isSentenceBoundaryChar(text, i)) return i + 1;
  }
  return from;
}

/** Nearest sentence-boundary position at or after `idx`, no later than `to`; `to` itself if none found. */
function findSentenceEnd(text: string, idx: number, to: number): number {
  for (let i = idx; i < to; i++) {
    if (isSentenceBoundaryChar(text, i)) return i + 1;
  }
  return to;
}

/**
 * A candidate substring match is only real evidence if the model is
 * asserting it, not naming it to deny it — see the module-level comment on
 * NEGATION_CONTEXT_CHARS for the failure this catches. Windowed (not
 * sentence-split up front) deliberately: candidates are file paths
 * containing '.', so blindly splitting resultText into sentences before
 * searching would risk breaking mid filename. Instead the window is
 * *clamped* to the nearest real sentence boundary (see
 * isSentenceBoundaryChar) found by scanning outward from the candidate
 * mention itself, which is safe the other way around: a stray extension
 * period is simply never recognized as a boundary.
 *
 * That sentence clamp exists on top of the line clamp below to catch a
 * real gmesh-configured false positive (task
 * ex-multihop-mutateelement-sizehelper-transitive): "The helper is
 * `getSizeFromPoints`, defined in `packages/common/src/points.ts`.
 * Excluding that file and `packages/element/src/mutateElement.ts`, the
 * other callers are: ...". "Excluding" sits on the *same line* as
 * `getSizeFromPoints` (well within NEGATION_CONTEXT_CHARS), so the old
 * line-only window saw it and wrongly negated the candidate — but
 * "Excluding" is in the *next sentence*, modifying "that file [and
 * mutateElement.ts]", not `getSizeFromPoints`. Clamping to the sentence
 * containing the mention keeps that separate clause out of the window
 * without needing to understand what "Excluding" actually modifies.
 *
 * The window never crosses a newline on either side, in addition to the
 * NEGATION_CONTEXT_CHARS cap — found necessary from two real kungfu
 * false-negatives (g-mesh-bench task #58): on multi-line/bulleted markdown
 * answers, a negation about a *different* file in an adjacent bullet or
 * aside can land within 150 plain chars of a real, affirmed mention purely
 * by document layout (one case triggered at a 20-char distance — closer
 * than the original calibration case's ~100 chars needed, so shrinking
 * NEGATION_CONTEXT_CHARS alone can't separate true from false positives;
 * the two ranges overlap). Scoping to the current line leaves both existing
 * calibration tests unaffected, since real captured negations so far are
 * single-paragraph prose with no newlines at all — same behavior there,
 * narrower only where line structure exists. The sentence clamp is the same
 * kind of narrowing: real captured negations so far sit in the same
 * sentence as the candidate they negate, so this is narrower only where a
 * sentence break actually exists between the mention and a nearby cue.
 */
function isEveryMentionNegated(resultText: string, candidate: string, indices: number[]): boolean {
  return indices.every((idx) => {
    const mentionEnd = idx + candidate.length;
    const lineStart = resultText.lastIndexOf("\n", idx) + 1; // -1 (no newline before) + 1 = 0
    const lineEndSearch = resultText.indexOf("\n", mentionEnd);
    const lineEnd = lineEndSearch === -1 ? resultText.length : lineEndSearch;
    const sentenceStart = findSentenceStart(resultText, lineStart, idx);
    const sentenceEnd = findSentenceEnd(resultText, mentionEnd, lineEnd);
    const start = Math.max(sentenceStart, idx - NEGATION_CONTEXT_CHARS);
    const end = Math.min(sentenceEnd, mentionEnd + NEGATION_CONTEXT_CHARS);
    return hasNegationCue(resultText.slice(start, end));
  });
}

/**
 * Grades on plain substring presence like checkSubstring, plus a negation
 * guard: a candidate that's only ever mentioned to be explicitly ruled out
 * (a real gmesh-trusted failure — it named a decoy file while denying it
 * was a caller, and the old bare-substring check still scored it a hit)
 * doesn't count as matched. This stays a cheap heuristic rather than an LLM
 * judge call on purpose — it's imperfect (see NEGATION_CONTEXT_CHARS), but
 * pool tasks with a small minMatches/pool ratio and a "watch out for a
 * similarly-named decoy" prompt shape are common enough across corpora to
 * be worth guarding cheaply rather than moving to judge mode wholesale.
 */
function checkPool(resultText: string, oracle: Oracle): OracleCheckResult {
  const pool = oracle.candidatePool ?? [];
  const minMatches = oracle.minMatches ?? pool.length;
  const missed = pool.filter((candidate) => {
    const indices = findAllIndices(resultText, candidate);
    return indices.length === 0 || isEveryMentionNegated(resultText, candidate, indices);
  });
  const hits = pool.length - missed.length;
  return { passed: hits >= minMatches, missed };
}

async function checkJudge(resultText: string, oracle: Oracle): Promise<OracleCheckResult> {
  if (!oracle.rubric) {
    return { passed: false, missed: [], reason: 'judge mode requires oracle.rubric', judgeCostUsd: 0 };
  }
  const verdict = await judgeAnswer(resultText, oracle.rubric);
  return { passed: verdict.passed, missed: [], reason: verdict.reason, judgeCostUsd: verdict.costUsd };
}

/**
 * Dispatches on oracle.mode: "substring" (default, v1 behavior — every
 * existing corpora/*.json entry omits `mode` and keeps grading identically),
 * "pool" (count candidatePool hits, pass at minMatches), or "judge"
 * (delegate to lib/judge.ts). Async because the judge path makes a real API
 * call; the other two modes resolve synchronously but share this signature.
 */
export async function checkOracle(resultText: string, oracle: Oracle): Promise<OracleCheckResult> {
  const mode = oracle.mode ?? "substring";
  switch (mode) {
    case "substring":
      return checkSubstring(resultText, oracle);
    case "pool":
      return checkPool(resultText, oracle);
    case "judge":
      return checkJudge(resultText, oracle);
    case "test":
      // Unreachable by construction: token-economy.ts's runArm() routes
      // test-mode oracles to lib/testRunner.ts before it ever gets here,
      // because grading them needs the run's cwd (which this function has no
      // access to) and ignores resultText entirely. Throwing rather than
      // silently returning `passed: false` so a future caller that forgets the
      // branch fails loudly instead of scoring every run as a miss.
      throw new Error(
        'Oracle mode "test" is graded by lib/testRunner.ts against the run cwd, not by checkOracle().',
      );
  }
}
