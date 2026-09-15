import { z } from 'zod';

export const repositoryNames = [
  'web',
  'api-gateway',
  'academic',
  'identity',
  'billing',
] as const;

export const complexityValues = [
  'very-low',
  'low',
  'medium',
  'high',
  'very-high',
  'critical',
] as const;

const repositorySchema = z.enum(repositoryNames);
const labelSchema = z.enum([...repositoryNames, 'ai-ready']);
const complexitySchema = z.enum(complexityValues);
const draftKeySchema = z.string().regex(
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
  'must be a lowercase kebab-case key',
);
const nonEmptyText = z.string().trim().min(1);
const uniqueTextArray = (minimumItems = 0) => z.array(nonEmptyText).min(minimumItems).superRefine((values, context) => {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'must not contain duplicates' });
  }
});

export const planningProjectSchema = z.object({
  key: draftKeySchema,
  name: nonEmptyText,
  outcome: nonEmptyText,
  problem: nonEmptyText,
  valueAndPriority: nonEmptyText,
  scope: uniqueTextArray(1),
  outOfScope: uniqueTextArray(1),
  successMetrics: uniqueTextArray(1),
  dependenciesAndRisks: uniqueTextArray(),
}).strict();

const issueBodySchema = z.object({
  backgroundProblem: nonEmptyText,
  goal: nonEmptyText,
  requirements: uniqueTextArray(1),
  acceptanceCriteria: uniqueTextArray(1),
  technicalNotes: nonEmptyText,
  relevantAreas: uniqueTextArray(1),
  edgeCases: uniqueTextArray(1),
  testingValidation: uniqueTextArray(1),
  outOfScope: uniqueTextArray(1),
}).strict();

const sourceSchema = z.object({
  linearIssueId: nonEmptyText,
  linearIdentifier: nonEmptyText,
  linearCreatedAt: z.string().datetime({ offset: true }),
  gitBranchName: nonEmptyText,
  linearBlockedByIdentifiers: uniqueTextArray(),
}).strict();

export const planningIssueSchema = z.object({
  draftKey: draftKeySchema,
  projectKey: draftKeySchema.nullable(),
  title: nonEmptyText,
  type: z.enum(['Feature', 'Improvement', 'Refactor']),
  priority: z.enum(['Urgent', 'High', 'Medium', 'Low']),
  estimate: z.enum(['S', 'M', 'L']),
  complexity: complexitySchema,
  labels: z.array(labelSchema).min(2),
  repositories: z.array(repositorySchema).min(1),
  blockedByDraftKeys: z.array(draftKeySchema),
  externalDependencies: z.array(z.object({
    key: draftKeySchema,
    description: nonEmptyText,
    verification: nonEmptyText,
  }).strict()),
  body: issueBodySchema,
  source: sourceSchema.optional(),
}).strict().superRefine((issue, context) => {
  if (new Set(issue.labels).size !== issue.labels.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['labels'], message: 'must not contain duplicates' });
  }
  if (new Set(issue.repositories).size !== issue.repositories.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['repositories'], message: 'must not contain duplicates' });
  }
  if (!issue.labels.includes('ai-ready')) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['labels'], message: 'must include ai-ready' });
  }

  const repositoryLabels = issue.labels.filter(
    (label): label is (typeof repositoryNames)[number] => label !== 'ai-ready',
  );
  const expected = [...issue.repositories].sort();
  const actual = [...repositoryLabels].sort();
  if (expected.join('\u0000') !== actual.join('\u0000')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['labels'],
      message: 'repository labels must exactly match repositories',
    });
  }
});

