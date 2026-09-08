/**
 * Deterministic style features from text. No LLM: measurable signals
 * (sentence length, lexical variety, formality proxy) that can weight a style
 * profile.
 */
export interface StyleFeatures {
  avg_sentence_len: number;
  type_token_ratio: number;
  formality: number;
}

const CONTRACTIONS = /\b\w+'(t|s|re|ve|ll|d|m)\b/gi;

export function computeStyleFeatures(text: string): StyleFeatures {
  const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  const total = words.length || 1;
  const unique = new Set(words).size;
  const contractionCount = (text.match(CONTRACTIONS) ?? []).length;

  return {
    avg_sentence_len: round(words.length / (sentences.length || 1)),
    type_token_ratio: round(unique / total),
    // Fewer contractions -> higher formality (bounded 0..1).
    formality: round(1 - Math.min(1, contractionCount / (sentences.length || 1))),
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
