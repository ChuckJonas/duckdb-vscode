#!/usr/bin/env python3
import argparse
import os
import time
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq


# -----------------------
# Utilities
# -----------------------
def parse_size(s: str) -> int:
    s = s.strip().upper().replace("_", "")
    mults = {"B": 1, "KB": 1024, "MB": 1024**2, "GB": 1024**3, "TB": 1024**4}
    for unit in ["TB", "GB", "MB", "KB", "B"]:
        if s.endswith(unit):
            num = float(s[: -len(unit)].strip())
            return int(num * mults[unit])
    # allow raw integer bytes
    return int(s)


def human_bytes(n: int) -> str:
    units = ["B", "KB", "MB", "GB", "TB"]
    f = float(n)
    for u in units:
        if f < 1024 or u == units[-1]:
            return f"{f:.2f} {u}"
        f /= 1024
    return f"{f:.2f} TB"


def ensure_dir(p: Path) -> None:
    p.mkdir(parents=True, exist_ok=True)


def compression_arg(name: str):
    n = name.lower()
    if n in ("none", "uncompressed", "off"):
        return None
    return n


def make_writer_kwargs(compression: str | None, compression_level: int | None) -> dict:
    # pyarrow supports compression_level for several codecs. If codec doesn't
    # support levels, pyarrow may ignore or error depending on version.
    kw = {}
    if compression is not None:
        kw["compression"] = compression
        if compression_level is not None:
            kw["compression_level"] = compression_level
    else:
        kw["compression"] = None
    return kw


