export function stripUnsafeControlCharacters(input: string): string {
  return [...input].filter((character) => {
    const code = character.charCodeAt(0);
    return !(code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127);
  }).join("");
}

export function replaceUnsafeFilenameCharacters(input: string, replacement = "-"): string {
  return [...input].map((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || '<>:"/\\|?*'.includes(character) ? replacement : character;
  }).join("");
}
