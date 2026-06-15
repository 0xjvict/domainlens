export function toSkillFilename(name: string): string {
  return name
    .toLowerCase()
    .replace(/[/\\]/g, '_')
    .replace(/[-\s]+/g, '_')
    .replace(/[↔→:*?"<>|()]/g, '')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}
