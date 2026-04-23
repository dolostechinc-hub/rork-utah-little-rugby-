import { Platform } from 'react-native';

export function extractSpreadsheetId(url: string): string | null {
  const patterns = [
    /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/,
    /^([a-zA-Z0-9-_]+)$/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function isValidCsvPayload(content: string | null | undefined): content is string {
  if (!content) return false;
  const trimmed = content.trim();
  if (trimmed.length === 0) return false;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('<!doctype html') || lower.startsWith('<html')) return false;
  return true;
}

async function tryFetchCsv(url: string, label: string): Promise<string | null> {
  try {
    console.log(`[sheets] fetching via ${label}:`, url);
    const response = await fetch(url, {
      redirect: 'follow',
      headers: { Accept: 'text/csv,text/plain,*/*' },
    });
    if (!response.ok) {
      console.warn(`[sheets] ${label} responded with status`, response.status);
      return null;
    }
    const text = await response.text();
    if (!isValidCsvPayload(text)) {
      console.warn(`[sheets] ${label} returned non-csv payload (len=${text.length})`);
      return null;
    }
    console.log(`[sheets] ${label} succeeded, length:`, text.length);
    return text;
  } catch (err) {
    console.warn(`[sheets] ${label} threw:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export async function fetchSheetCsv(spreadsheetId: string, sheetName?: string): Promise<string> {
  const encodedSheet = sheetName ? encodeURIComponent(sheetName) : null;

  const gvizUrl = encodedSheet
    ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:csv&sheet=${encodedSheet}`
    : `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:csv`;

  const exportUrl = encodedSheet
    ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&sheet=${encodedSheet}`
    : `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv`;

  const order = Platform.OS === 'web'
    ? [{ url: gvizUrl, label: 'gviz-csv' }, { url: exportUrl, label: 'export-csv' }]
    : [{ url: exportUrl, label: 'export-csv' }, { url: gvizUrl, label: 'gviz-csv' }];

  for (const step of order) {
    const result = await tryFetchCsv(step.url, step.label);
    if (result) return result;
  }

  throw new Error(
    'Could not access the spreadsheet. Make sure it is shared as "Anyone with the link can view" and try again.'
  );
}

export function parseCSV(content: string): string[][] {
  const rows: string[][] = [];
  let current = '';
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const next = content[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === ',') {
      row.push(current.trim());
      current = '';
      continue;
    }

    if (char === '\r') {
      continue;
    }

    if (char === '\n') {
      row.push(current.trim());
      if (row.some((c) => c.length > 0)) {
        rows.push(row);
      }
      row = [];
      current = '';
      continue;
    }

    current += char;
  }

  if (current.length > 0 || row.length > 0) {
    row.push(current.trim());
    if (row.some((c) => c.length > 0)) {
      rows.push(row);
    }
  }

  return rows;
}
