/**
 * Unit tests for XLSX sheet-name discovery.
 *
 * XML samples are intentionally synthetic so no real workbook data is checked
 * into the repo.
 */
import assert from "node:assert";
import { describe, it } from "node:test";
import {
  getXlsxSheetNames,
  parseWorkbookSheetNames,
} from "../services/xlsxSheetReader";

describe("parseWorkbookSheetNames", () => {
  it("reads sheet names that use the default SpreadsheetML namespace", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
        <sheets>
          <sheet name="Data" sheetId="1" />
          <sheet name="Notes" sheetId="2" />
        </sheets>
      </workbook>`;

    assert.deepStrictEqual(parseWorkbookSheetNames(xml), ["Data", "Notes"]);
  });

  it("reads sheet names when SpreadsheetML elements use a prefix", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
        <x:sheets>
          <x:sheet name="数据总览" sheetId="1" />
          <x:sheet name="说明 &amp; QA" sheetId="2" />
          <x:sheet name="O&apos;Brien" sheetId="3" />
        </x:sheets>
      </x:workbook>`;

    assert.deepStrictEqual(parseWorkbookSheetNames(xml), [
      "数据总览",
      "说明 & QA",
      "O'Brien",
    ]);
  });

  it("returns no names when workbook.xml has no sheets", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" />`;

    assert.deepStrictEqual(parseWorkbookSheetNames(xml), []);
  });
});

describe("getXlsxSheetNames", () => {
  it("returns no names for an unreadable XLSX", () => {
    assert.deepStrictEqual(getXlsxSheetNames("\0"), []);
  });
});
