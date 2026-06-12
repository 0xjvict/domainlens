#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Command } from 'commander';
import { runInit } from './commands/init.js';
import { runDiscover } from './commands/discover.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')
) as { version: string };

const errExit = (err: unknown): never => {
  console.error('Error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
};

const program = new Command();

program
  .name('domainlens')
  .description('AI-native domain knowledge layer for code agents')
  .version(version);

program
  .command('init')
  .description('Initialize DomainLens in the current project')
  .action(() => {
    try {
      runInit();
    } catch (err) {
      errExit(err);
    }
  });

program
  .command('discover')
  .description('Extract schema, code, and docs; generate skill files')
  .option('--dry-run', 'Preview what would be written without touching the filesystem')
  .option('--force', 'Regenerate all skills from scratch, overwriting existing files')
  .option('--no-enrich', 'Skip LLM enrichment and write skeleton skills only')
  .option('--agent', 'Use AI agent to discover domain concepts (replaces scanner + heuristics)')
  .option('--embeddings', 'Also run the embedding pipeline after skill generation')
  .option('--project <path>', 'Path to the project (default: current directory)')
  .action((opts) => {
    runDiscover({
      dryRun: opts.dryRun,
      force: opts.force,
      noEnrich: opts.enrich === false,
      agent: opts.agent,
      embeddings: opts.embeddings,
      project: opts.project,
    }).catch(errExit);
  });

const modelsCmd = program.command('models').description('Manage embedding models');

modelsCmd
  .command('download')
  .description('Pre-download and cache the embedding model (~80MB, happens once)')
  .action(async () => {
    try {
      const { loadModel } = await import('./embeddings/model.js');
      await loadModel();
      console.log('Embedding model ready.');
    } catch (err) {
      errExit(err);
    }
  });

program
  .command('start')
  .description('Start the MCP stdio server for AI agent integration')
  .option('--project <path>', 'Path to the project (default: current directory)')
  .action(async (opts) => {
    try {
      const { startServer } = await import('./mcp/server.js');
      const projectPath = opts.project ?? process.cwd();
      process.stderr.write('DomainLens MCP server started (stdio)\n');
      await startServer(projectPath);
    } catch (err) {
      errExit(err);
    }
  });

program
  .command('status')
  .description('Show project statistics summary')
  .option('--project <path>', 'Path to the project (default: current directory)')
  .action(async (opts) => {
    try {
      const { runStatus } = await import('./commands/status.js');
      runStatus({ project: opts.project });
    } catch (err) {
      errExit(err);
    }
  });

const skillsCmd = program.command('skills').description('List and inspect generated skills');

skillsCmd
  .command('list')
  .description('List all generated skills in a table')
  .option('--project <path>', 'Path to the project (default: current directory)')
  .action(async (opts) => {
    try {
      const { listSkills } = await import('./commands/skills.js');
      listSkills({ project: opts.project });
    } catch (err) {
      errExit(err);
    }
  });

skillsCmd
  .command('show <name>')
  .description('Show the full Markdown content of a skill')
  .option('--project <path>', 'Path to the project (default: current directory)')
  .action(async (name, opts) => {
    try {
      const { showSkill } = await import('./commands/skills.js');
      showSkill(name, { project: opts.project });
    } catch (err) {
      errExit(err);
    }
  });

program
  .command('mcp-config')
  .description('Print MCP configuration JSON for your AI agent')
  .option('--project <path>', 'Path to the project (default: current directory)')
  .action(async (opts) => {
    try {
      const { printMcpConfig } = await import('./commands/mcpConfig.js');
      printMcpConfig({ project: opts.project });
    } catch (err) {
      errExit(err);
    }
  });

program.parse(process.argv);
