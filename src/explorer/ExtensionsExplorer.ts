/**
 * Extensions Explorer
 * Tree view showing installed/loaded DuckDB extensions with auto-load status
 */

import * as vscode from "vscode";
import {
  getLoadedExtensions,
  ExtensionInfo,
} from "../services/databaseManager";
import { getAutoLoadExtensions } from "../services/databaseManager";

/**
 * Node types in the extensions tree
 */
export type ExtensionNodeType = "extension" | "action" | "empty";

/**
 * Represents a node in the extensions tree
 */
export interface ExtensionNode {
  type: ExtensionNodeType;
  name: string;
  isLoaded?: boolean;
  isInstalled?: boolean;
  isAutoLoad?: boolean;
  actionId?: string;
}

type QueryFn = (sql: string) => Promise<{ rows: Record<string, unknown>[] }>;

/**
 * TreeDataProvider for the Extensions panel
 */
export class ExtensionsExplorer
  implements vscode.TreeDataProvider<ExtensionNode>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    ExtensionNode | undefined | null | void
  >();
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

    // Set contextValue based on state so menus match correctly
    // Possible values: ext-loaded-autoload, ext-loaded, ext-installed-autoload, ext-installed
    item.contextValue = this.getContextValue(element);
    item.iconPath = this.getIcon(element);
    item.description = this.getDescription(element);
    item.tooltip = this.getTooltip(element);

    // Action nodes trigger commands
    if (element.type === "action" && element.actionId) {
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
      const autoLoadList = getAutoLoadExtensions();

      if (extensions.length === 0) {
        return [
          {
            type: "empty",
            name: "No extensions installed",
          },
        ];
      }

      return extensions.map((ext) => ({
        type: "extension" as const,
        name: ext.name,
        isLoaded: ext.loaded,
        isInstalled: ext.installed,
        isAutoLoad: autoLoadList.includes(ext.name),
      }));
    } catch (error) {
      console.error("🦆 Failed to get extensions:", error);
      return [
        {
          type: "empty",
          name: "Failed to load extensions",
        },
      ];
    }
  }

  /**
   * Get contextValue for menu matching.
   * Format: ext-{loaded|installed}[-autoload]
   */
  private getContextValue(element: ExtensionNode): string {
    if (element.type !== "extension") return element.type;

    const state = element.isLoaded ? "loaded" : "installed";
    const autoload = element.isAutoLoad ? "-autoload" : "";
    return `ext-${state}${autoload}`;
  }

  /**
   * Get icon for node
   */
  private getIcon(element: ExtensionNode): vscode.ThemeIcon | undefined {
    switch (element.type) {
      case "extension":
        if (element.isLoaded) {
          return new vscode.ThemeIcon(
            "check",
            new vscode.ThemeColor("charts.green")
          );
        }
        return new vscode.ThemeIcon("circle-outline");
      case "action":
        return new vscode.ThemeIcon("add");
      case "empty":
        return new vscode.ThemeIcon("info");
      default:
        return undefined;
    }
  }

  /**
   * Get description (shown to right of label)
   */
  private getDescription(element: ExtensionNode): string | undefined {
    if (element.type !== "extension") return undefined;

    const parts: string[] = [];
    parts.push(element.isLoaded ? "loaded" : "installed");
    if (element.isAutoLoad) {
      parts.push("auto-load");
    }
    return parts.join(" · ");
  }

  /**
   * Get tooltip
   */
  private getTooltip(
    element: ExtensionNode
  ): vscode.MarkdownString | undefined {
    if (element.type !== "extension") return undefined;

    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${element.name}**\n\n`);
    md.appendMarkdown(
      `Status: ${
        element.isLoaded ? "$(check) Loaded" : "$(circle-outline) Installed"
      }\n\n`
    );
    md.appendMarkdown(
      `Auto-load: ${element.isAutoLoad ? "$(check) Yes" : "$(close) No"}\n\n`
    );
    if (!element.isAutoLoad) {
      md.appendMarkdown(`*Right-click → Add to Auto-load to load on startup*`);
    }
    return md;
  }
}
