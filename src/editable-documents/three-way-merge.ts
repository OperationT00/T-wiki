export interface ThreeWayConflict {
  conflictId: string;
  startLine: number;
  endLine: number;
  base: string;
  user: string;
  upstream: string;
}

export interface ThreeWayMergeResult {
  merged: string;
  conflicts: ThreeWayConflict[];
}

interface LineEdit {
  start: number;
  end: number;
  replacement: string[];
  side: "user" | "upstream";
}

interface EditComponent {
  start: number;
  end: number;
  edits: LineEdit[];
}

const MAX_LCS_CELLS = 2_000_000;

/** Deterministic line-based three-way merge. Conflicts are never guessed. */
export function threeWayMerge(baseInput: string, userInput: string, upstreamInput: string): ThreeWayMergeResult {
  const base = lines(baseInput);
  const user = lines(userInput);
  const upstream = lines(upstreamInput);
  if (base.length * Math.max(user.length, upstream.length) > MAX_LCS_CELLS) {
    if (userInput === upstreamInput) return { merged: userInput, conflicts: [] };
    return {
      merged: userInput,
      conflicts: [{
        conflictId: "conflict-0001",
        startLine: 1,
        endLine: Math.max(1, base.length),
        base: baseInput,
        user: userInput,
        upstream: upstreamInput
      }]
    };
  }
  const edits = [
    ...lineEdits(base, user, "user"),
    ...lineEdits(base, upstream, "upstream")
  ];
  const components = connectedComponents(edits);
  const conflicts: ThreeWayConflict[] = [];
  const resolved: Array<{ start: number; end: number; replacement: string[] }> = [];
  for (const component of components) {
    const userEdits = component.edits.filter((edit) => edit.side === "user");
    const upstreamEdits = component.edits.filter((edit) => edit.side === "upstream");
    if (userEdits.length === 0 || upstreamEdits.length === 0) {
      const only = userEdits.length > 0 ? userEdits : upstreamEdits;
      resolved.push({
        start: component.start,
        end: component.end,
        replacement: renderRange(base, component.start, component.end, only)
      });
      continue;
    }
    const userResult = renderRange(base, component.start, component.end, userEdits);
    const upstreamResult = renderRange(base, component.start, component.end, upstreamEdits);
    if (sameLines(userResult, upstreamResult)) {
      resolved.push({ start: component.start, end: component.end, replacement: userResult });
      continue;
    }
    const conflictId = `conflict-${String(conflicts.length + 1).padStart(4, "0")}`;
    conflicts.push({
      conflictId,
      startLine: component.start + 1,
      endLine: Math.max(component.start + 1, component.end),
      base: joinLines(base.slice(component.start, component.end)),
      user: joinLines(userResult),
      upstream: joinLines(upstreamResult)
    });
    // Preview remains faithful to the user's version until an explicit choice
    // is supplied; no conflict marker is written into a managed draft.
    resolved.push({ start: component.start, end: component.end, replacement: userResult });
  }
  return { merged: applyEdits(base, resolved), conflicts };
}

export function resolveThreeWayConflicts(
  preview: ThreeWayMergeResult,
  resolutions: Record<string, "user" | "upstream">
): string {
  let output = preview.merged;
  // Conflicting regions in preview contain the user side. Replace from the
  // end so identical text elsewhere cannot be selected accidentally.
  for (const conflict of [...preview.conflicts].reverse()) {
    const choice = resolutions[conflict.conflictId];
    if (!choice) throw new Error(`尚未处理冲突：${conflict.conflictId}`);
    if (choice === "user") continue;
    const index = output.lastIndexOf(conflict.user);
    if (index < 0) throw new Error(`无法定位冲突区段：${conflict.conflictId}`);
    output = `${output.slice(0, index)}${conflict.upstream}${output.slice(index + conflict.user.length)}`;
  }
  return output;
}

function lineEdits(base: string[], target: string[], side: LineEdit["side"]): LineEdit[] {
  const rows = base.length + 1;
  const columns = target.length + 1;
  const dp = new Uint32Array(rows * columns);
  const at = (i: number, j: number): number => dp[i * columns + j]!;
  for (let i = base.length - 1; i >= 0; i -= 1) {
    for (let j = target.length - 1; j >= 0; j -= 1) {
      dp[i * columns + j] = base[i] === target[j]
        ? at(i + 1, j + 1) + 1
        : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const output: LineEdit[] = [];
  let i = 0;
  let j = 0;
  let active: LineEdit | undefined;
  const flush = (): void => {
    if (active) output.push(active);
    active = undefined;
  };
  while (i < base.length || j < target.length) {
    if (i < base.length && j < target.length && base[i] === target[j]) {
      flush();
      i += 1;
      j += 1;
    } else if (j < target.length && (i === base.length || at(i, j + 1) >= at(i + 1, j))) {
      active ??= { start: i, end: i, replacement: [], side };
      active.replacement.push(target[j]!);
      j += 1;
    } else {
      active ??= { start: i, end: i, replacement: [], side };
      i += 1;
      active.end = i;
    }
  }
  flush();
  return output;
}

function connectedComponents(edits: LineEdit[]): EditComponent[] {
  const sorted = [...edits].sort((left, right) => left.start - right.start || left.end - right.end);
  const components: EditComponent[] = [];
  for (const edit of sorted) {
    const last = components.at(-1);
    if (!last || !touchesComponent(edit, last)) {
      components.push({ start: edit.start, end: edit.end, edits: [edit] });
    } else {
      last.start = Math.min(last.start, edit.start);
      last.end = Math.max(last.end, edit.end);
      last.edits.push(edit);
    }
  }
  return components;
}

function touchesComponent(edit: LineEdit, component: EditComponent): boolean {
  if (edit.start === edit.end && component.start === component.end) return edit.start === component.start;
  if (edit.start === edit.end) return edit.start >= component.start && edit.start <= component.end;
  if (component.start === component.end) return component.start >= edit.start && component.start <= edit.end;
  return edit.start < component.end && edit.end > component.start;
}

function renderRange(base: string[], start: number, end: number, edits: LineEdit[]): string[] {
  const sorted = [...edits].sort((left, right) => left.start - right.start || left.end - right.end);
  const output: string[] = [];
  let cursor = start;
  for (const edit of sorted) {
    output.push(...base.slice(cursor, edit.start), ...edit.replacement);
    cursor = edit.end;
  }
  output.push(...base.slice(cursor, end));
  return output;
}

function applyEdits(base: string[], edits: Array<{ start: number; end: number; replacement: string[] }>): string {
  const output: string[] = [];
  let cursor = 0;
  for (const edit of edits.sort((left, right) => left.start - right.start || left.end - right.end)) {
    output.push(...base.slice(cursor, edit.start), ...edit.replacement);
    cursor = edit.end;
  }
  output.push(...base.slice(cursor));
  return joinLines(output);
}

function lines(value: string): string[] {
  const normalized = value.replace(/\r\n?/g, "\n");
  return normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
}

function joinLines(value: string[]): string {
  return `${value.join("\n")}\n`;
}

function sameLines(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}
