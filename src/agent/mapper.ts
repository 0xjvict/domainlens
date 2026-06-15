import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import type { DomainLensConfig } from '../types.js';
import { getToolDefinitions, createToolHandlers } from './tools.js';

const MAPPING_MAX_TOKENS = 2000;
const MAPPING_MAX_ITERATIONS = 5;

export async function buildFileGroups(
  config: DomainLensConfig,
  projectPath: string
): Promise<string[][]> {
  const agentBatchSize = config.agent_batch_size ?? 40;

  try {
    const llmPaths = await attemptLlmMapping(config, projectPath);
    if (llmPaths.length > 0) {
      return partitionIntoGroups(llmPaths, agentBatchSize, projectPath);
    }
  } catch {
    // fall through to walkdir grouping
  }

  return buildFallbackGroups(config, projectPath, agentBatchSize);
}

async function attemptLlmMapping(
  config: DomainLensConfig,
  projectPath: string
): Promise<string[]> {
  const apiKey = process.env[config.llm_key_env];
  if (!apiKey) return [];

  const model = config.explorer_model ?? config.llm_model;

  const client = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey,
  });

  const codePaths = config.code_paths.map((p) => `  - ${p}`).join('\n');
  const ignoreList = config.ignore.map((p) => `  - ${p}`).join('\n');

  const systemPrompt = `You are a codebase mapping agent. Your only job is to explore the directory structure and find all source code files.

## Code Paths to Explore
${codePaths}

## Ignore List
${ignoreList}

## Instructions
1. Use list_directory to explore the directory tree.
2. Use glob_files to find all source files (e.g. **/*.php, **/*.ts, **/*.py, **/*.js, **/*.java).
3. List enough files to understand the module structure — you do NOT need to read any file contents.
4. After you have explored all major directories and collected file paths, stop calling tools.`;

  const mappingTools = buildMappingTools();
  const toolHandlers = createToolHandlers(config, projectPath);

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: 'Map the codebase directory structure and list all source files.' },
  ];

  const filePaths = new Set<string>();
  let iterationCount = 0;

  while (iterationCount < MAPPING_MAX_ITERATIONS) {
    iterationCount++;

    const response = await client.chat.completions.create({
      model,
      messages,
      tools: mappingTools,
      max_tokens: MAPPING_MAX_TOKENS,
    });

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

      if (name === 'read_file' || name === 'search_text' || name === 'read_schema' || name === 'finish') {
        toolResults.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: 'This tool is disabled in mapping mode.',
        });
        continue;
      }

      let args: Record<string, unknown>;
      try {
        args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
      } catch {
        args = {};
      }

      const handler = toolHandlers[name];
      const result = handler ? handler(args) : `Error: unknown tool "${name}"`;

      if (name === 'glob_files') {
        for (const line of result.split('\n')) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('(no files') && !trimmed.startsWith('(empty')) {
            filePaths.add(trimmed);
          }
        }
      }

      toolResults.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: result,
      });
    }

    messages.push(...toolResults);

    // If we have collected paths from all code paths, stop early
    const exploredDirs = getExploredDirs(messages);
    const allCodePathsCovered = config.code_paths.every((cp) =>
      exploredDirs.some((d) => d === cp || d.startsWith(cp + '/') || d.startsWith(cp.replace(/\/$/, '')))
    );
    if (allCodePathsCovered && filePaths.size > 0) {
      break;
    }
  }

  return Array.from(filePaths);
}

function getExploredDirs(
  messages: OpenAI.Chat.ChatCompletionMessageParam[]
): string[] {
  const dirs: string[] = [];
  for (const msg of messages) {
    if (msg.role !== 'tool') continue;
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (content.includes('dir ')) {
      for (const line of content.split('\n')) {
        const match = line.match(/^dir\s+(.+)$/);
        if (match) dirs.push(match[1]);
      }
    }
  }
  return dirs;
}

function buildMappingTools(): OpenAI.Chat.ChatCompletionTool[] {
  const defs = getToolDefinitions();
  return defs
    .filter((t) => t.function.name === 'list_directory' || t.function.name === 'glob_files')
    .map((t) => t as unknown as OpenAI.Chat.ChatCompletionTool);
}

function partitionIntoGroups(
  filePaths: string[],
  batchSize: number,
  projectPath: string
): string[][] {
  const groups = new Map<string, string[]>();

  for (const fp of filePaths) {
    const relative = path.relative(projectPath, path.resolve(projectPath, fp));
    const parts = relative.split(/[/\\]/);
    // Use the first subdirectory of the first code path segment as group key
    const key = parts.length > 1 ? parts.slice(0, 2).join('/') : parts[0];

    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(fp);
  }

  // Split oversized groups into batches
  const result: string[][] = [];
  for (const [, group] of groups) {
    if (group.length <= batchSize) {
      result.push(group);
    } else {
      for (let i = 0; i < group.length; i += batchSize) {
        result.push(group.slice(i, i + batchSize));
      }
    }
  }

  return result;
}

function buildFallbackGroups(
  config: DomainLensConfig,
  projectPath: string,
  batchSize: number
): string[][] {
  const allFiles = collectAllFiles(config, projectPath);
  const groups = new Map<string, string[]>();

  for (const fp of allFiles) {
    const relative = path.relative(projectPath, path.resolve(projectPath, fp));
    const parts = relative.split(/[/\\]/);
    const key = parts.length > 1 ? parts.slice(0, 2).join('/') : parts[0];

    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(fp);
  }

  const result: string[][] = [];
  for (const [, group] of groups) {
    if (group.length <= batchSize) {
      result.push(group);
    } else {
      for (let i = 0; i < group.length; i += batchSize) {
        result.push(group.slice(i, i + batchSize));
      }
    }
  }

  return result;
}

function collectAllFiles(
  config: DomainLensConfig,
  projectPath: string
): string[] {
  const files: string[] = [];

  for (const codePath of config.code_paths) {
    const fullPath = path.resolve(projectPath, codePath);
    if (!fs.existsSync(fullPath)) continue;
    walkCollectFiles(fullPath, config.ignore, projectPath, files);
  }

  return files;
}

function walkCollectFiles(
  dirPath: string,
  ignoreList: string[],
  projectPath: string,
  results: string[]
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const relativePath = path.relative(projectPath, fullPath);

    if (ignoreList.some((ig) => relativePath.startsWith(ig) || entry.name === ig)) continue;

    if (entry.isDirectory()) {
      walkCollectFiles(fullPath, ignoreList, projectPath, results);
    } else if (entry.isFile()) {
      results.push(relativePath);
    }
  }
}
