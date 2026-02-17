import {
  Hash,
  Binary,
  Type,
  ToggleLeft,
  Calendar,
  Clock,
  Brackets,
  Braces,
  Map as MapIcon,
  HelpCircle,
  Fingerprint,
  DecimalsArrowRight,
} from "lucide-react";

/**
 * Shared type-to-icon mapping for DuckDB column types.
 * Used by ColumnsPanel, FileOverview, and other components that display column type icons.
 * Order matters — more specific patterns are matched first.
 */
export const TYPE_ICON_PATTERNS: Array<{
  pattern: RegExp;
  icon: React.ComponentType<{ size?: number }>;
}> = [
  // Array types (e.g., BIGINT[], VARCHAR[]) - must be first to catch before base types
  { pattern: /\[\]$/i, icon: Brackets },
  // Complex types - check before simpler types
  { pattern: /^UUID$/i, icon: Fingerprint },
  { pattern: /^MAP\b/i, icon: MapIcon },
  { pattern: /^STRUCT\b/i, icon: Braces },
  { pattern: /^LIST\b/i, icon: Brackets },
  { pattern: /^ARRAY\b/i, icon: Brackets },
  // JSON
  { pattern: /^JSON\b/i, icon: Braces },
  // Date/Time types
  { pattern: /^TIMESTAMP/i, icon: Clock },
  { pattern: /^DATE$/i, icon: Calendar },
  { pattern: /^TIME$/i, icon: Clock },
  { pattern: /^INTERVAL/i, icon: Clock },
  // Boolean
  { pattern: /^BOOL/i, icon: ToggleLeft },
  // Numeric - integers
  { pattern: /^(BIG|SMALL|TINY|HUGE)?INT/i, icon: Hash },
  { pattern: /^UBIGINT|UINTEGER|USMALLINT|UTINYINT|UHUGEINT/i, icon: Hash },
  // Numeric - floating point
  {
    pattern: /^(DOUBLE|FLOAT|REAL|DECIMAL|NUMERIC)/i,
    icon: DecimalsArrowRight,
  },
  // Text types
  { pattern: /^(VARCHAR|TEXT|STRING|CHAR)/i, icon: Type },
  // Binary
  { pattern: /^(BYTEA|BLOB|BIT)/i, icon: Binary },
];

export function getTypeIcon(
  type: string
): React.ComponentType<{ size?: number }> {
  const trimmed = type.trim();
  for (const { pattern, icon } of TYPE_ICON_PATTERNS) {
    if (pattern.test(trimmed)) return icon;
  }
  return HelpCircle;
}
