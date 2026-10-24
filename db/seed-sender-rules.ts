import { eq } from "drizzle-orm";
import * as schema from "./schema";
import { SENDER_RULES, type SenderRule } from "../documents/sender-rules";

/** Marker key in document_sender_rule_imports (migration 0274). */
export const BUILT_IN_SENDER_RULES_IMPORT = "builtin-sender-rules-v1";

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
