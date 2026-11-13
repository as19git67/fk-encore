import { reactive } from 'vue'
import type { Proposal } from '../api/assistant'

/**
 * What became of each card in this session, by proposal id. A card shows
 * the state its answer carried when it arrived: the card of a running answer
 * is replaced by the stored answer's card once the turn ends, and both carry
 * "pending" if the user clicked "Ausführen" in between — the card came back
 * with its buttons and a second click ran into "already executed". Every
 * card reads its decided state from here, so a newer copy starts as done.
 */
const decided = reactive(new Map<number, Proposal>())

/** Notes what a card's decision returned; a pending one (a failure) changes nothing. */
export function rememberProposal(p: Proposal): void {
  if (p.status !== 'pending') decided.set(p.proposal_id, p)
}

/** The proposal as this session last saw it decided, else as given. */
export function latestProposal(p: Proposal): Proposal {
  const known = decided.get(p.proposal_id)
  if (!known || p.status !== 'pending' && p.status !== 'executing') return p
  return { ...known, count: known.count ?? p.count }
}

/** The decided state of one proposal, reactive. */
export function decidedProposal(id: number): Proposal | undefined {
  return decided.get(id)
}

/** For tests. */
export function __resetProposalStatesForTests(): void {
  decided.clear()
}
