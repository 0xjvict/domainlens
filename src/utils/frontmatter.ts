export function parseFrontmatter(
  content: string,
): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(': ');
    if (idx > 0) {
      fm[line.slice(0, idx).trim()] = line.slice(idx + 2).trim();
    }
  }
  return fm;
}

export function parseTags(tagsStr?: string): string[] {
  if (!tagsStr) return [];
  const inner = tagsStr.replace(/^\[|\]$/g, '');
  if (!inner) return [];
  return inner
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}
