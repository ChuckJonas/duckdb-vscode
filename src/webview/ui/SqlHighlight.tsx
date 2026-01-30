import React, { useMemo } from 'react';

/**
 * Lightweight SQL syntax highlighter
 * No external dependencies - uses tokenization approach
 */

const SQL_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'AS',
  'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'ON', 'USING',
  'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'ALL', 'DISTINCT',
  'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE', 'DROP', 'ALTER',
  'TABLE', 'INDEX', 'VIEW', 'SCHEMA', 'DATABASE', 'IF', 'EXISTS', 'CASCADE',
  'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'CONSTRAINT', 'DEFAULT', 'UNIQUE',
  'CHECK', 'BETWEEN', 'LIKE', 'ILIKE', 'SIMILAR', 'TO', 'CASE', 'WHEN', 'THEN',
  'ELSE', 'END', 'CAST', 'NULLS', 'FIRST', 'LAST', 'ASC', 'DESC', 'WITH',
  'RECURSIVE', 'OVER', 'PARTITION', 'WINDOW', 'ROWS', 'RANGE', 'UNBOUNDED',
  'PRECEDING', 'FOLLOWING', 'CURRENT', 'ROW', 'FILTER', 'WITHIN', 'LATERAL',
  'NATURAL', 'EXCEPT', 'INTERSECT', 'RETURNING', 'CONFLICT', 'DO', 'NOTHING',
  'COALESCE', 'NULLIF', 'GREATEST', 'LEAST', 'TRUE', 'FALSE', 'BOOLEAN',
  'INTEGER', 'BIGINT', 'SMALLINT', 'REAL', 'DOUBLE', 'DECIMAL', 'NUMERIC',
  'VARCHAR', 'TEXT', 'CHAR', 'DATE', 'TIME', 'TIMESTAMP', 'INTERVAL', 'JSON',
  'ATTACH', 'DETACH', 'USE', 'COPY', 'EXPORT', 'IMPORT', 'INSTALL', 'LOAD',
  'DESCRIBE', 'SHOW', 'EXPLAIN', 'ANALYZE', 'BEGIN', 'COMMIT', 'ROLLBACK',
  'TRANSACTION', 'READ', 'ONLY', 'WRITE', 'REPLACE', 'TEMPORARY', 'TEMP',
]);

interface Token {
  type: 'keyword' | 'string' | 'identifier' | 'number' | 'comment' | 'function' | 'text';
  value: string;
}

function tokenizeSql(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  
  while (i < sql.length) {
    // Comments: -- single line
    if (sql.slice(i, i + 2) === '--') {
      const end = sql.indexOf('\n', i);
      const comment = end === -1 ? sql.slice(i) : sql.slice(i, end);
      tokens.push({ type: 'comment', value: comment });
      i += comment.length;
      continue;
    }
    
    // Comments: /* multi line */
    if (sql.slice(i, i + 2) === '/*') {
      const end = sql.indexOf('*/', i);
      const comment = end === -1 ? sql.slice(i) : sql.slice(i, end + 2);
      tokens.push({ type: 'comment', value: comment });
      i += comment.length;
      continue;
    }
    
    // Strings: 'single quoted'
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2; // escaped quote
        } else if (sql[j] === "'") {
          j++;
          break;
        } else {
          j++;
        }
      }
      tokens.push({ type: 'string', value: sql.slice(i, j) });
      i = j;
      continue;
    }
    
    // Identifiers: "double quoted"
    if (sql[i] === '"') {
      let j = i + 1;
      while (j < sql.length && sql[j] !== '"') j++;
      if (j < sql.length) j++; // include closing quote
      tokens.push({ type: 'identifier', value: sql.slice(i, j) });
      i = j;
      continue;
    }
    
    // Numbers
    if (/\d/.test(sql[i]) || (sql[i] === '.' && /\d/.test(sql[i + 1] || ''))) {
      let j = i;
      while (j < sql.length && /[\d.eE+-]/.test(sql[j])) j++;
      tokens.push({ type: 'number', value: sql.slice(i, j) });
      i = j;
      continue;
    }
    
    // Words (keywords, identifiers, functions)
    if (/[a-zA-Z_]/.test(sql[i])) {
      let j = i;
      while (j < sql.length && /[a-zA-Z0-9_]/.test(sql[j])) j++;
      const word = sql.slice(i, j);
      const upper = word.toUpperCase();
      
      // Check if it's a function (followed by open paren)
      const afterWord = sql.slice(j).match(/^\s*\(/);
      
      if (SQL_KEYWORDS.has(upper)) {
        tokens.push({ type: 'keyword', value: word });
      } else if (afterWord) {
        tokens.push({ type: 'function', value: word });
      } else {
        tokens.push({ type: 'text', value: word });
      }
      i = j;
      continue;
    }
    
    // Other characters (operators, punctuation, whitespace)
    tokens.push({ type: 'text', value: sql[i] });
    i++;
  }
  
  return tokens;
}

