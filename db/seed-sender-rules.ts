import { eq } from "drizzle-orm";
import * as schema from "./schema";
import { SENDER_RULES, type SenderRule } from "../documents/sender-rules";
import { INSTITUTIONS, type Institution } from "../documents/institutions";

/** Marker keys in document_sender_rule_imports (migration 0274). */
export const BUILT_IN_SENDER_RULES_IMPORT = "builtin-sender-rules-v1";
export const BUILT_IN_CORRESPONDENTS_IMPORT = "builtin-correspondents-v1";

/**
 * Household rules that existed before the import keep winning: they used to be
 * consulted ahead of the built-in list, so the imported rules sort after them.
 */
const IMPORTED_SORT_BASE = 1000;

/**
 * Copy the built-in SENDER_RULES into document_sender_rule_overrides, once.
 *
 * The table already holds the household's own rules and is consulted first
 * (see matchSenderRule). Moving the built-in rules there takes the institution
 * names out of the source tree; a later PR empties the list in the code. The
 * marker makes this a one-time step: a rule the household deletes or edits in
 * the table afterwards is never brought back by a restart.
 *
 * A table row holds one sender fragment, so a rule with several fragments
 * becomes several rows with the same sort order — inserted in the rule's
 * order, the id keeps them in it.
 */
export async function importBuiltInSenderRules(
  db: any,
  rules: readonly SenderRule[] = SENDER_RULES,
): Promise<number> {
  return db.transaction(async (tx: any) => {
    const done = (await tx
      .select({ key: schema.documentSenderRuleImports.key })
      .from(schema.documentSenderRuleImports)
      .where(eq(schema.documentSenderRuleImports.key, BUILT_IN_SENDER_RULES_IMPORT)))[0];
    if (done) return 0;

    const rows = rules.flatMap((rule, index) =>
      rule.senders.map((sender) => ({
        note: rule.note,
        sender_pattern: sender,
        require_any: rule.requireAny?.length ? [...rule.requireAny] : null,
        exclude_any: rule.excludeAny?.length ? [...rule.excludeAny] : null,
        category: rule.category,
        sort_order: IMPORTED_SORT_BASE + index,
        created_by: null,
      })),
    );
    if (rows.length > 0) {
      await tx.insert(schema.documentSenderRuleOverrides).values(rows);
    }
    await tx
      .insert(schema.documentSenderRuleImports)
      .values({ key: BUILT_IN_SENDER_RULES_IMPORT, rule_count: rows.length });
    console.log(`[seed] Imported ${rows.length} built-in sender rules into document_sender_rule_overrides`);
    return rows.length;
  });
}

/**
 * Copy the built-in correspondent registry (INSTITUTIONS) into
 * document_correspondent_overrides, once — the same move as the sender rules,
 * for the list that names folders after the household's institutions.
 *
 * The overrides table is consulted first and picks the longest matching
 * pattern; the registry used to come second. So a fragment is left out when an
 * existing override already covers it (its pattern is part of the fragment):
 * every sender the fragment matches also matches that override, which used to
 * win and must keep winning.
 */
export async function importBuiltInCorrespondents(
  db: any,
  institutions: readonly Institution[] = INSTITUTIONS,
): Promise<number> {
  return db.transaction(async (tx: any) => {
    const done = (await tx
      .select({ key: schema.documentSenderRuleImports.key })
      .from(schema.documentSenderRuleImports)
      .where(eq(schema.documentSenderRuleImports.key, BUILT_IN_CORRESPONDENTS_IMPORT)))[0];
    if (done) return 0;

    const existing = ((await tx
      .select({ pattern: schema.documentCorrespondentOverrides.sender_pattern })
      .from(schema.documentCorrespondentOverrides)) as { pattern: string }[]).map((r) => r.pattern);

    const rows = institutions.flatMap((inst) =>
      inst.fragments
        .filter((frag) => !existing.some((pattern) => pattern.length > 0 && frag.includes(pattern)))
        .map((frag) => ({
          sender_pattern: frag,
          correspondent_slug: inst.slug,
          correspondent_display: inst.display,
          created_by: null,
        })),
    );
    if (rows.length > 0) {
      await tx.insert(schema.documentCorrespondentOverrides).values(rows).onConflictDoNothing();
    }
    await tx
      .insert(schema.documentSenderRuleImports)
      .values({ key: BUILT_IN_CORRESPONDENTS_IMPORT, rule_count: rows.length });
    console.log(`[seed] Imported ${rows.length} built-in correspondents into document_correspondent_overrides`);
    return rows.length;
  });
}
