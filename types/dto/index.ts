/**
 * Barrel re-export for @/types/dto.
 *
 * Prefer importing individual modules (`@/types/dto/result`, etc.) over this
 * barrel when bundle size matters — Zod is tree-shakeable, but barrel files
 * defeat tree-shaking for consumers that import a single symbol through them.
 */
export * from './result';
export * from './schemas';
