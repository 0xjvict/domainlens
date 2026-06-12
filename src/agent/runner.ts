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

  const MIN_FILE_READS = 5;

  const client = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey,
  });

  const schemaJson = readSchemaJson(projectPath);
  const systemPrompt = buildSystemPrompt(config, existingSkills, schemaJson, MIN_FILE_READS);
  const tools = buildAllTools();
  const toolHandlers = createToolHandlers(config, projectPath);

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: 'Explore this codebase and discover domain concepts.' },
  ];

  let fileReads = 0;
  let accumulatedInputTokens = 0;
  let iterationCount = 0;
  const MAX_ITERATIONS = 100;
  const MAX_CONSECUTIVE_TEXT = 2;
  let consecutiveTextResponses = 0;

  try {
  while (iterationCount < MAX_ITERATIONS) {
    iterationCount++;

    const response = await callWithRetry(() =>
      client.chat.completions.create({ model, messages, tools })
    );

    accumulatedInputTokens += response.usage?.prompt_tokens ?? 0;

    const message = response.choices[0]?.message;
    if (!message) break;

    messages.push({
      role: 'assistant',
      content: message.content,
      tool_calls: message.tool_calls,
    });

    if (!message.tool_calls || message.tool_calls.length === 0) {
      if (fileReads < MIN_FILE_READS && consecutiveTextResponses < MAX_CONSECUTIVE_TEXT) {
        consecutiveTextResponses++;
        messages.push({
          role: 'user',
          content: buildRePrompt(fileReads),
        });
        continue;
      }
      break;
    }

    consecutiveTextResponses = 0;

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
        console.log(`  → finish() — ${concepts.length} concepts`);
        return concepts;
      }

      console.log(`  → ${name} ${JSON.stringify(args)}`);

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
      return await forceSummarize(client, model, messages, tools, fileReads);
    }

    if (fileReads >= agentMaxFiles) {
      console.log(
        `\n⚠ File read limit reached (${fileReads} files read, ~${accumulatedInputTokens.toLocaleString()} tokens accumulated).`
      );
      const shouldContinue = await promptYesNo('Continue reading? [y/N]: ');
      if (!shouldContinue) {
        return await forceSummarize(client, model, messages, tools, fileReads);
      }
      fileReads = 0;
    }
  }

  return await forceSummarize(client, model, messages, tools, fileReads);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n✗ Agent error: ${msg}`);
    console.log('  Attempting to summarize concepts discovered so far...');
    return await forceSummarize(client, model, messages, tools, fileReads);
  }
}

async function callWithRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 4,
  baseDelayMs = 5000
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = (err as { status?: number }).status ?? (err as { statusCode?: number }).statusCode;
      if (status === 429 && attempt < maxRetries) {
        const delay = baseDelayMs * 2 ** attempt;
        console.log(`\n  ⏳ Rate limited (429). Retrying in ${delay / 1000}s... (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error('unreachable');
}

async function forceSummarize(
  client: OpenAI,
  model: string,
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  tools: OpenAI.Chat.ChatCompletionTool[],
  fileReads: number
): Promise<AgentConcept[]> {
  if (fileReads === 0) return [];

  try {
    const summarizeMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      ...messages,
      {
        role: 'user',
        content:
          'You have finished exploring. Now call finish() with all the domain concepts you discovered from the files you read.',
      },
    ];

    const response = await client.chat.completions.create({
      model,
      messages: summarizeMessages,
      tools,
      tool_choice: { type: 'function', function: { name: 'finish' } },
    });

    const message = response.choices[0]?.message;
    if (!message?.tool_calls) return [];

    for (const toolCall of message.tool_calls) {
      if (toolCall.type !== 'function' || toolCall.function.name !== 'finish') continue;
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
      } catch {
        args = {};
      }
      const concepts = parseFinishArgs(args);
      console.log(`  → finish() (forced) — ${concepts.length} concepts`);
      return concepts;
    }
  } catch {
    // forced summarize failed — return empty rather than crash
  }

  return [];
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
  schemaJson: string,
  minFileReads: number
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
1. Use list_directory to understand the project structure, then read actual source code files with read_file — listing directories alone is NOT enough to discover concepts.
2. Use glob_files to find patterns like **/*.php, **/*.py, **/*.ts, **/*.js, **/*.java to locate source files.
3. When you find source files (models, services, controllers, entities), read them with read_file to extract:
   - ORM model definitions, fields, and relationships
   - Business constants and threshold values (e.g. CHURN_DAYS, PREMIUM_THRESHOLD)
   - Enum values and status types
   - Business scopes and query filters
4. For each concept you find, track: its name, a business definition, and the signals (evidence) you found.
5. Only call finish() after you have read at least ${minFileReads} source files and thoroughly explored the codebase.
6. Focus on business meaning, not technical implementation details.
7. DO NOT stop early — keep exploring until you have a solid understanding of the domain.`;
}

function buildRePrompt(fileReads: number): string {
  return `You stopped responding with tool calls, but you have only read ${fileReads} source file(s). You need to read actual source code files to discover domain concepts. Please continue exploring:

- Use list_directory to find directories with source code
- Use glob_files to find source files (*.php, *.py, *.ts, *.js, etc.)
- Use read_file to examine file contents — look for models, constants, enums, business logic
- Only call finish() when you have thoroughly explored the codebase and found all domain concepts`;
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
