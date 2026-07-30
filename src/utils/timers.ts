export type AppTimer = number;

/** Prefer the Obsidian window timer while retaining Node-based test support. */
export function setAppTimeout(callback: () => void, delayMs: number): AppTimer {
  return window.setTimeout(callback, delayMs);
}

export function clearAppTimeout(timer: AppTimer): void {
  window.clearTimeout(timer);
}
