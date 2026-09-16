import { isAbsolute, posix } from 'node:path';
import { z } from 'zod';
import { repositoryNames } from '../intake/planning-contract.js';

/*
 * Versioned results returned by agents. Every object is strict, so a result cannot carry extra fields such as a
 * command, tool, repository path, credential, or model identifier. The orchestrator derives all of those from trusted
 * configuration; a result only describes intent, which the orchestrator then verifies against Git and quality gates.
 */

const text = z.string().trim().min(1).max(4_000);
const repositoryPath = z.string().trim().min(1).max(500);
const repository = z.enum(repositoryNames);

export const analysisResultVersion = 'kelolakelas.agent.analysis/v1';
export const implementationResultVersion = 'kelolakelas.agent.implementation/v1';
export const fixResultVersion = 'kelolakelas.agent.fix/v1';
export const reviewResultVersion = 'kelolakelas.agent.review/v1';

export const analysisResultSchema = z.object({
  schemaVersion: z.literal(analysisResultVersion),
  decision: z.enum(['proceed', 'needs-clarification']),
  summary: text,
  clarifications: z.array(text).max(20),
  repositories: z.array(z.object({
    repository,
    summary: text,
    changes: z.array(z.object({
      path: repositoryPath,
      action: z.enum(['create', 'modify', 'delete']),
      rationale: text,
    }).strict()).max(200),
  }).strict()).max(repositoryNames.length),
  acceptanceCriteria: z.array(z.object({ criterion: text, approach: text }).strict()).max(50),
  testPlan: z.array(text).max(50),
  risks: z.array(text).max(20),
}).strict();

function changeResultSchema<Version extends string>(version: Version) {
  return z.object({
    schemaVersion: z.literal(version),
    status: z.enum(['completed', 'blocked']),
    summary: text,
    blockedReason: text.nullable(),
    repositories: z.array(z.object({ repository, summary: text }).strict()).max(repositoryNames.length),
    /** What the agent says it verified. Informational only; quality gates are run by the orchestrator. */
    validation: z.array(text).max(50),
  }).strict();
}

export const implementationResultSchema = changeResultSchema(implementationResultVersion);
export const fixResultSchema = changeResultSchema(fixResultVersion);

export const reviewResultSchema = z.object({
  schemaVersion: z.literal(reviewResultVersion),
  verdict: z.enum(['approve', 'request-changes', 'reject']),
  summary: text,
  findings: z.array(z.object({
    repository,
    path: repositoryPath,
    line: z.number().int().positive().nullable(),
    severity: z.enum(['blocker', 'major', 'minor']),
    description: text,
  }).strict()).max(100),
}).strict();

export type AnalysisResult = z.infer<typeof analysisResultSchema>;
export type ChangeResult = z.infer<typeof implementationResultSchema> | z.infer<typeof fixResultSchema>;
export type ReviewResult = z.infer<typeof reviewResultSchema>;

/** A repository-relative POSIX path that cannot escape the repository. */
export function isSafeRepositoryPath(path: string): boolean {
  const trimmed = path.replace(/\/+$/, '');
  if (trimmed === '' || trimmed.includes('\\') || trimmed.includes('\0') || isAbsolute(trimmed)) return false;
  const normalized = posix.normalize(trimmed);
  return normalized === trimmed && normalized !== '.' && normalized !== '..' && !normalized.startsWith('../');
}

/**
 * Semantic checks a JSON schema cannot express. The plan must cover exactly the repositories the contract declares, with
 * safe paths, and a clarification request must say what is unclear.
 */
export function analysisProblems(result: AnalysisResult, declared: readonly string[]): string[] {
  const problems: string[] = [];
  const planned = result.repositories.map((entry) => entry.repository);
  if (new Set(planned).size !== planned.length) problems.push('plan lists a repository more than once');
  if ([...planned].sort().join('\0') !== [...declared].sort().join('\0')) {
    problems.push(`plan repositories [${planned.join(', ')}] must equal contract repositories [${declared.join(', ')}]`);
  }
  if (result.decision === 'proceed' && result.repositories.some((entry) => entry.changes.length === 0)) {
    problems.push('every planned repository must list at least one change');
  }
  if (result.decision === 'needs-clarification' && result.clarifications.length === 0) {
    problems.push('needs-clarification requires at least one clarification');
  }
  for (const entry of result.repositories) {
    for (const change of entry.changes) {
      if (!isSafeRepositoryPath(change.path)) problems.push(`unsafe path in ${entry.repository}: ${JSON.stringify(change.path)}`);
    }
  }
  return problems;
}

export function reviewProblems(result: ReviewResult, declared: readonly string[]): string[] {
  return result.findings.flatMap((finding) => [
    ...(declared.includes(finding.repository) ? [] : [`finding names undeclared repository ${finding.repository}`]),
    ...(isSafeRepositoryPath(finding.path) ? [] : [`unsafe finding path ${JSON.stringify(finding.path)}`]),
  ]);
}

/** Blocking findings override an approval, so the verdict cannot contradict its own findings. */
export function effectiveVerdict(result: ReviewResult): ReviewResult['verdict'] {
  if (result.verdict === 'approve' && result.findings.some((finding) => finding.severity !== 'minor')) return 'request-changes';
  return result.verdict;
}

export type JsonSchema = Record<string, unknown>;

/**
 * Converts the subset of Zod used by agent results into a strict structured-output JSON schema: every property is
 * required, optional values are expressed as nullable, and no additional properties are allowed. Length and count
 * limits are enforced by Zod after the run, because structured-output providers support few validation keywords.
 */
export function toStrictJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    return {
      type: 'object',
      properties: Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, toStrictJsonSchema(value)])),
      required: Object.keys(shape),
      additionalProperties: false,
    };
  }
  if (schema instanceof z.ZodNullable) return { anyOf: [toStrictJsonSchema(schema.unwrap() as z.ZodTypeAny), { type: 'null' }] };
  if (schema instanceof z.ZodArray) return { type: 'array', items: toStrictJsonSchema(schema.element as z.ZodTypeAny) };
  if (schema instanceof z.ZodEnum) return { type: 'string', enum: [...(schema.options as string[])] };
  if (schema instanceof z.ZodLiteral && typeof schema.value === 'string') return { type: 'string', enum: [schema.value] };
  if (schema instanceof z.ZodString) return { type: 'string' };
  if (schema instanceof z.ZodNumber) return { type: schema.isInt ? 'integer' : 'number' };
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' };
  throw new Error(`Unsupported schema type for structured output: ${schema.constructor.name}`);
}
