import type { AgentRuntime, PluginSettings } from "../types";
import { EmbeddedAgentRuntime, ProviderRegistry } from "./embedded-agent-runtime";
import { AnthropicMessagesProvider } from "./providers/anthropic-messages-provider";
import { OpenAIChatProvider } from "./providers/openai-chat-provider";

export interface AgentRuntimeFactory {
  create(): Promise<AgentRuntime>;
}

export interface AgentSecretReader {
  get(id: string): Promise<string>;
}

export class EmbeddedAgentRuntimeFactory implements AgentRuntimeFactory {
  constructor(
    private readonly secrets: AgentSecretReader,
    private readonly settings: () => PluginSettings,
    private readonly providers = createDefaultProviderRegistry()
  ) {}

  async create(): Promise<AgentRuntime> {
    const settings = this.settings().agent;
    const runtime = new EmbeddedAgentRuntime(this.providers);
    await runtime.initialize({
      provider: {
        protocol: settings.protocol,
        baseUrl: settings.baseUrl,
        token: await this.secrets.get(settings.secretId),
        structuredOutputMode: settings.structuredOutputMode,
        timeoutMs: settings.timeoutMs,
        maxRetries: settings.maxRetries
      },
      models: settings.models
    });
    return runtime;
  }
}

export function createDefaultProviderRegistry(): ProviderRegistry {
  return new ProviderRegistry()
    .register(new OpenAIChatProvider())
    .register(new AnthropicMessagesProvider());
}
