import React, { useMemo } from 'react';

interface FuzzyHighlightProps {
  text: string;
  indices: Set<number>;
}

/**
 * Renders text with fuzzy-matched characters highlighted,
 * matching VS Code's command palette style.
 * Groups consecutive highlighted characters into single <span> elements.
 */
export function FuzzyHighlight({ text, indices }: FuzzyHighlightProps) {
  const nodes = useMemo(() => {
    if (indices.size === 0) return [text];

    const result: React.ReactNode[] = [];
    let i = 0;

    while (i < text.length) {
      if (indices.has(i)) {
        // Collect consecutive highlighted characters
        let end = i;
        while (end < text.length && indices.has(end)) end++;
        result.push(
          <span key={i} className="fuzzy-highlight">
            {text.slice(i, end)}
          </span>
        );
        i = end;
      } else {
        // Collect consecutive non-highlighted characters
        let end = i;
        while (end < text.length && !indices.has(end)) end++;
        result.push(text.slice(i, end));
        i = end;
      }
    }

    return result;
  }, [text, indices]);

  return <>{nodes}</>;
}

/** Empty set constant to avoid re-creating when there's no filter active */
export const EMPTY_POSITIONS = new Set<number>();
