import fs from 'node:fs';
import path from 'node:path';
import type { DomainLensConfig } from '../types.js';

export function buildFileGroups(
  config: DomainLensConfig,
  projectPath: string
): string[][] {
  const agentBatchSize = config.agent_batch_size ?? 40;
  const allFiles = collectAllFiles(config, projectPath);
  return partitionIntoGroups(allFiles, agentBatchSize, projectPath, config.code_paths);
}

function computeGroupKey(relativePath: string, codePaths: string[]): string {
  for (const cp of codePaths) {
    const normalizedCp = cp.replace(/\/$/, '');
    if (!relativePath.startsWith(normalizedCp + '/') && relativePath !== normalizedCp) continue;

    const remainder = relativePath.slice(normalizedCp.length + (relativePath === normalizedCp ? 0 : 1));
    if (!remainder || !remainder.includes('/')) {
      return normalizedCp;
    }
    const firstSegment = remainder.split('/')[0];
    return normalizedCp + '/' + firstSegment;
  }

  const parts = relativePath.split(/[/\\]/);
  return parts.length > 1 ? parts.slice(0, 2).join('/') : parts[0];
}

function partitionIntoGroups(
  filePaths: string[],
  batchSize: number,
  projectPath: string,
  codePaths: string[]
): string[][] {
  const groups = new Map<string, string[]>();

  for (const fp of filePaths) {
    const relative = path.relative(projectPath, path.resolve(projectPath, fp));
    const key = computeGroupKey(relative, codePaths);

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
