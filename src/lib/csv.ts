/**
 * RFC 4180 CSV parsing with header aliasing.
 *
 * Deliberately hand-rolled: the input is a five-column contact export, and a
 * parser dependency would be more surface area than the 60 lines it replaces.
 * Handles quoted fields, escaped quotes, embedded newlines, CRLF and a BOM.
 */

export interface ParsedContactRow {
  /** 1-based line number in the source file, for error messages. */
  line: number;
  email: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  website: string | null;
  phone: string | null;
}

export interface CsvParseResult {
  rows: ParsedContactRow[];
  errors: string[];
  /** Header names in the file that were not recognised. */
  ignoredColumns: string[];
}

/** Splits CSV text into a matrix of raw string cells. */
export function parseCsv(input: string, delimiter = ","): string[][] {
  const text = input.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += char;
      i++;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (char === delimiter) {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (char === "\r") {
      i++;
      continue;
    }
    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += char;
    i++;
  }

  // Trailing field / row (file not ending in a newline).
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

/** Guesses the delimiter from the header line - comma or semicolon. */
export function detectDelimiter(input: string): string {
  const firstLine = input.replace(/^\uFEFF/, "").split(/\r?\n/)[0] ?? "";
  const commas = (firstLine.match(/,/g) ?? []).length;
  const semicolons = (firstLine.match(/;/g) ?? []).length;
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  if (tabs > commas && tabs > semicolons) return "\t";
  return semicolons > commas ? ";" : ",";
}

const HEADER_ALIASES: Record<string, keyof Omit<ParsedContactRow, "line">> = {
  email: "email",
  "e-mail": "email",
  emailaddress: "email",
  mail: "email",
  firstname: "first_name",
  first: "first_name",
  fname: "first_name",
  givenname: "first_name",
  jmeno: "first_name",
  lastname: "last_name",
  last: "last_name",
  lname: "last_name",
  surname: "last_name",
  familyname: "last_name",
  prijmeni: "last_name",
  company: "company",
  companyname: "company",
  organization: "company",
  organisation: "company",
  firma: "company",
  spolecnost: "company",
  phone: "phone",
  phonenumber: "phone",
  telephone: "phone",
  tel: "phone",
  telefon: "phone",
  mobil: "phone",
  mobile: "phone",
  cislo: "phone",
  website: "website",
  url: "website",
  web: "website",
  domain: "website",
  site: "website",
  webova: "website",
};

function normaliseHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics: "jméno" -> "jmeno"
    .replace(/[^a-z]/g, "");
}

// Intentionally permissive: real prospect lists contain addresses that a
// strict RFC 5322 regex would reject. The SMTP server is the final authority.
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

export function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Keeps the number as the operator typed it, minus the spacing a spreadsheet
 * export adds. Deliberately not reformatted to E.164: the caller reads it and
 * dials it, and a "helpful" rewrite of a Czech number is how a digit gets lost.
 */
export function normalisePhone(value: string | null): string | null {
  if (!value) return null;
  const cleaned = value.replace(/[\s\u00a0]+/g, " ").trim();
  return cleaned === "" ? null : cleaned;
}

export function normaliseWebsite(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed;
}

/**
 * Parses a contact CSV. Rows with a missing or malformed email are reported in
 * `errors` and excluded; everything else is passed through so that one bad
 * line never blocks an import.
 */
export function parseContactsCsv(input: string): CsvParseResult {
  const errors: string[] = [];
  const rows: ParsedContactRow[] = [];

  const matrix = parseCsv(input, detectDelimiter(input));
  if (matrix.length === 0) {
    return { rows, errors: ["Soubor je prázdný."], ignoredColumns: [] };
  }

  const header = matrix[0];
  const columnMap = new Map<number, keyof Omit<ParsedContactRow, "line">>();
  const ignoredColumns: string[] = [];

  header.forEach((raw, index) => {
    const key = HEADER_ALIASES[normaliseHeader(raw)];
    if (key) {
      // First matching column wins, so a duplicate header is ignored.
      if (![...columnMap.values()].includes(key)) columnMap.set(index, key);
    } else if (raw.trim()) {
      ignoredColumns.push(raw.trim());
    }
  });

  if (![...columnMap.values()].includes("email")) {
    return {
      rows,
      errors: [
        `Nenalezen sloupec "email". Rozpoznané hlavičky: ${header.map((h) => h.trim()).join(", ") || "(žádné)"}.`,
      ],
      ignoredColumns,
    };
  }

  const seen = new Set<string>();

  for (let r = 1; r < matrix.length; r++) {
    const cells = matrix[r];
    const line = r + 1;
    const record: Record<string, string | null> = {
      email: null,
      first_name: null,
      last_name: null,
      company: null,
      website: null,
      phone: null,
    };

    for (const [index, key] of columnMap) {
      const value = (cells[index] ?? "").trim();
      record[key] = value === "" ? null : value;
    }

    if (!record.email) {
      errors.push(`Řádek ${line}: chybí e-mailová adresa, řádek přeskočen.`);
      continue;
    }
    const email = normaliseEmail(record.email);
    if (!isValidEmail(email)) {
      errors.push(`Řádek ${line}: "${record.email}" není platná e-mailová adresa, řádek přeskočen.`);
      continue;
    }
    // Deduplicate inside the file itself; DB-level dedupe happens on insert.
    if (seen.has(email)) {
      errors.push(`Řádek ${line}: ${email} je v souboru víckrát, pozdější řádek přeskočen.`);
      continue;
    }
    seen.add(email);

    rows.push({
      line,
      email,
      first_name: record.first_name,
      last_name: record.last_name,
      company: record.company,
      website: normaliseWebsite(record.website),
      phone: normalisePhone(record.phone),
    });
  }

  return { rows, errors, ignoredColumns };
}
