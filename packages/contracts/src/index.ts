/**
 * `@wdrg/contracts` is the single source of truth for anything that crosses the
 * web <-> api boundary: the HTTP envelope, the error model, health payloads and
 * the project domain vocabulary.
 *
 * Nothing in this package may import from `apps/*`. It must stay runtime-neutral
 * (no Node or DOM APIs) so it can be consumed by both the NestJS server and the
 * Next.js client bundle.
 */
export * from './http/headers';
export * from './http/api-routes';
export * from './http/api-error';
export * from './health/health.contract';
export * from './workflow/workflow-steps';

/* Phase 2 — public workspace and anonymous project lifecycle. */
export * from './project/project-identifiers';
export * from './project/project-status';
export * from './project/project-type.contract';
export * from './project/timeline.contract';
export * from './project/start-date.contract';
export * from './project/team-capacity.contract';
export * from './project/output-preferences.contract';
export * from './project/project.contract';
export * from './project/project-access.contract';
export * from './project/project-routes';
export * from './project/project-errors';
export * from './project/audit.contract';

/* Phase 3 — requirement ingestion: upload, storage, extraction and OCR. */
export * from './requirements/source-status';
export * from './requirements/source-formats';
export * from './requirements/extracted-content.contract';
export * from './requirements/requirement-source.contract';
export * from './requirements/requirement-errors';
export * from './requirements/requirement-routes';
export * from './requirements/evidence-boundary';

/* Phase 4 — requirement analysis. */
export * from './analysis/ai-task.contract';
export * from './analysis/model-profile.contract';
export * from './analysis/inference-endpoint.contract';
export * from './analysis/analysis-limits';
export * from './analysis/requirement-item.contract';
export * from './analysis/analysis-run.contract';
export * from './analysis/findings.contract';
export * from './analysis/clarification.contract';
export * from './analysis/baseline.contract';
export * from './analysis/evidence-confidence';
export * from './analysis/conflict-reevaluation';
export * from './analysis/baseline-calculations';
export * from './analysis/analysis-routes';
export * from './analysis/analysis-errors';

/* Phase 5 — technology-stack recommendation, review and locking. */
export * from './stack/technology-category.contract';
export * from './stack/technology-catalog.contract';
export * from './stack/technology-catalog.data';
export * from './stack/project-type-categories';
export * from './stack/stack-authority.contract';
export * from './stack/stack-component.contract';
export * from './stack/stack-evidence';
export * from './stack/compatibility.contract';
export * from './stack/stack-blockers';
export * from './stack/stack-snapshot.contract';
export * from './stack/downstream-authority.contract';
export * from './stack/recommendation-run.contract';
export * from './stack/stack-routes';
export * from './stack/stack-errors';
