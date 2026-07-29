export interface CorpusEntry {
  id: string;
  kind: "local" | "git";
  path?: string;
  repoUrl?: string;
  ref?: string;
  language: "ts" | "js";
}

export interface Oracle {
  mustMentionFiles: string[];
  mustMentionSymbols: string[];
}

export interface BenchTask {
  id: string;
  kind: string;
  target: { symbol: string; file: string };
  prompt: string;
  oracle: Oracle;
}
