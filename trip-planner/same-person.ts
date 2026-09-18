/**
 * Is this household entry the same human as that account? (§3.5, §6.2)
 *
 * The travel group draws on two lists that describe people twice: the
 * household (`user_subject_persons`, full name, relation, birth date)
 * and the accounts that plan the trip (`users`, a display name). The
 * organiser is on both — as "Max Beispiel (Ehemann)" in the household
 * they keep, and as "Max" in the list of planners — and the screen
 * offered them twice. So was the spouse who plans along: "Erika
 * Beispiel (Ehefrau)" in the organiser's household, "Erika" as an
 * account.
 *
 * The join used to be the name, compared exactly. That is the weakest
 * possible key: the household holds full names and an account holds
 * whatever its owner typed at signup, and "Max Beispiel" is not "Max".
 *
 * Two better keys exist, and they cover the cases that matter:
 *
 * 1. An entry whose relation kind is `self` *is* the account it
 *    belongs to. That settles the organiser.
 * 2. Every account keeps a household of its own, with a `self` entry
 *    carrying *their* full name and birth date. A fellow planner's
 *    self entry is what their own household calls them — "Erika
 *    Beispiel", not the "Erika" they typed at signup — and that is the
 *    name the organiser's household knows them by. So the household
 *    entry is compared against the account's full name too, and a
 *    birth date on both sides that disagrees says two people, whatever
 *    the names say.
 *
 * The display name stays as the last fallback, for an account that has
 * never filled in its own household.
 *
 * Pure: two records in, a verdict out.
 */

export interface HouseholdEntry {
  /** Whose household this entry is in — the account it belongs to. */
  ownerId: number;
  /** `self` marks the owner's own entry; everything else is somebody else. */
  relationKind: string;
  name: string;
  /** `YYYY-MM-DD`, when the household knows it. */
  birthDate?: string | null;
}

export interface Account {
  id: number;
  /** The display name — whatever was typed at signup. */
  name: string;
  /** The full name from the account's own household `self` entry, if any. */
  selfName?: string | null;
  /** The birth date from that same entry, if any. */
  selfBirthDate?: string | null;
}

/** True when the household entry and the account describe one person. */
export function samePerson(entry: HouseholdEntry, account: Account): boolean {
  if (entry.relationKind === "self") {
    // The owner's own entry is the owner, whatever they called
    // themselves in either place — and it is nobody else, whatever the
    // names happen to say.
    return account.id === entry.ownerId;
  }
  const entryName = normalise(entry.name);
  const byName = [account.selfName, account.name]
    .filter((name): name is string => typeof name === "string" && name.trim() !== "")
    .some((name) => normalise(name) === entryName);
  if (!byName) return false;
  // Same name, different birthday: two people, not one. A missing date
  // on either side says nothing either way.
  if (entry.birthDate && account.selfBirthDate && entry.birthDate !== account.selfBirthDate) {
    return false;
  }
  return true;
}

/** Case, surrounding space and doubled spaces are not identity. */
function normalise(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}
