import fs from 'node:fs';
import path from 'node:path';
import * as readline from 'node:readline';
import OpenAI from 'openai';
import type { DomainLensConfig, AgentConcept, Signal } from '../types.js';
import { getToolDefinitions, createToolHandlers } from './tools.js';

export interface RunAgentOptions {
  // reserved for future use
}

export async function runAgent(
  config: DomainLensConfig,
  projectPath: string,
  existingSkills: string[],
  _options: RunAgentOptions = {}
): Promise<AgentConcept[]> {
  const apiKey = process.env[config.llm_key_env];
  if (!apiKey) {
    throw new Error(`LLM key not found in environment variable "${config.llm_key_env}"`);
  }

  const model = config.explorer_model ?? config.llm_model;
  const agentMaxFiles = config.agent_max_files ?? 150;
  const agentMaxContextTokens = config.agent_max_context_tokens ?? 100000;

  const client = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey,
  });

  const schemaJson = readSchemaJson(projectPath);
  const systemPrompt = buildSystemPrompt(config, existingSkills, schemaJson);
  const tools = buildAllTools();
  const toolHandlers = createToolHandlers(config, projectPath);

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: 'Explore this codebase and discover domain concepts.' },
  ];

  let fileReads = 0;
  let accumulatedInputTokens = 0;
  const partialConcepts: AgentConcept[] = [];

  while (true) {
    const response = await client.chat.completions.create({
      model,
      messages,
      tools,
    });

    accumulatedInputTokens += response.usage?.prompt_tokens ?? 0;

    const message = response.choices[0]?.message;
    if (!message) break;

    messages.push({
      role: 'assistant',
      content: message.content,
      tool_calls: message.tool_calls,
    });

    if (!message.tool_calls || message.tool_calls.length === 0) {
      break;
    }

    const toolResults: OpenAI.Chat.ChatCompletionToolMessageParam[] = [];

    for (const toolCall of message.tool_calls) {
      if (toolCall.type !== 'function') continue;
      const name = toolCall.function.name;
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
      } catch {
        args = {};
      }

      if (name === 'finish') {
        const concepts = parseFinishArgs(args);
        return concepts;
      }

      if (name === 'read_file') {
        fileReads++;
      }

      const handler = toolHandlers[name];
      const result = handler ? handler(args) : `Error: unknown tool "${name}"`;

      toolResults.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: result,
      });
    }

    messages.push(...toolResults);

    if (accumulatedInputTokens > agentMaxContextTokens) {
      console.log(
        `\n⚠ Context limit exceeded (${accumulatedInputTokens.toLocaleString()} tokens). Stopping exploration.`
      );
      return partialConcepts;
    }

    if (fileReads >= agentMaxFiles) {
      console.log(
        `\n⚠ File read limit reached (${fileReads} files read, ${partialConcepts.length} concepts found so far).`
      );
      const shouldContinue = await promptYesNo('Continue reading? [y/N]: ');
      if (!shouldContinue) {
        return partialConcepts;
      }
      fileReads = 0;
    }
  }

  return partialConcepts;
}

function buildAllTools(): OpenAI.Chat.ChatCompletionTool[] {
  return [
    ...(getToolDefinitions() as unknown as OpenAI.Chat.ChatCompletionTool[]),
    buildFinishTool(),
  ];
}

function buildFinishTool(): OpenAI.Chat.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: 'finish',
      description: 'Complete the codebase exploration and return all discovered domain concepts.',
      parameters: {
        type: 'object',
        properties: {
          concepts: {
            type: 'array',
            description: 'Array of discovered domain concepts',
            items: {
              type: 'object',
              properties: {
                concept: { type: 'string', description: 'Concept name (PascalCase or Title Case)' },
                definition: { type: 'string', description: 'Business definition (2-4 sentences)' },
                signals: {
                  type: 'array',
                  description: 'Evidence signals from the codebase',
                  items: {
                    type: 'object',
                    properties: {
                      type: { type: 'string', description: 'Signal type (e.g. table, model, constant)' },
                      value: { type: 'string', description: 'Signal value or detail' },
                      file: { type: 'string', description: 'Source file path (optional)' },
                    },
                    required: ['type', 'value'],
                  },
                },
              },
              required: ['concept', 'definition', 'signals'],
            },
          },
        },
        required: ['concepts'],
      },
    },
  };
}

function readSchemaJson(projectPath: string): string {
  const schemaPath = path.join(projectPath, '.domainlens', 'schemas', 'latest.json');
  try {
    return fs.readFileSync(schemaPath, 'utf-8');
  } catch {
    return '{}';
  }
}

function buildSystemPrompt(
  config: DomainLensConfig,
  existingSkills: string[],
  schemaJson: string
): string {
  const skillsList =
    existingSkills.length > 0
      ? existingSkills.map((s) => `  - ${s}`).join('\n')
      : '  (none)';

  const codePathsList = config.code_paths.map((p) => `  - ${p}`).join('\n');
  const ignoreList = config.ignore.map((p) => `  - ${p}`).join('\n');

  return `You are a domain concept discovery agent. Your task is to explore this codebase and identify domain concepts — the core business entities, processes, and terminology used in the system.

## Database Schema
${schemaJson}

## Existing Skills (already documented — focus on new or missing concepts)
${skillsList}

## Code Paths to Explore
${codePathsList}

## Ignore List (do not read these paths)
${ignoreList}

## Instructions
1. Use the available tools to explore the codebase systematically.
2. Look for domain concepts in: database tables, ORM models, constants, enums, documentation, and business logic.
3. For each concept, identify: its name, a business definition, and the signals (evidence) you found.
4. When you have finished exploring, call finish() with your complete list of discovered concepts.
5. Focus on business meaning, not technical implementation details.`;
}

function parseFinishArgs(args: Record<string, unknown>): AgentConcept[] {
  const rawConcepts = args['concepts'];
  if (!Array.isArray(rawConcepts)) return [];

  const concepts: AgentConcept[] = [];
  for (const item of rawConcepts) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Record<string, unknown>;

    const concept = typeof obj['concept'] === 'string' ? obj['concept'] : '';
    const definition = typeof obj['definition'] === 'string' ? obj['definition'] : '';
    const rawSignals = Array.isArray(obj['signals']) ? obj['signals'] : [];

    const signals: Signal[] = [];
    for (const sig of rawSignals) {
      if (typeof sig !== 'object' || sig === null) continue;
      const s = sig as Record<string, unknown>;
      const type = typeof s['type'] === 'string' ? s['type'] : 'unknown';
      const value = typeof s['value'] === 'string' ? s['value'] : '';
      const file = typeof s['file'] === 'string' ? s['file'] : undefined;
      signals.push({ type, value, file });
    }

    if (concept) {
      concepts.push({ concept, definition, signals });
    }
  }

  return concepts;
}

async function promptYesNo(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}
