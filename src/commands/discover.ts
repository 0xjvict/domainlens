import fs from 'node:fs';
import path from 'node:path';
import type { DomainLensConfig, AgentConcept, BusinessRule } from '../types.js';
import { extractSchema } from '../extractors/schema.js';
import { scanSqlExamples, scanConstantsAndEnums } from '../extractors/codeScanner.js';
import { scanOrm, type OrmType } from '../extractors/ormScanner.js';
import { extractDocs } from '../extractors/docExtractor.js';
import { inferConcepts } from '../inferrer/heuristics.js';
import type { DomainConcept } from '../inferrer/heuristics.js';
import { generateDomainSkills } from '../skills/domainSkills.js';
import { generateRulesSkills } from '../skills/rulesSkills.js';
import { runAgent } from '../agent/runner.js';
import { preScanConcepts, mergeConcepts } from '../llm/preScan.js';
import { detectCandidates, extractBusinessRules } from '../extractors/businessRules.js';
import { generateBusinessRulesSkills } from '../skills/businessRulesSkills.js';
import { generateRelationsMap } from '../skills/relationsSkills.js';
import { updateFileConceptMap } from '../utils/fileConceptMap.js';

export interface DiscoverOptions {
  dryRun?: boolean;
  force?: boolean;
  noEnrich?: boolean;
  agent?: boolean;
  embeddings?: boolean;
  relationsOnly?: boolean;
  project?: string;
}

export async function runDiscover(options: DiscoverOptions = {}): Promise<void> {
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

  console.log('DomainLens discover starting...\n');

  if (options.relationsOnly) {
    const domainDir = path.join(projectPath, 'skills', 'domain');
    if (!fs.existsSync(domainDir) || fs.readdirSync(domainDir).filter((f) => f.endsWith('.md') && f !== 'relations.md').length === 0) {
      console.error('✗ No domain skills found. Run full `domainlens discover` first to generate domain concepts.');
      process.exit(1);
    }
    console.log('▶ Regenerating relations map from existing skills...');
    await generateRelationsMap(projectPath, { dryRun: options.dryRun, force: options.force });
    console.log('\n✓ Relations map updated');
    return;
  }

  if (options.agent) {
    await runDiscoverAgent(projectPath, config, options);
  } else {
    await runDiscoverStandard(projectPath, config, options);
  }
}

