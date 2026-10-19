/**
 * Opt-in benchmark against an existing local database. No data is imported or
 * modified. Usage: npm run benchmark:catalog -- /path/to/file.duckdb [schema]
 */
import { DuckDBInstance } from "@duckdb/node-api";
import { performance } from "node:perf_hooks";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CatalogService, sqlString } from "../src/services/catalogService";

async function main() {
  const [databasePath, schema = "main"] = process.argv.slice(2);
  if (!databasePath) {
    throw new Error(
      "Usage: npm run benchmark:catalog -- /path/to/file.duckdb [schema]",
    );
  }
  const file = await fs.realpath(databasePath);
  const storagePath = await fs.mkdtemp(
    path.join(os.tmpdir(), "duckdb-catalog-benchmark-"),
  );
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  let queries = 0;
  const query = async (sql: string) => {
    queries++;
    return (await connection.runAndReadAll(sql)).getRowObjectsJS();
  };
  const samples: {
    run: number;
    operation: string;
    ms: number;
    queries: number;
  }[] = [];
  const services: CatalogService[] = [];
  const measure = async <T>(
    run: number,
    operation: string,
    action: () => Promise<T>,
  ) => {
    const before = queries;
    const start = performance.now();
    const result = await action();
    samples.push({
      run,
      operation,
      ms: performance.now() - start,
      queries: queries - before,
    });
    return result;
  };
  try {
    await connection.run("SET memory_limit='1.5GB'");
    await connection.run("SET threads=4");
    await measure(0, "attach", () =>
      connection.run(`ATTACH ${sqlString(file)} AS benchmark (READ_ONLY)`),
    );
    for (let run = 0; run < 5; run++) {
      const catalog = new CatalogService(query, { storagePath });
      services.push(catalog);
      // Remove only our benchmark's snapshots to measure fresh discovery.
      catalog.refresh();
      await catalog.flush();
      const tables = await measure(run, "fresh discovery", () =>
        catalog.getTables("benchmark", schema),
      );
      await measure(run, "memory cache", () =>
        catalog.getTables("benchmark", schema),
      );
      if (tables[0]) {
        await measure(run, "first column expansion", () =>
          catalog.getColumns("benchmark", schema, tables[0].name),
        );
      }
      await catalog.flush();
      const restarted = new CatalogService(query, { storagePath });
      services.push(restarted);
      await measure(run, "snapshot restore", () =>
        restarted.getTables("benchmark", schema),
      );
      await restarted.flush();
    }
    const medians = [...new Set(samples.map((sample) => sample.operation))].map(
      (operation) => {
        const values = samples
          .filter((sample) => sample.operation === operation)
          .map((sample) => sample.ms)
          .sort((a, b) => a - b);
        return { operation, ms: values[Math.floor(values.length / 2)] };
      },
    );
    console.log(
      JSON.stringify(
        {
          databaseBytes: (await fs.stat(file)).size,
          engine: (await query("SELECT version() AS version"))[0].version,
          node: process.version,
          platform: `${os.platform()} ${os.release()} ${os.arch()}`,
          schema,
          memoryLimit: "1.5GB",
          threads: 4,
          notes: [
            "OS filesystem caches are not cleared",
            "Snapshot restore includes attachment verification and starts background validation",
            "Does not measure VS Code rendering or activation",
          ],
          samples,
          medians,
        },
        null,
        2,
      ),
    );
  } finally {
    await Promise.all(services.map((service) => service.flush()));
    connection.closeSync();
    instance.closeSync();
    await fs.rm(storagePath, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
