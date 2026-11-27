import type { DeliveryMetrics, DeliveryPause } from "./contract.ts";

/** Deepgram's documented filler spellings (nova family, English only,
 *  developers.deepgram.com/docs/filler-words). Matched case-insensitively
 *  against the plain `word` field, which is lowercased without punctuation. */
export const FILLER_WORDS = ["uh", "um", "mhmm", "mm-mm", "uh-uh", "uh-huh", "nuh-uh"] as const;

const FILLER_SET = new Set<string>(FILLER_WORDS.map(filler => filler.toLowerCase()));

export type DictatedWordLike = {
	readonly word: string;
	readonly start: number;
	readonly end: number;
};

/** Rate = count / (last word end − first word start) in minutes. A single
 *  word measures its own span (start to end); an empty input, or a span that
 *  is zero, negative or non-finite, has no measurable speaking time, so the
 *  rates are 0 rather than infinite. */
export function computeDeliveryMetrics(words: readonly DictatedWordLike[], pauseThresholdSeconds: number): DeliveryMetrics {
	if (words.length === 0) return { fillersPerMin: 0, wordsPerMin: 0, pauses: [] };
	const first = words[0]!;
	const last = words[words.length - 1]!;
	const speakingSeconds = last.end - first.start;
	const usable = Number.isFinite(speakingSeconds) && speakingSeconds > 0;
	const minutes = speakingSeconds / 60;
	const fillers = words.filter(word => FILLER_SET.has(word.word.toLowerCase())).length;
	const pauses: DeliveryPause[] = [];
	for (let i = 0; i + 1 < words.length; i++) {
		const current = words[i]!;
		const gap = words[i + 1]!.start - current.end;
		if (Number.isFinite(gap) && gap >= pauseThresholdSeconds) {
			pauses.push({ afterWord: current.word, seconds: gap });
		}
	}
	return {
		fillersPerMin: usable ? fillers / minutes : 0,
		wordsPerMin: usable ? words.length / minutes : 0,
		pauses,
	};
}

/** Filler words are documented for nova-family English only. Multilingual
 *  mode is excluded deliberately: its supported language set differs. */
export function isEnglishDictationLanguage(language: string): boolean {
	return language === "en" || language.startsWith("en-");
}

export function formatRate(rate: number): string {
	return `${Math.round(rate * 10) / 10}/min`;
}

export function formatPause(pause: DeliveryPause): string {
	return `${Math.round(pause.seconds * 10) / 10}s after "${pause.afterWord}"`;
}
