import { DateTime } from 'luxon';
import { z } from 'zod';

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const windowSchema = z.object({
  start: z.string().regex(timePattern, 'must use HH:mm format'),
  end: z.string().regex(timePattern, 'must use HH:mm format'),
});
const daySchema = z.object({ enabled: z.boolean(), windows: z.array(windowSchema) });

export const configSchema = z.object({
  timezone: z.string().min(1),
  orchestrator: z.object({
    maxConcurrentTasks: z.number().int().positive().default(1),
    pollingIntervalSeconds: z.number().int().positive().default(60),
    leaseDurationSeconds: z.number().int().min(30).default(300),
    heartbeatIntervalSeconds: z.number().int().positive().default(60),
    shutdownGracePeriodSeconds: z.number().int().positive().max(300).default(30),
    usageLimitPauseMinutes: z.number().int().positive().default(30),
    http: z.object({
      host: z.string().min(1).default('127.0.0.1'),
      port: z.number().int().min(0).max(65_535).default(8089),
    }).default({}),
  }).default({}),
  schedule: z.object({
    enabled: z.boolean().default(true),
    allowMechanicalOperationsOutsideHours: z.boolean().default(true),
    finishCurrentStep: z.boolean().default(true),
    startNewStepIfRemainingMinutesAtLeast: z.number().nonnegative().default(20),
    minimumRemainingMinutesForNewTask: z.number().nonnegative().default(45),
    minimumRemainingMinutesForAnalysis: z.number().nonnegative().default(20),
    minimumRemainingMinutesForImplementation: z.number().nonnegative().default(45),
    minimumRemainingMinutesForReview: z.number().nonnegative().default(20),
    days: z.object({
      monday: daySchema.default({ enabled: false, windows: [] }),
      tuesday: daySchema.default({ enabled: false, windows: [] }),
      wednesday: daySchema.default({ enabled: false, windows: [] }),
      thursday: daySchema.default({ enabled: false, windows: [] }),
      friday: daySchema.default({ enabled: false, windows: [] }),
      saturday: daySchema.default({ enabled: false, windows: [] }),
      sunday: daySchema.default({ enabled: false, windows: [] }),
    }),
  }),
  linear: z.object({
    teamKey: z.string().min(1),
    requiredLabels: z.array(z.string()).default([]),
    excludedLabels: z.array(z.string()).default([]),
    apiUrl: z.string().url().default('https://api.linear.app/graphql'),
    requestTimeoutMs: z.number().int().positive().max(60_000).default(10_000),
    maxRetries: z.number().int().nonnegative().max(5).default(3),
  }),
  models: z.object({
    tiers: z.record(z.object({ model: z.string().min(1) })),
    analyzer: z.object({ tier: z.string().min(1), effort: z.enum(['low', 'medium', 'high', 'max']) }),
    reviewer: z.object({ tier: z.string().min(1), effort: z.enum(['low', 'medium', 'high', 'max']) }),
  }),
  limits: z.object({
    maxImplementationAttempts: z.number().int().positive().default(4),
    maxQualityFixAttempts: z.number().int().positive().default(3),
    maxReviewCycles: z.number().int().positive().default(3),
  }),
}).superRefine((config, context) => {
  if (!DateTime.now().setZone(config.timezone).isValid) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['timezone'],
      message: 'must be a valid IANA timezone',
    });
  }

  if (config.orchestrator.heartbeatIntervalSeconds * 2 > config.orchestrator.leaseDurationSeconds) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['orchestrator', 'heartbeatIntervalSeconds'],
      message: 'must be at most half of leaseDurationSeconds so one missed heartbeat does not expire a lease',
    });
  }

  for (const role of ['analyzer', 'reviewer'] as const) {
    const tier = config.models[role].tier;
    if (config.models.tiers[tier] === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['models', role, 'tier'],
        message: `must reference a configured model tier: ${tier}`,
      });
    }
  }
});

export type OrchestratorConfig = z.infer<typeof configSchema>;
export type ScheduleDay = keyof OrchestratorConfig['schedule']['days'];

export function validateConfig(input: unknown): OrchestratorConfig {
  return configSchema.parse(input);
}
