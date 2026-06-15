import fs from 'node:fs';
import path from 'node:path';

export interface FileConceptEntry {
  lastProcessed: string;
  concepts: { name: string; type: string }[];
}

export interface FileConceptMap {
  version: 2;
  files: Record<string, FileConceptEntry>;
}

export function readFileConceptMap(projectPath: string): FileConceptMap {
  const mapPath = path.join(projectPath, '.domainlens', 'file-concept-map.json');
  if (!fs.existsSync(mapPath)) {
    return { version: 2, files: {} };
  }
  try {
    const data = JSON.parse(fs.readFileSync(mapPath, 'utf-8'));
    if (data && data.version === 2 && data.files) {
      return data as FileConceptMap;
    }
  } catch {
    // invalid JSON or unknown format — start fresh
  }
  return { version: 2, files: {} };
}

export function writeFileConceptMap(projectPath: string, map: FileConceptMap): void {
  const mapPath = path.join(projectPath, '.domainlens', 'file-concept-map.json');
  fs.mkdirSync(path.dirname(mapPath), { recursive: true });
  fs.writeFileSync(mapPath, JSON.stringify(map, null, 2), 'utf-8');
}

export function updateFileConceptMap(
  projectPath: string,
  newEntries: Record<string, { concepts: { name: string; type: string }[] }>
): void {
  const map = readFileConceptMap(projectPath);
  const now = new Date().toISOString();

  for (const [filePath, entry] of Object.entries(newEntries)) {
    const existing = map.files[filePath];
    const existingNames = new Set(existing ? existing.concepts.map((c) => `${c.name}:${c.type}`) : []);

    if (!existing) {
      map.files[filePath] = { lastProcessed: now, concepts: [] };
    } else {
      map.files[filePath].lastProcessed = now;
    }

    for (const concept of entry.concepts) {
      const key = `${concept.name}:${concept.type}`;
      if (!existingNames.has(key)) {
        map.files[filePath].concepts.push(concept);
        existingNames.add(key);
      }
    }
  }

  writeFileConceptMap(projectPath, map);
}
