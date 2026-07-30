const UNSUPPORTED_KEYWORDS = new Set([
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minItems",
  "maxItems",
  "pattern",
  "format"
]);

export function compileWireSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const compiled = transformNode(schema) as Record<string, unknown>;
  const operations = (((compiled.properties as Record<string, unknown> | undefined)?.operations as Record<string, unknown> | undefined)?.items) as Record<string, unknown> | undefined;
  const operationProperties = operations?.properties as Record<string, unknown> | undefined;
  if (operationProperties?.expectedHash) {
    operationProperties.expectedHash = {
      anyOf: [operationProperties.expectedHash, { type: "null" }],
      description: "更新操作的当前内容哈希；创建操作使用 null。"
    };
    const required = new Set(Array.isArray(operations?.required) ? operations.required as string[] : []);
    required.add("expectedHash");
    operations!.required = [...required];
  }
  return compiled;
}

export function normalizeStructuredOutput<T = unknown>(value: T): T {
  if (Array.isArray(value)) {
    const normalized: unknown[] = [];
    for (const item of value as unknown[]) normalized.push(normalizeStructuredOutput<unknown>(item));
    return normalized as T;
  }
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "expectedHash" && item === null) continue;
    output[key] = normalizeStructuredOutput(item);
  }
  return output as T;
}

function transformNode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(transformNode);
  if (!value || typeof value !== "object") return value;
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(input)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) continue;
    output[key] = transformNode(item);
  }
  if (output.type === "object") output.additionalProperties = false;
  return output;
}