export const planningBacklogSchema = z.object({
  schemaVersion: z.literal('kelolakelas.planning-backlog/v1'),
  projects: z.array(planningProjectSchema),
  issues: z.array(planningIssueSchema).min(1),
}).strict().superRefine((backlog, context) => {
  const projectKeys = new Set<string>();
  backlog.projects.forEach((project, index) => {
    if (projectKeys.has(project.key)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['projects', index, 'key'], message: 'duplicate project key' });
    }
    projectKeys.add(project.key);
  });

  const issueIndexes = new Map<string, number>();
  backlog.issues.forEach((issue, index) => {
    if (issueIndexes.has(issue.draftKey)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['issues', index, 'draftKey'], message: 'duplicate issue key' });
    } else {
      issueIndexes.set(issue.draftKey, index);
    }
    if (issue.projectKey !== null && !projectKeys.has(issue.projectKey)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['issues', index, 'projectKey'], message: 'unknown project key' });
    }
  });

  const hydratedCount = backlog.issues.filter((issue) => issue.source !== undefined).length;
  if (hydratedCount !== 0 && hydratedCount !== backlog.issues.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['issues'], message: 'source data must be present for either all issues or none' });
  }

  const identifiersByKey = new Map(
    backlog.issues.flatMap((issue) => issue.source
      ? [[issue.draftKey, issue.source.linearIdentifier] as const]
      : []),
  );
  const dependentKeys = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  backlog.issues.forEach((issue, index) => {
    inDegree.set(issue.draftKey, 0);
    const seenBlockers = new Set<string>();
    issue.blockedByDraftKeys.forEach((blockerKey, blockerIndex) => {
      const path = ['issues', index, 'blockedByDraftKeys', blockerIndex];
      if (seenBlockers.has(blockerKey)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path, message: 'duplicate dependency key' });
      }
      seenBlockers.add(blockerKey);
      if (blockerKey === issue.draftKey) {
        context.addIssue({ code: z.ZodIssueCode.custom, path, message: 'issue cannot block itself' });
      } else if (!issueIndexes.has(blockerKey)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path, message: 'unknown dependency key' });
      } else {
        inDegree.set(issue.draftKey, (inDegree.get(issue.draftKey) ?? 0) + 1);
        dependentKeys.set(blockerKey, [...(dependentKeys.get(blockerKey) ?? []), issue.draftKey]);
      }
    });

    if (issue.source) {
      const expectedIdentifiers = issue.blockedByDraftKeys
        .map((key) => identifiersByKey.get(key))
        .filter((identifier): identifier is string => identifier !== undefined)
        .sort();
      const actualIdentifiers = [...issue.source.linearBlockedByIdentifiers].sort();
      if (expectedIdentifiers.join('\u0000') !== actualIdentifiers.join('\u0000')) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['issues', index, 'source', 'linearBlockedByIdentifiers'],
          message: 'Linear blockedBy relations do not match the planning contract',
        });
      }
    }
  });

  const queue = [...inDegree.entries()].filter(([, degree]) => degree === 0).map(([key]) => key);
  let visited = 0;
  while (queue.length > 0) {
    const key = queue.shift();
    if (key === undefined) break;
    visited += 1;
    for (const dependentKey of dependentKeys.get(key) ?? []) {
      const nextDegree = (inDegree.get(dependentKey) ?? 0) - 1;
      inDegree.set(dependentKey, nextDegree);
      if (nextDegree === 0) queue.push(dependentKey);
    }
  }
  if (visited !== backlog.issues.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['issues'], message: 'dependency graph contains a cycle' });
  }
});

export type PlanningBacklog = z.infer<typeof planningBacklogSchema>;
export type PlanningIssue = z.infer<typeof planningIssueSchema>;
export type PlanningProject = z.infer<typeof planningProjectSchema>;
export type Complexity = z.infer<typeof complexitySchema>;

export function validatePlanningBacklog(input: unknown): PlanningBacklog {
  return planningBacklogSchema.parse(input);
}

export function validatePlanningIssue(input: unknown): PlanningIssue {
  return planningIssueSchema.parse(input);
}

export function validatePlanningProject(input: unknown): PlanningProject {
  return planningProjectSchema.parse(input);
}