async function runDiscoverStandard(
  projectPath: string,
  config: DomainLensConfig,
  options: DiscoverOptions
): Promise<void> {
  console.log('▶ Step 1/8: Extracting database schema...');
  const schema = await extractSchema(config, projectPath);
  if (schema) {
    console.log(`  ✓ ${schema.tables.length} tables, ${schema.enums.length} enums`);
  }

  let llmConceptNames: string[] = [];
  if (!options.noEnrich) {
    const existingNames = getExistingDomainAndRuleNames(projectPath);
    console.log('▶ Step 2/8: LLM pre-scan for implicit concepts...');
    llmConceptNames = await preScanConcepts({
      config,
      schema,
      projectPath,
      existingConceptNames: existingNames,
    });
    if (llmConceptNames.length > 0) {
      console.log(`  ✓ ${llmConceptNames.length} implicit concepts discovered by LLM`);
      for (const name of llmConceptNames) {
        console.log(`    → Concept: "${name}" (ai-inferred, no direct signals)`);
      }
    } else {
      console.log('  No additional implicit concepts discovered');
    }
  } else {
    console.log('▶ Step 2/8: LLM pre-scan — skipped (--no-enrich)');
  }

  console.log('▶ Step 3/8: Scanning source code...');
  const sqlExamples = scanSqlExamples(config, projectPath);
  const { constants, enums } = scanConstantsAndEnums(config, projectPath);
  console.log(
    `  ✓ ${sqlExamples.length} SQL examples, ${constants.length} constants, ${enums.length} enums`
  );

  console.log('▶ Step 4/8: Scanning ORM models...');
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

  console.log('▶ Step 5/8: Extracting documentation...');
  const { sections, sqlBlocks, adrs } = extractDocs(config, projectPath);
  console.log(
    `  ✓ ${sections.length} sections, ${sqlBlocks.length} SQL blocks, ${adrs.length} ADRs`
  );

  console.log('▶ Step 6/8: Inferring domain concepts...');
  const heuristicConcepts = inferConcepts({
    schema,
    sqlExamples,
    constants,
    enums,
    docSections: sections,
    ormSignals,
  });
  const concepts = mergeConcepts(heuristicConcepts, llmConceptNames);
  const heuristicCount = heuristicConcepts.length;
  const llmOnlyCount = concepts.length - heuristicCount;
  console.log(`  ✓ ${concepts.length} domain concepts (${heuristicCount} from heuristics${llmOnlyCount > 0 ? `, ${llmOnlyCount} from LLM pre-scan` : ''})`);

  console.log('▶ Step 7/8: Generating domain & technical skills...');
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

  console.log('▶ Step 8/8: Extracting business rules...');
  const candidates = detectCandidates(config, projectPath);
  let businessRules: BusinessRule[] = [];
  if (candidates.length > 0) {
    console.log(`  ✓ ${candidates.length} candidate files detected`);
    const batchSize = config.rules_batch_size ?? 10;
    businessRules = await extractBusinessRules(candidates, config, batchSize);
    if (businessRules.length > 0) {
      console.log(`  ✓ ${businessRules.length} business rules extracted`);
      const bizResult = await generateBusinessRulesSkills(businessRules, config, projectPath, {
        dryRun: options.dryRun,
        force: options.force,
        noEnrich: options.noEnrich,
      });
      rulesResult.created += bizResult.created;
      rulesResult.updated += bizResult.updated;
      rulesResult.enriched += bizResult.enriched;
    } else {
      console.log('  No business rules extracted');
    }
  } else {
    console.log('  No candidate files found in rules_paths');
  }

  console.log('▶ Synthesizing relations map...');
  const relationsGenerated = await generateRelationsMap(projectPath, {
    dryRun: options.dryRun,
    force: options.force,
  });
  if (relationsGenerated) {
    console.log('  ✓ relations.md updated');
  }

  const totalCreated = domainResult.created + rulesResult.created;
  const totalUpdated = domainResult.updated + rulesResult.updated;
  const totalEnriched = domainResult.enriched + rulesResult.enriched;

  let embedResult: { indexed: number } | undefined;

  if (options.embeddings) {
    console.log('\n▶ Embedding pipeline...');
    embedResult = await runEmbeddings(projectPath, config);
  }

  console.log('▶ Updating file-concept-map...');
  const fileEntries: Record<string, { concepts: { name: string; type: string }[] }> = {};
  for (const c of concepts) {
    for (const sig of c.signals) {
      if (sig.source) {
        if (!fileEntries[sig.source]) fileEntries[sig.source] = { concepts: [] };
        fileEntries[sig.source].concepts.push({ name: c.concept, type: 'domain' });
      }
    }
  }
  for (const rule of businessRules) {
    for (const file of rule.enforced_in) {
      if (!fileEntries[file]) fileEntries[file] = { concepts: [] };
      fileEntries[file].concepts.push({ name: rule.name, type: 'business_rule' });
    }
  }
  updateFileConceptMap(projectPath, fileEntries);

  console.log('\n✓ Discovery complete');

  const enrichPart = options.noEnrich
    ? '(skeletons only)'
    : `(${totalEnriched} enriched via OpenRouter)`;

  const embedPart = options.embeddings && embedResult
    ? `, ${embedResult.indexed} embeddings re-indexed`
    : '';

  console.log(`  ${totalCreated} skills created ${enrichPart}, ${totalUpdated} skills updated${embedPart}`);
}

