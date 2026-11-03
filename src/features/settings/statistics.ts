export interface Statistics { words: number; characters: number; minutes: number }
export function statistics(text: string): Statistics {
  const words = (text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? []).length;
  return { words, characters: [...text].length, minutes: Math.max(0, Math.ceil(words / 200)) };
}
