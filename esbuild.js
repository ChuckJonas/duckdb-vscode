const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/**
 * Build configuration for the VS Code extension (Node.js)
 */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: "node",
  outfile: "out/extension.js",
  external: [
    "vscode",
    "@duckdb/node-api",
    "@duckdb/node-bindings",
    "@duckdb/node-bindings-*",
  ],
  logLevel: "info",
  plugins: [esbuildProblemMatcherPlugin("extension")],
};

/**
 * Build configuration for the Results webview (Browser/React)
 */
const webviewConfig = {
  entryPoints: ["src/webview/index.tsx"],
  bundle: true,
  format: "iife",
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: "browser",
  outfile: "out/webview/results.js",
  logLevel: "info",
  loader: {
    ".css": "text",
  },
  plugins: [cssPlugin(), esbuildProblemMatcherPlugin("webview")],
};

/**
 * Build configuration for VS Code integration tests (Mocha-based)
 * These are compiled separately from unit tests (which use node:test)
 */
const integrationTestConfig = {
  entryPoints: ["src/test/integration/extension.test.ts"],
  bundle: false,
  format: "cjs",
  sourcemap: true,
  platform: "node",
  outdir: "out/test/integration",
  logLevel: "info",
};

async function main() {
  const extensionCtx = await esbuild.context(extensionConfig);
  const webviewCtx = await esbuild.context(webviewConfig);
  const testCtx = production
    ? null
    : await esbuild.context(integrationTestConfig);

  if (watch) {
    const watchers = [extensionCtx.watch(), webviewCtx.watch()];
    if (testCtx) {
      watchers.push(testCtx.watch());
    }
    await Promise.all(watchers);
  } else {
    const builders = [extensionCtx.rebuild(), webviewCtx.rebuild()];
    if (testCtx) {
      builders.push(testCtx.rebuild());
    }
    await Promise.all(builders);
    await extensionCtx.dispose();
    await webviewCtx.dispose();
    if (testCtx) {
      await testCtx.dispose();
    }
  }
}

/**
 * Plugin to handle CSS imports - injects styles into document
 */
function cssPlugin() {
  return {
    name: "css-plugin",
    setup(build) {
      build.onLoad({ filter: /\.css$/ }, async (args) => {
        const fs = require("fs");
        const css = await fs.promises.readFile(args.path, "utf8");
        return {
          contents: `
            const style = document.createElement('style');
            style.textContent = ${JSON.stringify(css)};
            document.head.appendChild(style);
          `,
          loader: "js",
        };
      });
    },
  };
}

/**
 * Plugin to report errors in VS Code problem matcher format
 */
function esbuildProblemMatcherPlugin(name) {
  return {
    name: "esbuild-problem-matcher",
    setup(build) {
      build.onStart(() => {
        console.log(`[esbuild:${name}] Build started...`);
      });
      build.onEnd((result) => {
        result.errors.forEach(({ text, location }) => {
          console.error(`✘ [ERROR] ${text}`);
          if (location) {
            console.error(
              `    ${location.file}:${location.line}:${location.column}:`
            );
          }
        });
        console.log(`[esbuild:${name}] Build finished.`);
      });
    },
  };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
