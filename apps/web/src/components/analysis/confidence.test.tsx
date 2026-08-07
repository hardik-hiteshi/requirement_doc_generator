import { MODEL_CONFIDENCE_LABEL, type EvidenceConfidence } from '@wdrg/contracts';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { EvidenceConfidenceBadge, ModelConfidenceNote } from './confidence';

/**
 * The two confidences, and the difference between them.
 *
 * This is the place a user is most easily misled: two numbers that look
 * identical and mean entirely different things. The evidence score is
 * calculated by the application and governs approval; the model's is its own
 * opinion and governs nothing. These tests exist to make that distinction hard
 * to erode by accident.
 */

function confidence(overrides: Partial<EvidenceConfidence> = {}): EvidenceConfidence {
  return {
    score: 0.85,
    band: 'high',
    contributions: [
      {
        signal: 'verbatim_support',
        weight: 0.3,
        explanation: 'The quoted wording was found in the document, exactly as cited.',
      },
      {
        signal: 'ocr_sourced',
        weight: -0.08,
        explanation: 'Read from a scanned image rather than a text layer.',
      },
    ],
    ruleVersion: 'v1',
    calculatedAt: '2026-08-07T10:00:00.000Z',
    ...overrides,
  };
}

describe('EvidenceConfidenceBadge', () => {
  it('shows the band as words, not only as a colour', () => {
    render(<EvidenceConfidenceBadge confidence={confidence()} />);

    expect(screen.getByText('Well evidenced')).toBeInTheDocument();
    expect(screen.getByText('85%')).toBeInTheDocument();
  });

  it('explains the score when asked, listing every contribution', async () => {
    // The score *is* this list. A reviewer who cannot see why it is what it is
    // has to either trust it blindly or ignore it.
    const user = userEvent.setup();

    render(<EvidenceConfidenceBadge confidence={confidence()} />);
    await user.click(screen.getByRole('button'));

    expect(screen.getByText(/found in the document, exactly as cited/i)).toBeInTheDocument();
    expect(screen.getByText(/scanned image/i)).toBeInTheDocument();
  });

  it('says the score came from the documents rather than from the model', async () => {
    const user = userEvent.setup();

    render(<EvidenceConfidenceBadge confidence={confidence()} />);
    await user.click(screen.getByRole('button'));

    expect(screen.getByText(/not by the AI model/i)).toBeInTheDocument();
  });

  it('says plainly when a requirement is not evidenced at all', () => {
    render(
      <EvidenceConfidenceBadge
        confidence={confidence({ score: 0, band: 'unsupported', contributions: [] })}
      />,
    );

    expect(screen.getByText('Not evidenced')).toBeInTheDocument();
  });
});

describe('ModelConfidenceNote', () => {
  it('labels the number as an AI self-assessment', () => {
    render(<ModelConfidenceNote confidence={{ value: 0.95 }} />);

    expect(screen.getByText(MODEL_CONFIDENCE_LABEL)).toBeInTheDocument();
    expect(screen.getByText('95%')).toBeInTheDocument();
  });

  it('carries the caveat next to the number, not somewhere else', () => {
    // A reader who sees "95%" and not the warning has been misled, and a
    // footnote elsewhere does not undo that.
    render(<ModelConfidenceNote confidence={{ value: 0.95 }} />);

    expect(screen.getByText(/not a probability/i)).toBeInTheDocument();
    expect(screen.getByText(/does not affect approval/i)).toBeInTheDocument();
  });

  it('renders nothing when the model gave no confidence', () => {
    const { container } = render(<ModelConfidenceNote />);

    expect(container).toBeEmptyDOMElement();
  });
});
