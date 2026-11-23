/**
 * A line, cut into the pieces the voice makes one at a time: whole sentences where they're short, else
 * clauses. Short pieces start playing sooner, let a reply in between, and keep each audio result small.
 * Pure (no Node): the plugin and the board both use it, so the board finds the audio made ahead for it.
 */
const COMFORTABLE = 12; // words: ~2 s to make on an M2
const MOST = 13; // nothing longer: whatever is being made is the wait before a reply can be
const FEWEST = 3;
const ABBREVIATION = /(^|\s)(e\.g\.|i\.e\.|etc\.|vs\.|approx\.|Dr\.|Mr\.|Mrs\.|Ms\.|Prof\.|St\.|No\.|Fig\.|[A-Z]\.)$/;
const JOINING = /^(and|but|so|because|which|while|then|or|that)$/i;

const count = (words: string[][]) => words.reduce((n, w) => n + w.length, 0);

/** Cut after words that end a unit, keeping the words themselves untouched. */
function cutAfter(words: string[], ends: (word: string) => boolean): string[][] {
  const out: string[][] = [];
  let unit: string[] = [];
  for (const word of words) {
    unit.push(word);
    if (ends(word)) (out.push(unit), (unit = []));
  }
  if (unit.length) out.push(unit);
  return out;
}

/** Join neighbours while they stay comfortable (or while one is too short to say alone). */
function pack(units: string[][]): string[][] {
  const out: string[][] = [];
  for (const unit of units) {
    const last = out.at(-1);
    const total = last ? count([last, unit]) : Infinity;
    if (last && (total <= COMFORTABLE || ((last.length < FEWEST || unit.length < FEWEST) && total <= MOST))) last.push(...unit);
    else out.push([...unit]);
  }
  return out;
}

/** No punctuation to cut at: before a joining word near the middle, else in the middle. */
function halve(words: string[]): string[][] {
  if (words.length <= MOST) return [words];
  const middle = Math.floor(words.length / 2);
  let at = middle;
  for (let d = 0; d <= middle - FEWEST; d++) {
    const found = [middle - d, middle + d].find((i) => i < words.length && JOINING.test(words[i]));
    if (found !== undefined) {
      at = found;
      break;
    }
  }
  return [...halve(words.slice(0, at)), ...halve(words.slice(at))];
}

export function speechPieces(text: string): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const sentences = cutAfter(words, (w) => /[.!?]["')\]”’]*$/.test(w) && !ABBREVIATION.test(w));
  // A short sentence joins the next only when both are tiny: otherwise the first one can start playing.
  const pieces = sentences.flatMap((s) => (s.length <= COMFORTABLE ? [s] : pack(cutAfter(s, (w) => /[,;:—]$/.test(w))).flatMap(halve)));
  const out: string[][] = [];
  for (const piece of pieces) {
    const last = out.at(-1);
    if (last && (last.length < FEWEST || piece.length < FEWEST) && last.length + piece.length <= MOST) last.push(...piece);
    else out.push([...piece]);
  }
  return out.map((piece) => piece.join(" "));
}

/** The line the board says for a part's check question (here, so the audio made ahead matches). */
export const checkLine = (question: string) => `Quick check: ${question}`;
