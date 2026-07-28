import type { AgentToolRisk, LlmToolDefinition } from "../types";
import type { EvidenceLedger } from "./evidence-ledger";

export interface ToolResult<T = unknown> {
  output: T;
  summary: string;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  risk: AgentToolRisk;
  parallelSafe: boolean;
}

export interface AgentTool<TInput = any, TOutput = unknown> {
  readonly descriptor: ToolDescriptor;
  execute(input: TInput, context: ToolExecutionContext): Promise<ToolResult<TOutput>>;
}

export interface ToolExecutionContext {
  readonly signal: AbortSignal;
  readonly allowedSourceIds: Set<string>;
  readonly allowAllRaw: boolean;
  readonly allowDiscussion: boolean;
  readonly workingSet: import("./working-set").WorkingSet;
  readonly evidenceLedger: EvidenceLedger;
  readonly requireEvidence: boolean;
  validationCount: number;
  terminal?:
    | { type: "plan"; plan: import("../types").WikiChangePlan }
    | { type: "no_changes"; reason: string; knowledgeGaps: string[] }
    | { type: "waiting_user"; discoveries: string; questions: string[] };
  requestDirection?: (discoveries: string, questions: string[]) => Promise<string>;
  queryState?: QueryToolState;
  queryReadKeys?: Set<string>;
}

export interface QueryToolState {
  indexRevision?: string;
  indexReads: string[];
  wikiReads: Array<{ path: string; hash: string; mode: "section" | "full"; sectionId?: string }>;
  graphTraversals: Array<{ from: string; to: string; hop: number; direction: "outgoing" | "backlink" }>;
  citationStatus: "pending" | "verified" | "degraded";
  citationErrors: string[];
}

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  register(tool: AgentTool): this {
    if (this.tools.has(tool.descriptor.name)) throw new Error(`重复的 Agent Tool：${tool.descriptor.name}`);
    this.tools.set(tool.descriptor.name, tool);
    return this;
  }

  get(name: string): AgentTool {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`未知 Agent Tool：${name}`);
    return tool;
  }

  find(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  definitions(names: Iterable<string>): LlmToolDefinition[] {
    return [...names].map((name) => {
      const descriptor = this.get(name).descriptor;
      return {
        name: descriptor.name,
        description: descriptor.description,
        inputSchema: descriptor.inputSchema,
        // Local schema validation remains authoritative. Compatible providers
        // differ on whether optional tool properties are allowed in strict mode.
        strict: false
      };
    });
  }
}

export class ToolPolicy {
  constructor(private readonly allowedTools: Set<string>) {}

  authorize(tool: AgentTool, context: ToolExecutionContext, input: unknown): void {
    if (!this.allowedTools.has(tool.descriptor.name)) throw new Error(`当前命令不允许 Tool：${tool.descriptor.name}`);
    if (context.terminal) throw new Error("Agent Run 已终止，不能继续调用 Tool");
    if (tool.descriptor.risk === "interaction" && !context.allowDiscussion) {
      throw new Error("当前命令未启用 --discuss");
    }
    const errors = validateSchema(tool.descriptor.inputSchema, input, "input");
    if (errors.length > 0) throw new Error(`Tool ${tool.descriptor.name} 参数无效：${errors.join("；")}`);
  }
}

export function validateSchema(schema: Record<string, any>, value: unknown, path: string): string[] {
  const errors: string[] = [];
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path} 必须为 ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errors.push(`${path} 不在允许值中`);
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [`${path} 必须是对象`];
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in record)) errors.push(`${path}.${key} 为必填项`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in (schema.properties ?? {}))) errors.push(`${path}.${key} 不允许出现`);
      }
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in record) errors.push(...validateSchema(child as Record<string, any>, record[key], `${path}.${key}`));
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) return [`${path} 必须是数组`];
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${path} 项数不足`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(`${path} 项数过多`);
    if (schema.items) value.forEach((item, index) => errors.push(...validateSchema(schema.items, item, `${path}[${index}]`)));
  } else if (schema.type === "string") {
    if (typeof value !== "string") return [`${path} 必须是字符串`];
    if (typeof schema.minLength === "number" && value.length < schema.minLength) errors.push(`${path} 太短`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) errors.push(`${path} 太长`);
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) errors.push(`${path} 格式无效`);
  } else if (schema.type === "integer" && !Number.isInteger(value)) {
    errors.push(`${path} 必须是整数`);
  } else if (schema.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
    errors.push(`${path} 必须是数字`);
  } else if (schema.type === "boolean" && typeof value !== "boolean") {
    errors.push(`${path} 必须是布尔值`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${path} 小于最小值`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${path} 超过最大值`);
  }
  return errors;
}
