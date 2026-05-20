import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryPanel } from './QueryPanel';
import { FileOverview } from './FileOverview';
import { ContainerOverview } from './ContainerOverview';
import type { MultiQueryResultWithPages, DataOverviewMetadata, ContainerOverviewMetadata } from './types';

// VS Code API for communicating with extension
declare const acquireVsCodeApi: () => {
  postMessage: (message: unknown) => void;
  getState: () => unknown;
  setState: (state: unknown) => void;
};

const vscode = acquireVsCodeApi();

// Expose vscode API globally for child components
(window as unknown as { vscodeApi: typeof vscode }).vscodeApi = vscode;

type ViewMode = 'loading' | 'containerOverview' | 'fileOverview' | 'results';

interface AppState {
  viewMode: ViewMode;
  loadingMessage: string;
  result: MultiQueryResultWithPages | null;
  fileMetadata: DataOverviewMetadata | null;
  containerMetadata: ContainerOverviewMetadata | null;
  pageSize: number;
  maxCopyRows: number;
  /** True when the current cache reflects the full source and write-back is supported. */
  editable: boolean;
}

function App() {
  const [state, setState] = React.useState<AppState>({
    viewMode: 'loading',
    loadingMessage: 'Loading…',
    result: null,
    fileMetadata: null,
    containerMetadata: null,
    pageSize: 1000,
    maxCopyRows: 50000,
    editable: false,
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
          editable: message.editable === true,
        }));
      } else if (message.type === 'fileMetadata') {
        // `silent: true` means the host pre-loaded metadata while jumping
        // straight into the data view — we record it (so "Back to Overview"
        // works) but don't change the visible view.
        setState(prev => ({
          ...prev,
          viewMode: message.silent ? prev.viewMode : 'fileOverview',
          fileMetadata: message.data,
          pageSize: message.pageSize || prev.pageSize,
          maxCopyRows: message.maxCopyRows || prev.maxCopyRows,
        }));
      } else if (message.type === 'containerMetadata') {
        setState(prev => ({
          ...prev,
          viewMode: 'containerOverview',
          containerMetadata: message.data,
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
    const canFallBackToSchema = isError && state.fileMetadata !== null;
    return (
      <div className="loading">
        {!isError && <div className="loading-spinner" />}
        <span className={isError ? 'loading-error' : 'loading-text'}>{state.loadingMessage}</span>
        {canFallBackToSchema && (
          <button
            className="btn btn-surface"
            onClick={() => setState(prev => ({ ...prev, viewMode: 'fileOverview' }))}
          >
            Back to Schema
          </button>
        )}
      </div>
    );
  }

  if (state.viewMode === 'containerOverview' && state.containerMetadata) {
    return <ContainerOverview metadata={state.containerMetadata} />;
  }

  if (state.viewMode === 'fileOverview' && state.fileMetadata) {
    const hasContainer = state.containerMetadata !== null;
    return (
      <FileOverview
        metadata={state.fileMetadata}
        onBackToContainer={hasContainer ? () => {
          vscode.postMessage({ type: 'backToContainer' });
          setState(prev => ({ ...prev, viewMode: 'containerOverview' }));
        } : undefined}
      />
    );
  }

  if (state.viewMode === 'results' && state.result) {
    const showBackButton = state.fileMetadata !== null;
    return (
      <QueryPanel
        result={state.result}
        pageSize={state.pageSize}
        maxCopyRows={state.maxCopyRows}
        editable={state.editable}
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
