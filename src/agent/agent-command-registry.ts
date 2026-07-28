export type AgentCommand =
  | { name: "ingest-scan" }
  | { name: "ingest-process"; target: string; discuss: boolean }
  | { name: "ingest-batch"; targets: string[]; discuss: boolean }
  | { name: "ingest-status"; target?: string }
  | { name: "ingest-retry"; target: string }
  | { name: "ingest-rollback"; target?: string }
  | { name: "ingest-delete"; target: string }
  | { name: "query"; question: string; scope: "wiki" | "raw" | "hybrid"; deep: boolean; cite: boolean; confidence: boolean }
  | { name: "save"; content: string; pageType?: "output" | "synthesis"; dryRun: boolean }
  | { name: "lint"; mode: "all" | "quick" | "frontmatter" | "content" | "queue"; fix: boolean }
  | { name: "reindex" }
  | { name: "agent-status" }
  | { name: "agent-cancel" };

export class AgentCommandRegistry {
  parse(input: string): AgentCommand | null {
    const trimmed = input.trim();
    if (!trimmed.startsWith("/")) return null;
    const tokens = tokenize(trimmed);
    const root = tokens.shift()?.toLocaleLowerCase();
    if (root === "/ingest") return parseIngest(tokens);
    if (root === "/query") return parseQuery(tokens);
    if (root === "/save") return parseSave(tokens);
    if (root === "/lint") return parseLint(tokens);
    if (root === "/reindex") {
      if (tokens.length > 0) throw new Error("/reindex 不接受参数");
      return { name: "reindex" };
    }
    if (root === "/agent") {
      const action = tokens[0]?.toLocaleLowerCase();
      if (tokens.length > 1) throw new Error("/agent 只接受 status 或 cancel");
      if (action === "cancel") return { name: "agent-cancel" };
      if (!action || action === "status") return { name: "agent-status" };
      throw new Error(`未知 /agent 子命令：${action}`);
    }
    throw new Error(`未知 LLM Wiki 命令：${root}`);
  }
}

function parseIngest(tokens: string[]): AgentCommand {
  const subcommand = tokens.shift()?.toLocaleLowerCase() ?? "scan";
  const discuss = removeFlag(tokens, "--discuss");
  if (subcommand === "scan") {
    if (tokens.length > 0) throw new Error("/ingest scan 不接受参数");
    return { name: "ingest-scan" };
  }
  if (subcommand === "process") {
    const target = tokens[0];
    if (!target) throw new Error("用法：/ingest process <sourceId|raw-path> [--discuss]");
    if (tokens.length > 1) throw new Error("/ingest process 只接受一个来源");
    return { name: "ingest-process", target, discuss };
  }
  if (subcommand === "batch") {
    if (tokens.length === 0 || tokens.length > 5) throw new Error("batch 需要 1–5 个 sourceId 或 raw-path");
    return { name: "ingest-batch", targets: tokens, discuss };
  }
  if (subcommand === "status") {
    if (tokens.length > 1) throw new Error("/ingest status 最多接受一个来源");
    return { name: "ingest-status", target: tokens[0] };
  }
  if (subcommand === "retry") {
    const target = tokens[0];
    if (!target) throw new Error("用法：/ingest retry <sourceId|raw-path>");
    if (tokens.length > 1) throw new Error("/ingest retry 只接受一个来源");
    return { name: "ingest-retry", target };
  }
  if (subcommand === "rollback") {
    if (discuss) throw new Error("/ingest rollback 不支持 --discuss");
    if (tokens.length > 1) throw new Error("用法：/ingest rollback [sourceId|operationId]");
    return { name: "ingest-rollback", target: tokens[0] };
  }
  if (subcommand === "delete") {
    if (discuss) throw new Error("/ingest delete 不支持 --discuss");
    const target = tokens[0];
    if (!target || tokens.length > 1) throw new Error("用法：/ingest delete <sourceId|raw-path>");
    return { name: "ingest-delete", target };
  }
  throw new Error(`未知 /ingest 子命令：${subcommand}`);
}

function parseQuery(tokens: string[]): AgentCommand {
  const deep = removeFlag(tokens, "--deep");
  removeFlag(tokens, "--cite");
  const cite = true;
  const confidence = removeFlag(tokens, "--confidence");
  const scopeValue = removeOption(tokens, "--scope");
  if (scopeValue && !["raw", "hybrid", "wiki"].includes(scopeValue)) throw new Error("--scope 只允许 wiki、raw 或 hybrid");
  const scope = scopeValue === "raw" || scopeValue === "hybrid" || scopeValue === "wiki"
    ? scopeValue
    : deep ? "hybrid" : "wiki";
  const question = tokens.join(" ").trim();
  if (!question) throw new Error("用法：/query <question> [--deep|--scope wiki|raw|hybrid]");
  return { name: "query", question, scope, deep, cite, confidence };
}

function parseSave(tokens: string[]): AgentCommand {
  const dryRun = removeFlag(tokens, "--dry-run");
  const type = removeOption(tokens, "--type");
  if (type && type !== "output" && type !== "synthesis") throw new Error("--type 只允许 output 或 synthesis");
  return { name: "save", content: tokens.join(" ").trim(), pageType: type as "output" | "synthesis" | undefined, dryRun };
}

function parseLint(tokens: string[]): AgentCommand {
  const fix = removeFlag(tokens, "--fix");
  const flags = ["quick", "frontmatter", "content", "queue"] as const;
  const selected = flags.find((flag) => removeFlag(tokens, `--${flag}`));
  if (tokens.length > 0) throw new Error(`未知 /lint 参数：${tokens.join(" ")}`);
  return { name: "lint", mode: selected ?? "all", fix };
}

function removeFlag(tokens: string[], flag: string): boolean {
  const index = tokens.indexOf(flag);
  if (index < 0) return false;
  tokens.splice(index, 1);
  return true;
}

function removeOption(tokens: string[], option: string): string | undefined {
  const index = tokens.indexOf(option);
  if (index < 0) return undefined;
  const value = tokens[index + 1];
  if (!value) throw new Error(`${option} 缺少值`);
  tokens.splice(index, 2);
  return value;
}

function tokenize(input: string): string[] {
  const values: string[] = [];
  for (const match of input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    values.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return values;
}
