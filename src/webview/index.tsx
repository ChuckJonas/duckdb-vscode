import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryPanel } from './QueryPanel';
import { FileOverview } from './FileOverview';
import type { MultiQueryResultWithPages, DataOverviewMetadata } from './types';

// VS Code API for communicating with extension
declare const acquireVsCodeApi: () => {
  postMessage: (message: unknown) => void;
  getState: () => unknown;
  setState: (state: unknown) => void;
};

const vscode = acquireVsCodeApi();

// Expose vscode API globally for child components
(window as unknown as { vscodeApi: typeof vscode }).vscodeApi = vscode;

type ViewMode = 'loading' | 'fileOverview' | 'results';

interface AppState {
  viewMode: ViewMode;
  loadingMessage: string;
  result: MultiQueryResultWithPages | null;
  fileMetadata: DataOverviewMetadata | null;
  pageSize: number;
  maxCopyRows: number;
}

function App() {
  const [state, setState] = React.useState<AppState>({
    viewMode: 'loading',
    loadingMessage: 'Loading…',
    result: null,
    fileMetadata: null,
    pageSize: 1000,
    maxCopyRows: 50000,
  });

  React.useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      if (message.type === 'queryResult') {
        setState(prev => ({
          ...prev,
          viewMode: 'results',
          result: message.data,
          pageSize: message.pageSize || prev.pageSize,
          maxCopyRows: message.maxCopyRows || prev.maxCopyRows,
        }));
      } else if (message.type === 'fileMetadata') {
        setState(prev => ({
          ...prev,
          viewMode: 'fileOverview',
          fileMetadata: message.data,
          pageSize: message.pageSize || prev.pageSize,
          maxCopyRows: message.maxCopyRows || prev.maxCopyRows,
        }));
      } else if (message.type === 'loadingStatus') {
        setState(prev => ({
          ...prev,
          viewMode: 'loading',
          loadingMessage: message.message || 'Loading…',
        }));
      } else if (message.type === 'queryError') {
        setState(prev => ({
          ...prev,
          viewMode: 'loading',
          loadingMessage: `Error: ${message.error}`,
        }));
      }
    };

    window.addEventListener('message', handleMessage);
    
    // Signal ready to receive data
    vscode.postMessage({ type: 'ready' });

    return () => window.removeEventListener('message', handleMessage);
  }, []);

  if (state.viewMode === 'loading') {
    const isError = state.loadingMessage.startsWith('Error:');
    return (
      <div className="loading">
        {!isError && <div className="loading-spinner" />}
        <span className={isError ? 'loading-error' : 'loading-text'}>{state.loadingMessage}</span>
      </div>
    );
  }

  if (state.viewMode === 'fileOverview' && state.fileMetadata) {
    return <FileOverview metadata={state.fileMetadata} />;
  }

  if (state.viewMode === 'results' && state.result) {
    const showBackButton = state.fileMetadata !== null;
    return (
      <QueryPanel 
        result={state.result} 
        pageSize={state.pageSize}
        maxCopyRows={state.maxCopyRows}
        onBackToOverview={showBackButton ? () => {
          setState(prev => ({ ...prev, viewMode: 'fileOverview' }));
        } : undefined}
      />
    );
  }

  return (
    <div className="loading">
      <div className="loading-spinner" />
      <span className="loading-text">Loading…</span>
    </div>
  );
}

// Mount React app
const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<App />);
}
