/**
 * Variable substitution for subjects and bodies.
 *
 * Syntax:  {{first_name}}            -> value, or "" when missing
 *          {{first_name|there}}      -> value, or "there" when missing
 *
 * Whitespace inside the braces is tolerated. Unknown variable names render as
 * their fallback (or empty) rather than throwing, but `findUnknownVariables`
 * lets the UI warn about typos before a campaign starts.
 */

export const TEMPLATE_VARIABLES = [
  "first_name",
  "last_name",
  "company",
  "website",
  "unsubscribe_link",
] as const;

export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

export type TemplateVars = Partial<Record<TemplateVariable, string | null | undefined>>;

const TOKEN = /\{\{\s*([a-zA-Z0-9_]+)\s*(?:\|([^}]*))?\}\}/g;

export function renderTemplate(template: string, vars: TemplateVars): string {
  return template.replace(TOKEN, (_match, rawName: string, fallback?: string) => {
    const name = rawName.toLowerCase() as TemplateVariable;
    const value = vars[name];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value);
    }
    return fallback ?? "";
  });
}

/** Every variable name referenced by the template, in order of appearance. */
export function extractVariables(template: string): string[] {
  const found: string[] = [];
  for (const match of template.matchAll(TOKEN)) {
    const name = match[1].toLowerCase();
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

/** Referenced names that are not supported - almost always a typo. */
export function findUnknownVariables(template: string): string[] {
  return extractVariables(template).filter(
    (name) => !(TEMPLATE_VARIABLES as readonly string[]).includes(name),
  );
}

/**
 * Variables that would render empty for this contact and have no fallback.
 * Used to warn "12 contacts have no company - {{company}} will be blank".
 */
export function findEmptyVariables(template: string, vars: TemplateVars): string[] {
  const empty: string[] = [];
  for (const match of template.matchAll(TOKEN)) {
    const name = match[1].toLowerCase() as TemplateVariable;
    const hasFallback = match[2] !== undefined && match[2] !== "";
    if (hasFallback) continue;
    const value = vars[name];
    if ((value === undefined || value === null || String(value).trim() === "") && !empty.includes(name)) {
      empty.push(name);
    }
  }
  return empty;
}

/** Minimal, safe HTML rendering of a plain-text body: escape, then linebreak. */
export function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const linked = escaped.replace(
    /(https?:\/\/[^\s<]+)/g,
    '<a href="$1" style="color:#2563eb">$1</a>',
  );
  return linked.split(/\r?\n/).join("<br>");
}
