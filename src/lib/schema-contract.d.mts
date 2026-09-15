/** Typy k schema-contract.mjs. Data i logika jsou schválně v .mjs, ať je
 *  může importovat i Node skript, kde TypeScript neběží. */

export interface SchemaRequirement {
  /** Migrace, která tohle přidala. Slouží jen k vysvětlení v hlášce. */
  since: string;
  /** Lidsky pojmenovaná část aplikace, která se bez toho rozbije. */
  feature: string;
  table: string;
  columns: string[];
}

export interface SchemaGap extends SchemaRequirement {
  /** Chybí celá tabulka, ne jen sloupce. */
  missingTable: boolean;
}

export declare const MIGRATIONS: readonly string[];
export declare const REQUIRED: readonly SchemaRequirement[];
export declare function findMissing(
  present: Map<string, Set<string>>,
  required?: readonly SchemaRequirement[],
): SchemaGap[];
