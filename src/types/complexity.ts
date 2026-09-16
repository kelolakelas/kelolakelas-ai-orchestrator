export const complexityValues = [
  'very-low',
  'low',
  'medium',
  'high',
  'very-high',
  'critical',
] as const;

export type ComplexityValue = (typeof complexityValues)[number];