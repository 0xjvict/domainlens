export function toSkillFilename(name: string): string {
  return name
    .replace(/[/\\]/g, '-')
    .replace(/[↔→:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
