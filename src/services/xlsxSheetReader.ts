/**
 * Zero-dependency xlsx sheet name reader.
 *
 * An .xlsx file is a ZIP archive containing XML. Sheet names live in
 * `xl/workbook.xml` inside a <sheets> element. OOXML producers may use either
 * the default SpreadsheetML namespace or an arbitrary namespace prefix on
 * those elements. We parse the ZIP central directory to locate that single
 * entry, decompress it with Node's built-in zlib, and extract sheet names
 * without depending on a particular prefix. No npm packages required.
 */
import * as fs from "fs";
import * as zlib from "zlib";

/**
 * Extract sheet names from an .xlsx file by reading its ZIP structure.
 * Returns sheet names in workbook order. Returns an empty array when the
 * workbook metadata cannot be read; callers can then let DuckDB select the
 * first sheet rather than guessing that it is named "Sheet1".
 */
export function getXlsxSheetNames(filePath: string): string[] {
  try {
    const buf = fs.readFileSync(filePath);
    const xml = readZipEntry(buf, "xl/workbook.xml");
    return xml ? parseWorkbookSheetNames(xml) : [];
  } catch {
    return [];
  }
}

/** Extract sheet names from workbook.xml without assuming a namespace prefix. */
export function parseWorkbookSheetNames(xml: string): string[] {
  const prefix = "(?:[A-Za-z_][\\w.-]*:)?";
  const sheetsPattern = new RegExp(
    `<${prefix}sheets\\b[^>]*>([\\s\\S]*?)<\\/${prefix}sheets\\s*>`
  );
  const sheetsBlock = xml.match(sheetsPattern)?.[1];
  if (!sheetsBlock) {
    return [];
  }

  const sheetPattern = new RegExp(
    `<${prefix}sheet\\b[^>]*\\bname\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    "g"
  );
  const names: string[] = [];
  for (const match of sheetsBlock.matchAll(sheetPattern)) {
    names.push(decodeXmlEntities(match[1] ?? match[2] ?? ""));
  }
  return names;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// ---------------------------------------------------------------------------
// Minimal ZIP reader — only enough to extract a single entry by name
// ---------------------------------------------------------------------------

function readZipEntry(buf: Buffer, targetPath: string): string | null {
  // End of Central Directory record sits at the tail of the file.
  // Signature: 0x06054b50. Search backwards from the end (max comment = 65535).
  const eocdSearchStart = Math.max(0, buf.length - 65557);
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= eocdSearchStart; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) return null;

  const cdEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  // Walk central directory entries looking for targetPath
  let pos = cdOffset;
  for (let i = 0; i < cdEntries; i++) {
    if (pos + 46 > buf.length) return null;
    if (buf.readUInt32LE(pos) !== 0x02014b50) return null;

    const compressionMethod = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const uncompressedSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);

    const name = buf.toString("utf8", pos + 46, pos + 46 + nameLen);

    if (name === targetPath) {
      // Read the local file header to find the actual data offset
      const lh = localHeaderOffset;
      if (lh + 30 > buf.length) return null;
      const lhNameLen = buf.readUInt16LE(lh + 26);
      const lhExtraLen = buf.readUInt16LE(lh + 28);
      const dataOffset = lh + 30 + lhNameLen + lhExtraLen;

      const compressed = buf.subarray(dataOffset, dataOffset + compressedSize);

      if (compressionMethod === 0) {
        // Stored (no compression)
        return compressed.toString("utf8");
      } else if (compressionMethod === 8) {
        // Deflated — use raw inflate (no zlib/gzip header)
        return zlib.inflateRawSync(compressed).toString("utf8");
      }
      return null;
    }

    pos += 46 + nameLen + extraLen + commentLen;
  }

  return null;
}
