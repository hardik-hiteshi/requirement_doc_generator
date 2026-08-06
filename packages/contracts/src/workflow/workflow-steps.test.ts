import { describe, expect, it } from 'vitest';

import {
  WORKFLOW_STEPS,
  WORKFLOW_STEP_IDS,
  getWorkflowStep,
  type WorkflowStepId,
} from './workflow-steps';

describe('WORKFLOW_STEPS', () => {
  it('defines exactly one entry per declared step id', () => {
    expect(WORKFLOW_STEPS).toHaveLength(WORKFLOW_STEP_IDS.length);
    expect(WORKFLOW_STEPS.map((step) => step.id)).toEqual([...WORKFLOW_STEP_IDS]);
  });

  it('is ordered contiguously from 1', () => {
    WORKFLOW_STEPS.forEach((step, index) => {
      expect(step.order).toBe(index + 1);
    });
  });

  it('gives every step a title and summary', () => {
    for (const step of WORKFLOW_STEPS) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.summary.length).toBeGreaterThan(0);
    }
  });

  it('starts at project details and ends at export', () => {
    expect(WORKFLOW_STEPS.at(0)?.id).toBe('project-details');
    expect(WORKFLOW_STEPS.at(-1)?.id).toBe('export-recovery');
  });
});

describe('getWorkflowStep', () => {
  it('resolves a known step', () => {
    expect(getWorkflowStep('baseline-approval').order).toBe(6);
  });

  it('throws on an unknown step', () => {
    expect(() => getWorkflowStep('not-a-step' as WorkflowStepId)).toThrow(/Unknown workflow step/);
  });
});
