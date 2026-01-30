/**
 * Query History Explorer
 * Tree view showing past queries grouped by date
 */

import * as vscode from 'vscode';
import { HistoryEntry, getHistoryService } from '../services/historyService';

/**
 * Node types in the history tree
 */
export type HistoryNodeType = 'date-group' | 'query' | 'empty';

/**
 * Represents a node in the history tree
 */
export interface HistoryNode {
  type: HistoryNodeType;
  label: string;
  entry?: HistoryEntry;      // For query nodes
  dateGroup?: string;        // For date group nodes
}

/**
 * TreeDataProvider for the Query History panel
 */
export class HistoryExplorer implements vscode.TreeDataProvider<HistoryNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<HistoryNode | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor() {
    // Listen for history changes
    getHistoryService().onDidChange(() => {
      this.refresh();
    });
  }

  /**
   * Refresh the tree view
   */
  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  /**
   * Get tree item for display
   */
  getTreeItem(element: HistoryNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      element.label,
      this.getCollapsibleState(element)
    );

    item.contextValue = element.type;
    item.iconPath = this.getIcon(element);
    item.tooltip = this.getTooltip(element);
    item.description = this.getDescription(element);

    // Make query nodes clickable to run
    if (element.type === 'query' && element.entry) {
      item.command = {
        command: 'duckdb.history.runAgain',
        title: 'Run Again',
        arguments: [element],
      };
    }

    return item;
  }

  /**
   * Get children of a node
   */
  async getChildren(element?: HistoryNode): Promise<HistoryNode[]> {
    const historyService = getHistoryService();

    if (!element) {
      // Root level: date groups
      const groups = historyService.getEntriesGroupedByDate();
      
      if (groups.size === 0) {
        return [{
          type: 'empty',
          label: 'No queries yet',
        }];
      }

      // Return date groups in order
      const nodes: HistoryNode[] = [];
      for (const [dateGroup, entries] of groups) {
        nodes.push({
          type: 'date-group',
          label: dateGroup,
          dateGroup,
        });
      }
      return nodes;
    }

    if (element.type === 'date-group' && element.dateGroup) {
      // Children of date group: query entries
      const groups = historyService.getEntriesGroupedByDate();
      const entries = groups.get(element.dateGroup) || [];

      return entries.map(entry => ({
        type: 'query' as const,
        label: this.formatQueryLabel(entry),
        entry,
      }));
    }

    return [];
  }

  /**
   * Format query label for display
   */
  private formatQueryLabel(entry: HistoryEntry): string {
    // Format time
    const time = entry.executedAt.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

    // Truncate SQL to ~40 chars
    let sql = entry.sql.replace(/\s+/g, ' ').trim();
    if (sql.length > 40) {
      sql = sql.substring(0, 40) + '…';
    }

    return `${time}  ${sql}`;
  }

  /**
   * Get description (shown to right of label)
   */
  private getDescription(element: HistoryNode): string | undefined {
    if (element.type === 'query' && element.entry) {
      const entry = element.entry;
      
      if (entry.error) {
        return '❌';
      }
      
      if (entry.rowCount !== null) {
        const rows = this.formatNumber(entry.rowCount);
        const duration = entry.durationMs < 1000 
          ? `${Math.round(entry.durationMs)}ms`
          : `${(entry.durationMs / 1000).toFixed(1)}s`;
        return `${rows} rows · ${duration}`;
      }
      
      return '✓';
    }

    if (element.type === 'date-group') {
      const groups = getHistoryService().getEntriesGroupedByDate();
      const count = groups.get(element.dateGroup!)?.length || 0;
      return `${count}`;
    }

    return undefined;
  }

  /**
   * Format number with K/M suffix
   */
  private formatNumber(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  }

  /**
   * Get collapsible state
   */
  private getCollapsibleState(element: HistoryNode): vscode.TreeItemCollapsibleState {
    if (element.type === 'date-group') {
      // Expand "Today" by default
      return element.dateGroup === 'Today'
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed;
    }
    return vscode.TreeItemCollapsibleState.None;
  }

  /**
   * Get icon for node
   */
  private getIcon(element: HistoryNode): vscode.ThemeIcon | undefined {
    switch (element.type) {
      case 'date-group':
        return new vscode.ThemeIcon('calendar');
      case 'query':
        if (element.entry?.error) {
          return new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
        }
        return new vscode.ThemeIcon('play');
      case 'empty':
        return new vscode.ThemeIcon('info');
      default:
        return undefined;
    }
  }

  /**
   * Get tooltip
   */
  private getTooltip(element: HistoryNode): vscode.MarkdownString | string | undefined {
    if (element.type === 'query' && element.entry) {
      const entry = element.entry;
      const md = new vscode.MarkdownString();
      
      // Format SQL with syntax highlighting
      md.appendCodeblock(entry.sql, 'sql');
      
      md.appendMarkdown('\n---\n');
      md.appendMarkdown(`**Time:** ${entry.executedAt.toLocaleString()}\n\n`);
      md.appendMarkdown(`**Database:** ${entry.databaseName}\n\n`);
      
      if (entry.error) {
        md.appendMarkdown(`**Error:** ${entry.error}\n\n`);
      } else {
        md.appendMarkdown(`**Rows:** ${entry.rowCount ?? 'N/A'}\n\n`);
        md.appendMarkdown(`**Duration:** ${entry.durationMs.toFixed(1)}ms\n\n`);
      }
      
      if (entry.sourceFile) {
        md.appendMarkdown(`**Source:** ${entry.sourceFile}\n\n`);
      }
      
      return md;
    }
    
    return undefined;
  }
}
