import fs from 'node:fs';
import path from 'node:path';
import type { DomainLensConfig } from '../types.js';
import { extractSchema } from '../extractors/schema.js';
import { scanSqlExamples, scanConstantsAndEnums } from '../extractors/codeScanner.js';
import { scanOrm, type OrmType } from '../extractors/ormScanner.js';
import { extractDocs } from '../extractors/docExtractor.js';
import { inferConcepts } from '../inferrer/heuristics.js';
import { generateDomainSkills } from '../skills/domainSkills.js';
import { generateRulesSkills } from '../skills/rulesSkills.js';

export interface DiscoverOptions {
  dryRun?: boolean;
  force?: boolean;
  noEnrich?: boolean;
  embeddings?: boolean;
  project?: string;
}

export async function runDiscover(options: DiscoverOptions = {}): Promise<void> {
  const projectPath = options.project ? path.resolve(options.project) : process.cwd();
  const configPath = path.join(projectPath, '.domainlens', 'config.json');

  if (!fs.existsSync(configPath)) {
    console.error('✗ .domainlens/config.json not found. Run `domainlens init` first.');
    process.exit(1);
  }

  const config: DomainLensConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  console.log('DomainLens discover starting...\n');

  console.log('▶ Step 1/6: Extracting database schema...');
  const schema = await extractSchema(config, projectPath);
  if (schema) {
    console.log(`  ✓ ${schema.tables.length} tables, ${schema.enums.length} enums`);
  }

  console.log('▶ Step 2/6: Scanning source code...');
  const sqlExamples = scanSqlExamples(config, projectPath);
  const { constants, enums } = scanConstantsAndEnums(config, projectPath);
  console.log(
    `  ✓ ${sqlExamples.length} SQL examples, ${constants.length} constants, ${enums.length} enums`
  );

  console.log('▶ Step 3/6: Scanning ORM models...');
  const ormOverride = config.orm as OrmType | undefined;
  const { orm: detectedOrm, signals: ormSignals } = scanOrm(projectPath, config, ormOverride);
  if (detectedOrm) {
    const modelCount = ormSignals.filter((s) => s.type === 'orm_model').length;
    const enumCount = ormSignals.filter((s) => s.type === 'orm_enum').length;
    const ormLabel = detectedOrm.charAt(0).toUpperCase() + detectedOrm.slice(1);
    console.log(`  ⚙ ORM detected: ${ormLabel} — ${modelCount} models, ${enumCount} enums extracted`);
  } else {
    console.log('  No ORM detected — using generic code scanner only');
  }

  console.log('▶ Step 4/6: Extracting documentation...');
  const { sections, sqlBlocks, adrs } = extractDocs(config, projectPath);
  console.log(
    `  ✓ ${sections.length} sections, ${sqlBlocks.length} SQL blocks, ${adrs.length} ADRs`
  );

  console.log('▶ Step 5/6: Inferring domain concepts...');
  const concepts = inferConcepts({
    schema,
    sqlExamples,
    constants,
    enums,
    docSections: sections,
    ormSignals,
  });
  console.log(`  ✓ ${concepts.length} domain concepts inferred`);

  console.log('▶ Step 6/6: Generating skills...');
  const domainResult = await generateDomainSkills(concepts, config, projectPath, {
    dryRun: options.dryRun,
    force: options.force,
    noEnrich: options.noEnrich,
  });

  const rulesResult = await generateRulesSkills(schema, constants, config, projectPath, {
    dryRun: options.dryRun,
    force: options.force,
    noEnrich: options.noEnrich,
  });

  const totalCreated = domainResult.created + rulesResult.created;
  const totalUpdated = domainResult.updated + rulesResult.updated;
  const totalEnriched = domainResult.enriched + rulesResult.enriched;

  let embedResult: { indexed: number } | undefined;

  if (options.embeddings) {
    console.log('\n▶ Embedding pipeline...');
    embedResult = await runEmbeddings(projectPath, config);
  }

  console.log('\n✓ Discovery complete');

  const enrichPart = options.noEnrich
    ? '(skeletons only)'
    : `(${totalEnriched} enriched via OpenRouter)`;

  const embedPart = options.embeddings && embedResult
    ? `, ${embedResult.indexed} embeddings re-indexed`
    : '';

  console.log(`  ${totalCreated} skills created ${enrichPart}, ${totalUpdated} skills updated${embedPart}`);
}

async function runEmbeddings(projectPath: string, _config: DomainLensConfig): Promise<{ indexed: number }> {
  const { embedAll } = await import('../embeddings/embed.js');
  return await embedAll(projectPath);
}
