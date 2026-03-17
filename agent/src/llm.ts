const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "anthropic/claude-sonnet-4";

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

export interface ChatOptions {
  model?: string;
  tools?: ToolDefinition[];
  temperature?: number;
  max_tokens?: number;
}

export interface ChatResponse {
  content: string | null;
  tool_calls: ToolCall[];
  finish_reason: string;
}

export async function chat(
  apiKey: string,
  messages: Message[],
  options: ChatOptions = {}
): Promise<ChatResponse> {
  const body: Record<string, any> = {
    model: options.model ?? DEFAULT_MODEL,
    messages: messages.map((m) => {
      const msg: Record<string, any> = { role: m.role, content: m.content };
      if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
      if (m.tool_calls) msg.tool_calls = m.tool_calls;
      return msg;
    }),
    temperature: options.temperature ?? 0.2,
    max_tokens: options.max_tokens ?? 4096,
  };

  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools;
    body.tool_choice = "auto";
  }

  const res = await fetch(OPENROUTER_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/ratimics/agent",
      "X-Title": "RATiMICS Agent",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`OpenRouter API ${res.status}: ${errBody}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0];

  if (!choice) {
    throw new Error(`OpenRouter returned no choices: ${JSON.stringify(data)}`);
  }

  return {
    content: choice.message?.content ?? null,
    tool_calls: choice.message?.tool_calls ?? [],
    finish_reason: choice.finish_reason ?? "stop",
  };
}
