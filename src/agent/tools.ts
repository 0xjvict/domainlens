import fs from 'node:fs';
import path from 'node:path';
import type { DomainLensConfig } from '../types.js';

interface ToolParameter {
  type: string;
  description: string;
}

interface ToolFunction {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParameter>;
    required?: string[];
  };
}

export interface ToolDefinition {
  type: 'function';
  function: ToolFunction;
}

export function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: 'list_directory',
        description: 'List immediate children (files and subdirectories) of a directory within the project',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Directory path relative to project root',
            },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'glob_files',
        description: 'Find files matching a glob pattern within code_paths. Supports * (any chars in segment) and ** (any path segments).',
        parameters: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
              description: 'Glob pattern relative to project root (e.g. src/**/*.ts)',
            },
          },
          required: ['pattern'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read up to 500 lines from a file. Use offset to paginate through large files.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'File path relative to project root',
            },
            offset: {
              type: 'number',
              description: 'Number of lines to skip before reading (for pagination)',
            },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_text',
        description: 'Search for a text string across files in code_paths (or a specific path). Returns file:line matches.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Text string to search for (case-insensitive)',
            },
            path: {
              type: 'string',
              description: 'Optional: restrict search to this file or directory (relative to project root)',
            },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_schema',
        description: 'Read the current database schema from .domainlens/schemas/latest.json',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
    },
  ];
}

type ToolArgs = Record<string, unknown>;
type ToolHandler = (args: ToolArgs) => string;

export function createToolHandlers(
  config: DomainLensConfig,
  projectPath: string
): Record<string, ToolHandler> {
  return {
    list_directory: (args) =>
      listDirectory(String(args['path'] ?? ''), config, projectPath),
    glob_files: (args) =>
      globFiles(String(args['pattern'] ?? ''), config, projectPath),
    read_file: (args) =>
      readFile(
        String(args['path'] ?? ''),
        args['offset'] !== undefined ? Number(args['offset']) : undefined,
        projectPath
      ),
    search_text: (args) =>
      searchText(
        String(args['query'] ?? ''),
        args['path'] !== undefined ? String(args['path']) : undefined,
        config,
        projectPath
      ),
    read_schema: () => readSchema(projectPath),
  };
}

function isIgnored(relativePath: string, name: string, ignoreList: string[]): boolean {
  return ignoreList.some((ig) => relativePath.startsWith(ig) || name === ig);
}

function listDirectory(dirPath: string, config: DomainLensConfig, projectPath: string): string {
  const fullPath = path.resolve(projectPath, dirPath);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(fullPath, { withFileTypes: true });
  } catch {
    return `Error: could not read directory "${dirPath}"`;
  }

  const results: string[] = [];
  for (const entry of entries) {
    const entryRelative = path.relative(projectPath, path.join(fullPath, entry.name));
    if (isIgnored(entryRelative, entry.name, config.ignore)) continue;
    const kind = entry.isDirectory() ? 'dir ' : 'file';
    results.push(`${kind}  ${entry.name}`);
  }

  return results.length > 0 ? results.join('\n') : '(empty directory)';
}

function globToRegex(pattern: string): RegExp {
  // Escape regex special chars (but not * or ?)
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // Handle ** (zero or more path segments including their separators)
  const regexStr = escaped
    .replace(/\*\*\//g, '(?:.+/)?') // **/ at beginning/middle → optional segment prefix
    .replace(/\/\*\*/g, '(?:/.+)?') // /** at end → optional segment suffix
    .replace(/\*\*/g, '.*')         // standalone ** → any chars
    .replace(/\*/g, '[^/]*')        // single * → any chars in one segment
    .replace(/\?/g, '[^/]');        // ? → any single char in one segment
  return new RegExp(`^${regexStr}$`);
}

function globFiles(pattern: string, config: DomainLensConfig, projectPath: string): string {
  const regex = globToRegex(pattern);
  const matches: string[] = [];

  for (const codePath of config.code_paths) {
    const fullPath = path.resolve(projectPath, codePath);
    if (!fs.existsSync(fullPath)) continue;
    walkForGlob(fullPath, config.ignore, projectPath, regex, matches);
  }

  return matches.length > 0 ? matches.join('\n') : '(no files matched)';
}

function walkForGlob(
  dirPath: string,
  ignoreList: string[],
  projectPath: string,
  regex: RegExp,
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

    if (isIgnored(relativePath, entry.name, ignoreList)) continue;

    if (entry.isDirectory()) {
      walkForGlob(fullPath, ignoreList, projectPath, regex, results);
    } else if (entry.isFile() && regex.test(relativePath)) {
      results.push(relativePath);
    }
  }
}

