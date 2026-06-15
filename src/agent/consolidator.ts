import type { AgentConcept } from '../types.js';

export function consolidateConcepts(batches: AgentConcept[][]): AgentConcept[] {
  const map = new Map<string, AgentConcept>();

  for (const batch of batches) {
    for (const concept of batch) {
      const key = concept.concept.toLowerCase().trim();
      const existing = map.get(key);

      if (!existing) {
        map.set(key, {
          concept: concept.concept,
          definition: concept.definition,
          signals: [...concept.signals],
          states: concept.states ? [...concept.states] : undefined,
          business_rules: concept.business_rules ? [...concept.business_rules] : undefined,
          related_concepts: concept.related_concepts ? [...concept.related_concepts] : undefined,
        });
        continue;
      }

      const existingSignalCount = existing.signals.length;
      mergeSignals(existing, concept.signals);

      if (concept.related_concepts) {
        mergeArrayField(existing, 'related_concepts', concept.related_concepts);
      }

      if (concept.states) {
        mergeArrayField(existing, 'states', concept.states);
      }

      if (concept.business_rules) {
        mergeArrayField(existing, 'business_rules', concept.business_rules);
      }

      mergeDefinition(existing, concept, existingSignalCount);
    }
  }

  return Array.from(map.values());
}

function mergeSignals(existing: AgentConcept, newSignals: AgentConcept['signals']): void {
  const existingValues = new Set(existing.signals.map((s) => s.value));
  for (const sig of newSignals) {
    if (!existingValues.has(sig.value)) {
      existing.signals.push({ ...sig });
      existingValues.add(sig.value);
    }
  }
}

function mergeArrayField<K extends 'states' | 'business_rules' | 'related_concepts'>(
  existing: AgentConcept,
  field: K,
  newValues: NonNullable<AgentConcept[K]>
): void {
  const existingSet = new Set(existing[field] ?? []);
  for (const val of newValues) {
    if (!existingSet.has(val)) {
      if (!existing[field]) {
        (existing[field] as NonNullable<AgentConcept[K]>) = [] as any;
      }
      (existing[field] as NonNullable<AgentConcept[K]>).push(val);
      existingSet.add(val);
    }
  }
}

function mergeDefinition(existing: AgentConcept, incoming: AgentConcept, existingSignalCount: number): void {
  if (incoming.signals.length > existingSignalCount) {
    if (isSubstantiallyDifferent(existing.definition, incoming.definition)) {
      incoming.definition += `\n\nAlternate definition: ${existing.definition}`;
    }
    existing.definition = incoming.definition;
  }
}

function isSubstantiallyDifferent(a: string, b: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  return normalize(a) !== normalize(b);
}
