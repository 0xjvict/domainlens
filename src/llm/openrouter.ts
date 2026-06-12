import OpenAI from 'openai';
import type { DomainLensConfig } from '../types.js';
import type { Signal } from '../inferrer/heuristics.js';

export async function enrichConcept(
  concept: string,
  signals: Signal[],
  config: DomainLensConfig
): Promise<string | null> {
  const apiKey = process.env[config.llm_key_env];

  if (!apiKey) {
    console.log(
      `⚠ LLM key not found (${config.llm_key_env}) — falling back to skeleton mode`
    );
    return null;
  }

  const client = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey,
  });

  const signalSummary = signals
    .map((s) => `- [${s.type}] ${s.detail}`)
    .join('\n');

  const prompt = `You are a technical documentation assistant. Based on the following signals detected in the codebase, write a concise business definition for the domain concept "${concept}".

Detected signals:
${signalSummary}

Write ONLY the definition text (2-4 sentences). Focus on the business meaning, not technical implementation details. Do not include headers, bullet points, or any markdown formatting in your response.`;

  try {
    const response = await client.chat.completions.create({
      model: config.llm_model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 300,
    });

    const content = response.choices[0]?.message?.content;
    return content ? content.trim() : null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`⚠ LLM enrichment failed for "${concept}": ${message}`);
    return null;
  }
}