async function runDiscoverAgent(
  projectPath: string,
  config: DomainLensConfig,
  options: DiscoverOptions
): Promise<void> {
  console.log('▶ Step 1/4: Extracting database schema...');
  const schema = await extractSchema(config, projectPath);
  if (schema) {
    console.log(`  ✓ ${schema.tables.length} tables, ${schema.enums.length} enums`);
  }

  console.log('▶ Step 2/4: Agent exploring codebase...');
  const existingSkills = options.force ? [] : getExistingSkillNames(projectPath);
  const agentConcepts = await runAgent(config, projectPath, existingSkills);
  const { constants } = scanConstantsAndEnums(config, projectPath);
  const concepts = convertAgentConcepts(agentConcepts);
  console.log(`  ✓ ${concepts.length} domain concepts discovered`);
  for (const c of concepts) {
    console.log(`    → Concept: "${c.concept}" (${c.signals.length} signals)`);
  }

  console.log('▶ Step 3/4: Extracting documentation...');
  const { sections, sqlBlocks, adrs } = extractDocs(config, projectPath);
  console.log(
    `  ✓ ${sections.length} sections, ${sqlBlocks.length} SQL blocks, ${adrs.length} ADRs`
  );

  console.log('▶ Step 4/4: Generating skills...');
  const domainResult = await generateDomainSkills(concepts, config, projectPath, {
    dryRun: options.dryRun,
    force: options.force,
    noEnrich: true,
  });

  const rulesResult = await generateRulesSkills(schema, constants, config, projectPath, {
    dryRun: options.dryRun,
    force: options.force,
    noEnrich: options.noEnrich,
  });

  const totalCreated = domainResult.created + rulesResult.created;
  const totalUpdated = domainResult.updated + rulesResult.updated;

  if (options.embeddings) {
    console.log('\n▶ Embedding pipeline...');
    await runEmbeddings(projectPath, config);
  }

  console.log('▶ Updating file-concept-map...');
  const fileEntries: Record<string, { concepts: { name: string; type: string }[] }> = {};
  for (const c of concepts) {
    for (const sig of c.signals) {
      if (sig.source) {
        if (!fileEntries[sig.source]) fileEntries[sig.source] = { concepts: [] };
        fileEntries[sig.source].concepts.push({ name: c.concept, type: 'domain' });
      }
    }
  }
  updateFileConceptMap(projectPath, fileEntries);

  console.log('\n✓ Discovery complete');
  console.log(`  ${totalCreated} skills created (agent-discovered, ai-generated), ${totalUpdated} skills updated`);
}

function getExistingSkillNames(projectPath: string): string[] {
  const names: string[] = [];
  const dirs = [
    path.join(projectPath, 'skills', 'domain'),
    path.join(projectPath, 'skills', 'rules', 'business'),
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const content = fs.readFileSync(path.join(dir, f), 'utf-8');
      const fm = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fm) continue;
      const typeLine = fm[1].split('\n').find((l) => l.startsWith('type:'));
      if (!typeLine) continue;
      const type = typeLine.slice(5).trim();
      if (type === 'domain' || type === 'business_rule') {
        names.push(f.replace(/\.md$/, ''));
      }
    }
  }

  return names;
}

function getExistingDomainAndRuleNames(projectPath: string): string[] {
  const names: string[] = [];
  const domainDir = path.join(projectPath, 'skills', 'domain');
  const businessDir = path.join(projectPath, 'skills', 'rules', 'business');

  if (fs.existsSync(domainDir)) {
    for (const f of fs.readdirSync(domainDir)) {
      if (f.endsWith('.md')) names.push(f.replace(/\.md$/, ''));
    }
  }
  if (fs.existsSync(businessDir)) {
    for (const f of fs.readdirSync(businessDir)) {
      if (f.endsWith('.md')) names.push(f.replace(/\.md$/, ''));
    }
  }

  return names;
}

function convertAgentConcepts(agentConcepts: AgentConcept[]): DomainConcept[] {
  return agentConcepts.map((ac) => ({
    concept: ac.concept,
    definition: ac.definition,
    signals: ac.signals.map((s) => ({
      type: s.type as DomainConcept['signals'][number]['type'],
      detail: s.value,
      source: s.file,
    })),
    skipEnrich: !!(ac.states?.length || ac.business_rules?.length || ac.related_concepts?.length),
  }));
}

async function runEmbeddings(projectPath: string, _config: DomainLensConfig): Promise<{ indexed: number }> {
  const { embedAll } = await import('../embeddings/embed.js');
  return await embedAll(projectPath);
}