export function SqlSyntaxHighlight({ sql }: { sql: string }) {
  const parts = useMemo(() => {
    const tokens = tokenizeSql(sql);
    return tokens.map((token, idx) => {
      switch (token.type) {
        case 'keyword':
          return <span key={idx} className="sql-keyword">{token.value}</span>;
        case 'string':
          return <span key={idx} className="sql-string">{token.value}</span>;
        case 'identifier':
          return <span key={idx} className="sql-identifier">{token.value}</span>;
        case 'number':
          return <span key={idx} className="sql-number">{token.value}</span>;
        case 'comment':
          return <span key={idx} className="sql-comment">{token.value}</span>;
        case 'function':
          return <span key={idx} className="sql-function">{token.value}</span>;
        default:
          return <React.Fragment key={idx}>{token.value}</React.Fragment>;
      }
    });
  }, [sql]);
  
  return <>{parts}</>;
}

/**
 * For inline preview: tokenize, highlight, then collapse whitespace
 * Returns React nodes (no dangerouslySetInnerHTML needed)
 */
export function SqlPreview({ sql, maxLength = 200 }: { sql: string; maxLength?: number }) {
  const parts = useMemo(() => {
    const tokens = tokenizeSql(sql);
    const result: React.ReactNode[] = [];
    let totalLength = 0;
    let truncated = false;
    
    for (let idx = 0; idx < tokens.length && !truncated; idx++) {
      const token = tokens[idx];
      // Collapse whitespace for preview
      const value = token.type === 'text' 
        ? token.value.replace(/\s+/g, ' ')
        : token.value.replace(/\s+/g, ' ');
      
      if (totalLength + value.length > maxLength) {
        const remaining = maxLength - totalLength;
        const truncatedValue = value.slice(0, remaining);
        if (truncatedValue.trim()) {
          result.push(renderToken(token.type, truncatedValue, idx));
        }
        result.push(<React.Fragment key="ellipsis">...</React.Fragment>);
        truncated = true;
      } else {
        if (value) {
          result.push(renderToken(token.type, value, idx));
        }
        totalLength += value.length;
      }
    }
    
    return result;
  }, [sql, maxLength]);
  
  return <>{parts}</>;
}

function renderToken(type: Token['type'], value: string, key: number): React.ReactNode {
  switch (type) {
    case 'keyword':
      return <span key={key} className="sql-keyword">{value}</span>;
    case 'string':
      return <span key={key} className="sql-string">{value}</span>;
    case 'identifier':
      return <span key={key} className="sql-identifier">{value}</span>;
    case 'number':
      return <span key={key} className="sql-number">{value}</span>;
    case 'comment':
      return <span key={key} className="sql-comment">{value}</span>;
    case 'function':
      return <span key={key} className="sql-function">{value}</span>;
    default:
      return <React.Fragment key={key}>{value}</React.Fragment>;
  }
}
