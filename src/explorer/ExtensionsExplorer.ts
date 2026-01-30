/**
 * Extensions Explorer
 * Tree view showing loaded DuckDB extensions
 */

import * as vscode from 'vscode';
import { getLoadedExtensions, ExtensionInfo } from '../services/databaseManager';

/**
 * Node types in the extensions tree
 */
export type ExtensionNodeType = 'extension' | 'action' | 'empty';

/**
 * Represents a node in the extensions tree
 */
export interface ExtensionNode {
  type: ExtensionNodeType;
  name: string;
  isLoaded?: boolean;
  isInstalled?: boolean;
  actionId?: string;
}

type QueryFn = (sql: string) => Promise<{ rows: Record<string, unknown>[] }>;

/**
 * TreeDataProvider for the Extensions panel
 */
export class ExtensionsExplorer implements vscode.TreeDataProvider<ExtensionNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ExtensionNode | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private queryFn: QueryFn) {}

  /**
   * Refresh the tree view
   */
  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  /**
   * Get tree item for display
   */
  getTreeItem(element: ExtensionNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      element.name,
      vscode.TreeItemCollapsibleState.None
    );

    item.contextValue = element.type;
    item.iconPath = this.getIcon(element);
    item.description = this.getDescription(element);
    item.tooltip = this.getTooltip(element);

    // Action nodes trigger commands
    if (element.type === 'action' && element.actionId) {
      item.command = {
        command: element.actionId,
        title: element.name,
      };
    }

    return item;
  }

  /**
   * Get children (root level only - flat list)
   */
  async getChildren(element?: ExtensionNode): Promise<ExtensionNode[]> {
    if (element) {
      // No nested children
      return [];
    }

    try {
      const extensions = await getLoadedExtensions(this.queryFn);
      
      if (extensions.length === 0) {
        return [{
          type: 'empty',
          name: 'No extensions loaded',
        }];
      }

      return extensions.map(ext => ({
        type: 'extension' as const,
        name: ext.name,
        isLoaded: ext.loaded,
        isInstalled: ext.installed,
      }));
    } catch (error) {
      console.error('🦆 Failed to get extensions:', error);
      return [{
        type: 'empty',
        name: 'Failed to load extensions',
      }];
    }
  }

  /**
   * Get icon for node
   */
  private getIcon(element: ExtensionNode): vscode.ThemeIcon | undefined {
    switch (element.type) {
      case 'extension':
        return element.isLoaded
          ? new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'))
          : new vscode.ThemeIcon('circle-outline');
      case 'action':
        return new vscode.ThemeIcon('add');
      case 'empty':
        return new vscode.ThemeIcon('info');
      default:
        return undefined;
    }
  }

  /**
   * Get description (shown to right of label)
   */
  private getDescription(element: ExtensionNode): string | undefined {
    if (element.type === 'extension') {
      return element.isLoaded ? 'loaded' : 'installed';
    }
    return undefined;
  }

  /**
   * Get tooltip
   */
  private getTooltip(element: ExtensionNode): string | undefined {
    if (element.type === 'extension') {
      return element.isLoaded
        ? `${element.name} (loaded and ready)`
        : `${element.name} (installed but not loaded)`;
    }
    return undefined;
  }
}
