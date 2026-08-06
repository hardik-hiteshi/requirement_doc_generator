import { WORKFLOW_STEPS } from '@wdrg/contracts';
import { assertNoAccessibilityViolations } from '@wdrg/testing';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { WorkflowStepper } from './workflow-stepper';

describe('WorkflowStepper', () => {
  it('renders every workflow step', () => {
    render(<WorkflowStepper states={{}} currentStepId="project-details" />);

    const navigator = screen.getByRole('navigation', { name: /project workflow/i });
    expect(within(navigator).getAllByRole('listitem')).toHaveLength(WORKFLOW_STEPS.length);
  });

  it('marks the current step with aria-current so position is announced', () => {
    render(<WorkflowStepper states={{}} currentStepId="baseline-approval" />);

    const current = document.querySelector('[aria-current="step"]');
    expect(current).not.toBeNull();
    expect(current).toHaveTextContent('Baseline approval');
  });

  it('marks exactly one step as current', () => {
    render(<WorkflowStepper states={{}} currentStepId="clarifications" />);

    expect(document.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
  });

  it('defaults unlisted steps to locked', () => {
    render(
      <WorkflowStepper
        states={{ 'project-details': 'complete' }}
        currentStepId="project-details"
      />,
    );

    expect(screen.getByText('Complete')).toBeInTheDocument();
    // The nine remaining steps have no state supplied.
    expect(screen.getAllByText('Locked')).toHaveLength(WORKFLOW_STEPS.length - 1);
  });

  it('renders each state label as text, so meaning does not depend on colour', () => {
    render(
      <WorkflowStepper
        states={{
          'project-details': 'complete',
          'requirement-input': 'in_progress',
          'extraction-review': 'available',
        }}
        currentStepId="requirement-input"
      />,
    );

    expect(screen.getByText('Complete')).toBeInTheDocument();
    expect(screen.getByText('In progress')).toBeInTheDocument();
    expect(screen.getByText('Available')).toBeInTheDocument();
  });

  it('announces each step position for screen-reader users', () => {
    render(<WorkflowStepper states={{}} currentStepId="project-details" />);

    expect(
      screen.getByText(`Step 1 of ${WORKFLOW_STEPS.length}:`, { exact: false }),
    ).toBeInTheDocument();
  });

  it('has no automatically detectable accessibility violations', async () => {
    const { container } = render(<WorkflowStepper states={{}} currentStepId="project-details" />);

    await assertNoAccessibilityViolations(container);
  });
});
