"""Create an opt-in, multi-GB catalog fixture from public NYC TLC Parquet data.

Requires the optional Python duckdb package. Downloads and database files belong
outside the repository; this script is never run by CI.
"""
import argparse
from pathlib import Path
import shutil
import urllib.request

import duckdb


def sql_string(value):
    return "'" + str(value).replace("'", "''") + "'"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path, help="Output directory outside the repository")
    parser.add_argument("--year", type=int, default=2025)
    parser.add_argument("--months", type=int, choices=range(1, 13), default=12)
    parser.add_argument("--empty-tables", type=int, default=1000)
    args = parser.parse_args()
    if args.empty_tables < 0:
        parser.error("--empty-tables must be non-negative")
    directory = args.directory.resolve()
    directory.mkdir(parents=True, exist_ok=True)
    files = []
    for month in range(1, args.months + 1):
        file = directory / f"yellow_tripdata_{args.year}-{month:02}.parquet"
        if not file.exists():
            url = "https://d37ci6vzurychx.cloudfront.net/trip-data/" + file.name
            temporary = file.with_suffix(".partial")
            print(f"Downloading {url}", flush=True)
            try:
                with urllib.request.urlopen(url, timeout=60) as response, temporary.open("wb") as output:
                    shutil.copyfileobj(response, output)
                temporary.replace(file)
            finally:
                temporary.unlink(missing_ok=True)
        files.append(file)
    database = directory / f"taxi-{args.year}.duckdb"
    with duckdb.connect(str(database)) as connection:
        connection.execute("SET memory_limit='1.5GB'")
        connection.execute("SET threads=4")
        for month, file in enumerate(files, 1):
            print(f"Importing trips_{month:02}", flush=True)
            connection.execute(
                f"CREATE TABLE IF NOT EXISTS trips_{month:02} AS "
                f"SELECT * FROM read_parquet({sql_string(file)})"
            )
        sources = "[" + ", ".join(sql_string(file) for file in files) + "]"
        # Duplicate the source rows to exercise a large annual table as well as
        # partitioned monthly tables. Both shapes occur in real user catalogs.
        connection.execute(
            f"CREATE TABLE IF NOT EXISTS trips_annual AS SELECT * FROM read_parquet({sources})"
        )
        connection.execute("""
            CREATE OR REPLACE VIEW aggregate_trips AS
            SELECT PULocationID, count(*) AS trips FROM trips_01
            GROUP BY PULocationID HAVING sum(total_amount) > 100
        """)
        connection.execute("CREATE SCHEMA IF NOT EXISTS many")
        connection.execute("BEGIN")
        for index in range(args.empty_tables):
            connection.execute(
                f"CREATE TABLE IF NOT EXISTS many.table_{index:04} "
                "(id BIGINT, name VARCHAR, created_at TIMESTAMP)"
            )
        connection.execute("COMMIT")
        connection.execute("CHECKPOINT")
    print(f"Created {database} ({database.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