# -----------------------
# "Real-ish" table generator
# -----------------------
def make_rowgroup(
    n_rows: int,
    rng: np.random.Generator,
    base_id: int,
    start_ts_ms: int,
) -> pa.Table:
    """
    A mix of:
      - ints, floats, decimals
      - timestamps
      - low-cardinality categories (dictionary-friendly)
      - medium/high-cardinality strings (less compressible)
      - json-ish payload
      - nulls sprinkled in
      - completely null columns (various types)
      - non-uniform distributions (power-law, exponential, geometric)
    """
    # Core identifiers
    ids = np.arange(base_id, base_id + n_rows, dtype=np.int64)

    # Power-law / Zipf-ish user_id: a small set of users generate most events
    raw_zipf = rng.zipf(a=1.5, size=n_rows)
    user_id = (raw_zipf % 5_000_000 + 1).astype(np.int64)

    session_id = rng.integers(1, 50_000_000, size=n_rows, dtype=np.int64)

    # Timestamps (event stream-ish)
    # jitter within a window, plus monotonic-ish drift
    ts = (
        start_ts_ms
        + ids % (7 * 24 * 3600 * 1000)
        + rng.integers(0, 2000, size=n_rows, dtype=np.int64)
    )

    # Numerics — intentionally non-uniform distributions
    # Price: lognormal (long right tail — most items cheap, some very expensive)
    price = np.round(rng.lognormal(mean=2.8, sigma=1.2, size=n_rows), 2).astype(
        np.float64
    )

    # Quantity: geometric distribution (most orders = 1 item, exponential decay)
    quantity = rng.geometric(p=0.45, size=n_rows).astype(np.int16)

    # Score: normal / bell curve (mean=0, std=1)
    score = rng.standard_normal(n_rows).astype(np.float32)

    # Latency: exponential distribution (most requests fast, long tail of slow ones)
    latency_ms = np.round(rng.exponential(scale=120.0, size=n_rows), 1).astype(
        np.float64
    )

    # Rating: beta distribution scaled to 1-5 (skewed toward high ratings)
    rating = np.round(rng.beta(a=5.0, b=2.0, size=n_rows) * 4 + 1, 1).astype(np.float32)

    # Booleans / flags
    is_refund = rng.random(n_rows) < 0.02
    is_mobile = rng.random(n_rows) < 0.55

    # Low-cardinality dimensions (great for dictionary encoding)
    country_codes = np.array(
        [
            "US",
            "CA",
            "GB",
            "DE",
            "FR",
            "NL",
            "SE",
            "NO",
            "ES",
            "IT",
            "BR",
            "IN",
            "JP",
            "AU",
        ],
        dtype=object,
    )
    country = country_codes[rng.integers(0, len(country_codes), size=n_rows)]

    channel_vals = np.array(
        ["organic", "paid", "email", "referral", "social"], dtype=object
    )
    channel = channel_vals[rng.integers(0, len(channel_vals), size=n_rows)]

    # Medium-cardinality product-ish strings
    # product_sku like "SKU-ABCDE-1234"
    letters = np.array(list("ABCDEFGHIJKLMNOPQRSTUVWXYZ"), dtype="<U1")
    sku_letters = rng.choice(letters, size=(n_rows, 5))
    sku_nums = rng.integers(0, 10_000, size=n_rows)
    product_sku = np.char.add(
        np.char.add("SKU-", np.apply_along_axis("".join, 1, sku_letters)),
        np.char.add("-", sku_nums.astype(str)),
    )

    # URL-ish path (some repetition, some variability)
    pages = np.array(
        ["/home", "/search", "/product", "/cart", "/checkout", "/account", "/help"],
        dtype=object,
    )
    page = pages[rng.integers(0, len(pages), size=n_rows)]
    q = rng.integers(0, 10_000_000, size=n_rows)
    url = np.char.add(np.char.add(page.astype(str), "?q="), q.astype(str))

    # JSON-ish payload: small, but not perfectly compressible
    # Example: {"ab":123,"cd":456,"ok":true}
    k1 = rng.integers(0, 26**2, size=n_rows)
    k2 = rng.integers(0, 26**2, size=n_rows)
    v1 = rng.integers(0, 10_000, size=n_rows)
    v2 = rng.integers(0, 10_000, size=n_rows)
    ok = rng.random(n_rows) < 0.8

    def two_letter(x: np.ndarray) -> np.ndarray:
        a = (x // 26).astype(np.int32)
        b = (x % 26).astype(np.int32)
        return np.char.add(
            np.char.add(np.array(list("abcdefghijklmnopqrstuvwxyz"))[a], ""),
            np.array(list("abcdefghijklmnopqrstuvwxyz"))[b],
        )

    key1 = two_letter(k1)
    key2 = two_letter(k2)
    payload = np.char.add(
        np.char.add(np.char.add('{"', key1), np.char.add('":', v1.astype(str))),
        np.char.add(
            np.char.add(',"', key2),
            np.char.add(
                np.char.add('":', v2.astype(str)),
                np.where(ok, ',"ok":true}', ',"ok":false}'),
            ),
        ),
    )

    # Sprinkle nulls (common in real data)
    # Make about 3% of url and 1% of country null
    url_mask = rng.random(n_rows) < 0.03
    country_mask = rng.random(n_rows) < 0.01
    url = url.astype(object)
    country = country.astype(object)
    url[url_mask] = None
    country[country_mask] = None

    # Completely null columns (various types — tests null handling paths)
    all_nulls = [None] * n_rows

    # Build Arrow arrays (explicit types help stability)
    return pa.table(
        {
            "event_id": pa.array(ids, type=pa.int64()),
            "user_id": pa.array(user_id, type=pa.int64()),
            "session_id": pa.array(session_id, type=pa.int64()),
            "event_ts": pa.array(ts, type=pa.timestamp("ms")),
            "price": pa.array(price, type=pa.float64()),
            "quantity": pa.array(quantity, type=pa.int16()),
            "score": pa.array(score, type=pa.float32()),
            "latency_ms": pa.array(latency_ms, type=pa.float64()),
            "rating": pa.array(rating, type=pa.float32()),
            "is_refund": pa.array(is_refund, type=pa.bool_()),
            "is_mobile": pa.array(is_mobile, type=pa.bool_()),
            "country": pa.array(country, type=pa.string()),
            "channel": pa.array(channel, type=pa.string()),
            "product_sku": pa.array(product_sku, type=pa.string()),
            "url": pa.array(url, type=pa.string()),
            "payload": pa.array(payload, type=pa.string()),
            # All-null columns (different types)
            "null_comment": pa.array(all_nulls, type=pa.string()),
            "null_amount": pa.array(all_nulls, type=pa.float64()),
            "null_updated_at": pa.array(all_nulls, type=pa.timestamp("ms")),
            "null_flag": pa.array(all_nulls, type=pa.bool_()),
        }
    )


# -----------------------
# Main: write until size target
# -----------------------
def write_to_target(
    out_path: Path,
    target_bytes: int,
    row_group_rows: int,
    compression: str | None,
    compression_level: int | None,
    use_dictionary: bool,
    seed: int,
    overshoot_pct: float,
    max_row_groups: int,
) -> int:
    if out_path.exists():
        out_path.unlink()

    rng = np.random.default_rng(seed)
    start_ts_ms = int(time.time() * 1000)

    writer = None
    row_groups = 0
    base_id = 0

    writer_kwargs = make_writer_kwargs(compression, compression_level)

    try:
        while True:
            tbl = make_rowgroup(
                row_group_rows, rng, base_id=base_id, start_ts_ms=start_ts_ms
            )
            if writer is None:
                writer = pq.ParquetWriter(
                    where=str(out_path),
                    schema=tbl.schema,
                    use_dictionary=use_dictionary,
                    **writer_kwargs,
                )
            writer.write_table(tbl)

            row_groups += 1
            base_id += row_group_rows

            size = out_path.stat().st_size
            # stop when we hit target, allowing small overshoot to avoid thrashing near boundary
            if size >= target_bytes * (1.0 + overshoot_pct):
                return size
            if row_groups >= max_row_groups:
                raise RuntimeError(
                    f"Hit max_row_groups={max_row_groups} before reaching {human_bytes(target_bytes)} (got {human_bytes(size)})."
                )
    finally:
        if writer is not None:
            writer.close()


def main():
    ap = argparse.ArgumentParser(
        description="Generate representative Parquet files at target sizes."
    )
    ap.add_argument("--out-dir", default="parquet_testdata", help="Output directory")
    ap.add_argument(
        "--targets",
        default="250MB,500MB,1GB,2GB,4GB",
        help='Comma-separated sizes, e.g. "250MB,500MB,1GB,2GB,4GB"',
    )
    ap.add_argument(
        "--compression",
        default="zstd",
        help="Compression codec: zstd|snappy|gzip|brotli|lz4|none",
    )
    ap.add_argument(
        "--compression-level",
        type=int,
        default=None,
        help="Compression level (codec-dependent)",
    )
    ap.add_argument(
        "--row-group-rows",
        type=int,
        default=250_000,
        help="Rows per row group (affects memory + file structure)",
    )
    ap.add_argument(
        "--dictionary",
        action="store_true",
        help="Enable dictionary encoding (recommended)",
    )
    ap.add_argument(
        "--no-dictionary",
        dest="dictionary",
        action="store_false",
        help="Disable dictionary encoding",
    )
    ap.set_defaults(dictionary=True)
    ap.add_argument("--seed", type=int, default=1, help="RNG seed (repeatable data)")
    ap.add_argument(
        "--overshoot",
        type=float,
        default=0.03,
        help="Stop once size >= target*(1+overshoot). Default 3%",
    )
    ap.add_argument(
        "--max-row-groups", type=int, default=200_000, help="Safety cap on row groups"
    )
    args = ap.parse_args()

    out_dir = Path(args.out_dir)
    ensure_dir(out_dir)

    compression = compression_arg(args.compression)
    targets = [parse_size(x) for x in args.targets.split(",") if x.strip()]

    # Put codec name into file so you can compare easily
    codec_tag = compression or "none"
    lvl_tag = (
        f"-lvl{args.compression_level}"
        if args.compression_level is not None and compression is not None
        else ""
    )

    print(f"Output: {out_dir.resolve()}")
    print(
        f"Compression: {codec_tag}{lvl_tag}, dictionary={args.dictionary}, row_group_rows={args.row_group_rows}"
    )

    for t in targets:
        fname = f"realish_{human_bytes(t).replace(' ', '').replace('.', '_')}_{codec_tag}{lvl_tag}.parquet"
        out_path = out_dir / fname
        print(f"\nWriting {out_path.name} (target {human_bytes(t)}) ...")
        final_size = write_to_target(
            out_path=out_path,
            target_bytes=t,
            row_group_rows=args.row_group_rows,
            compression=compression,
            compression_level=args.compression_level,
            use_dictionary=args.dictionary,
            seed=args.seed,
            overshoot_pct=args.overshoot,
            max_row_groups=args.max_row_groups,
        )
        print(f"Done: {human_bytes(final_size)}")


if __name__ == "__main__":
    main()
