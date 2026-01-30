import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryPanel } from './QueryPanel';
import type { MultiQueryResultWithPages } from './types';

// VS Code API for communicating with extension
declare const acquireVsCodeApi: () => {
  postMessage: (message: unknown) => void;
  getState: () => unknown;
  setState: (state: unknown) => void;
};

const vscode = acquireVsCodeApi();

// Expose vscode API globally for child components
(window as unknown as { vscodeApi: typeof vscode }).vscodeApi = vscode;

interface AppState {
  result: MultiQueryResultWithPages | null;
  pageSize: number;
  maxCopyRows: number;
}

function App() {
  const [state, setState] = React.useState<AppState>({
    result: null,
    pageSize: 1000,
    maxCopyRows: 50000,
  });

  React.useEffect(() => {
    // Listen for messages from extension
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      if (message.type === 'queryResult') {
        setState({
          result: message.data,
          pageSize: message.pageSize || 1000,
          maxCopyRows: message.maxCopyRows || 50000,
        });
      }
    };

    window.addEventListener('message', handleMessage);
    
    // Signal ready to receive data
    vscode.postMessage({ type: 'ready' });

    return () => window.removeEventListener('message', handleMessage);
  }, []);

  if (!state.result) {
    return (
      <div className="loading">
        <span>Loading results...</span>
      </div>
    );
  }

  return (
    <QueryPanel 
      result={state.result} 
      pageSize={state.pageSize}
      maxCopyRows={state.maxCopyRows}
    />
  );
}

// Mount React app
const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<App />);
}
