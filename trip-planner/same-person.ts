/**
 * Is this household entry the same human as that account? (§3.5, §6.2)
 *
 * The travel group draws on two lists that describe people twice: the
 * household (`user_subject_persons`, full name, relation, birth date)
 * and the accounts that plan the trip (`users`, a display name). The
 * organiser is on both — as "Max Beispiel (Ehemann)" in the household
 * they keep, and as "Max" in the list of planners — and the screen
 * offered them twice.
 *
 * The join used to be the name, compared exactly. That is the weakest
 * possible key: the household holds full names and an account holds
 * whatever its owner typed at signup, and "Max Beispiel" is not "Max".
 * The household has a real key for one case, and it is the case that
 * matters: an entry whose relation kind is `self` *is* the account it
 * belongs to. The name stays as the fallback for everybody else, since
 * a spouse's account and a spouse's household entry share nothing but
 * what somebody wrote.
 *
 * Pure: two records in, a verdict out.
 */

export interface HouseholdEntry {
  /** Whose household this entry is in — the account it belongs to. */
  ownerId: number;
  /** `self` marks the owner's own entry; everything else is somebody else. */
  relationKind: string;
  name: string;
}

export interface Account {
  id: number;
  name: string;
}

/** True when the household entry and the account describe one person. */
export function samePerson(entry: HouseholdEntry, account: Account): boolean {
  if (entry.relationKind === "self") {
    // The owner's own entry is the owner, whatever they called
    // themselves in either place — and it is nobody else, whatever the
    // names happen to say.
    return account.id === entry.ownerId;
  }
  return normalise(entry.name) === normalise(account.name);
}

/** Case, surrounding space and doubled spaces are not identity. */
function normalise(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}
