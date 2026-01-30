import React, { useMemo } from 'react';

/**
 * Lightweight JSON syntax highlighter
 * No external dependencies - uses regex-based tokenization
 */
export function JsonSyntaxHighlight({ json }: { json: string }) {
  const highlighted = useMemo(() => {
    const tokenRegex = /("(?:\\.|[^"\\])*")\s*:|("(?:\\.|[^"\\])*")|(\b(?:true|false|null)\b)|(-?\d+\.?\d*(?:[eE][+-]?\d+)?)/g;
    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    let match;
    let key = 0;
    
    while ((match = tokenRegex.exec(json)) !== null) {
      // Add text before match
      if (match.index > lastIndex) {
        parts.push(json.slice(lastIndex, match.index));
      }
      
      if (match[1]) {
        // Property key (string followed by colon)
        parts.push(<span key={key++} className="json-key">{match[1]}</span>);
        parts.push(':');
      } else if (match[2]) {
        // String value
        parts.push(<span key={key++} className="json-string">{match[2]}</span>);
      } else if (match[3]) {
        // Boolean or null
        parts.push(<span key={key++} className="json-bool">{match[3]}</span>);
      } else if (match[4]) {
        // Number
        parts.push(<span key={key++} className="json-number">{match[4]}</span>);
      }
      
      lastIndex = match.index + match[0].length;
    }
    
    // Add remaining text
    if (lastIndex < json.length) {
      parts.push(json.slice(lastIndex));
    }
    
    return parts;
  }, [json]);
  
  return <>{highlighted}</>;
}
