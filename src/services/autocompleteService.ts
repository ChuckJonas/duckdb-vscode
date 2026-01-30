/**
 * SQL Autocomplete Service
 * Provides SQL completion suggestions using DuckDB's sql_auto_complete function
 */

export interface AutocompleteSuggestion {
  suggestion: string;
  suggestionStart: number;
}

/**
 * Get SQL autocomplete suggestions for the given text
 * @param queryFn Function to execute SQL queries
 * @param textUntilCursor The SQL text from start to cursor position
 * @returns Array of suggestions with their start positions
 */
export async function getAutocompleteSuggestions(
  queryFn: (sql: string) => Promise<Record<string, unknown>[]>,
  textUntilCursor: string
): Promise<AutocompleteSuggestion[]> {
  // Skip if empty or just whitespace
  if (!textUntilCursor.trim()) {
    return [];
  }

  // Escape single quotes for SQL
  const escapedText = textUntilCursor.replace(/'/g, "''");

  try {
    const rows = await queryFn(
      `SELECT suggestion, suggestion_start FROM sql_auto_complete('${escapedText}')`
    );

    if (!rows || rows.length === 0) {
      return [];
    }

    return rows.map(row => ({
      suggestion: row.suggestion as string,
      suggestionStart: row.suggestion_start as number,
    }));
  } catch (error) {
    console.error('🦆 Autocomplete query failed:', error);
    return [];
  }
}

/**
 * Determine the VS Code completion kind based on the suggestion
 */
export function inferCompletionKind(suggestion: string): 'keyword' | 'function' | 'field' {
  // All uppercase with only letters/underscores = keyword
  if (suggestion === suggestion.toUpperCase() && /^[A-Z_]+$/.test(suggestion)) {
    return 'keyword';
  }
  // Contains parenthesis = function
  if (suggestion.includes('(')) {
    return 'function';
  }
  // Default to field (table, column, etc.)
  return 'field';
}
