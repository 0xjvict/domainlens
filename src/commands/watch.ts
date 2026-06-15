import fs from 'node:fs';
import path from 'node:path';
import type { DomainLensConfig } from '../types.js';
import { runIncrementalRebuild } from './incremental.js';

export interface WatchOptions {
  noEnrich?: boolean;
  dryRun?: boolean;
  project?: string;
}

export async function runWatch(options: WatchOptions = {}): Promise<void> {
  const projectPath = options.project ? path.resolve(options.project) : process.cwd();
  const configPath = path.join(projectPath, '.domainlens', 'config.json');

  if (!fs.existsSync(configPath)) {
    console.error('✗ .domainlens/config.json not found. Run `domainlens init` first.');
    process.exit(1);
  }

  let config: DomainLensConfig;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as DomainLensConfig;
  } catch {
    console.error('✗ Failed to parse .domainlens/config.json — check for syntax errors.');
    process.exit(1);
  }

  const interval = (config.watch_interval_seconds ?? 30) * 1000;
  console.log(`DomainLens watch — polling every ${interval / 1000}s\n`);

  let stopping = false;
  let running = false;
  let cycle = 0;

  process.on('SIGINT', () => {
    if (stopping) return;
    stopping = true;
    console.log('\n⚠ Stopping after current cycle completes...');
    if (!running) process.exit(0);
  });

  process.on('SIGTERM', () => {
    if (stopping) return;
    stopping = true;
    console.log('\n⚠ Stopping after current cycle completes...');
    if (!running) process.exit(0);
  });

  const scheduleNext = (): void => {
    if (stopping) {
      process.exit(0);
      return;
    }
    setTimeout(runCycle, interval);
  };

  const runCycle = async (): Promise<void> => {
    running = true;
    cycle++;
    const now = new Date();
    const timeStr = now.toISOString().replace('T', ' ').slice(0, 19);
    console.log(`[${timeStr}] Cycle #${cycle} — checking for changes...`);

    try {
      const changed = await runIncrementalRebuild(projectPath, config, {
        noEnrich: options.noEnrich,
        dryRun: options.dryRun,
      });

      if (changed) {
        console.log(`[${timeStr}] ✓ Cycle #${cycle} complete`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${timeStr}] ✗ Cycle #${cycle} failed: ${msg}`);
    } finally {
      running = false;
      scheduleNext();
    }
  };

  await runCycle();
}