const MAX_READ_LINES = 500;

function readFile(filePath: string, offset: number | undefined, projectPath: string): string {
  const fullPath = path.resolve(projectPath, filePath);
  let content: string;
  try {
    content = fs.readFileSync(fullPath, 'utf-8');
  } catch {
    return `Error: could not read file "${filePath}"`;
  }

  if (content.includes('\x00')) {
    return 'Error: binary file, cannot read as text';
  }

  const lines = content.split('\n');
  const totalLines = lines.length;
  const start = offset ?? 0;
  const end = Math.min(start + MAX_READ_LINES, totalLines);
  const slice = lines.slice(start, end);

  const header = `[File: ${filePath} | Lines ${start + 1}–${end} of ${totalLines}]\n`;
  return header + slice.join('\n');
}

const MAX_SEARCH_RESULTS = 100;

function searchText(
  query: string,
  searchPath: string | undefined,
  config: DomainLensConfig,
  projectPath: string
): string {
  const results: string[] = [];

  if (searchPath !== undefined) {
    const fullPath = path.resolve(projectPath, searchPath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      return `Error: path "${searchPath}" not found`;
    }
    if (stat.isDirectory()) {
      walkForSearch(fullPath, config.ignore, projectPath, query, results);
    } else {
      searchInFile(fullPath, projectPath, query, results);
    }
  } else {
    for (const codePath of config.code_paths) {
      if (results.length >= MAX_SEARCH_RESULTS) break;
      const fullPath = path.resolve(projectPath, codePath);
      if (fs.existsSync(fullPath)) {
        walkForSearch(fullPath, config.ignore, projectPath, query, results);
      }
    }
  }

  return results.length > 0 ? results.join('\n') : '(no matches found)';
}

function walkForSearch(
  dirPath: string,
  ignoreList: string[],
  projectPath: string,
  query: string,
  results: string[]
): void {
  if (results.length >= MAX_SEARCH_RESULTS) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= MAX_SEARCH_RESULTS) break;

    const fullPath = path.join(dirPath, entry.name);
    const relativePath = path.relative(projectPath, fullPath);

    if (isIgnored(relativePath, entry.name, ignoreList)) continue;

    if (entry.isDirectory()) {
      walkForSearch(fullPath, ignoreList, projectPath, query, results);
    } else if (entry.isFile()) {
      searchInFile(fullPath, projectPath, query, results);
    }
  }
}

function searchInFile(
  filePath: string,
  projectPath: string,
  query: string,
  results: string[]
): void {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return;
  }

  if (content.includes('\x00')) return;

  const relativeFile = path.relative(projectPath, filePath);
  const lines = content.split('\n');
  const lowerQuery = query.toLowerCase();

  for (let i = 0; i < lines.length && results.length < MAX_SEARCH_RESULTS; i++) {
    if (lines[i].toLowerCase().includes(lowerQuery)) {
      results.push(`${relativeFile}:${i + 1}: ${lines[i].trim()}`);
    }
  }
}

function readSchema(projectPath: string): string {
  const schemaPath = path.join(projectPath, '.domainlens', 'schemas', 'latest.json');
  try {
    return fs.readFileSync(schemaPath, 'utf-8');
  } catch {
    return '{}';
  }
}
