/**
 * Documents linked to a business, its assets and parcels (stage 4 of
 * betriebe-euer.md): a link is made only for a document the caller can
 * read, lands on a target of the same business, and the list carries the
 * document's meta as the documents module serves it. Data is synthetic.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { documents } from "~encore/clients";
import { sql } from "drizzle-orm";

import db from "../db/database";
import { financeBusiness } from "../db/schema";
import { createAsset, createBusiness, createParcel, linkBusinessDocument, listBusinessDocuments, unlinkBusinessDocument } from "./businesses";

const OWNER = 7320;
const MANAGE = ["module.finance", "finance.view", "finance.accounts.manage"];

function setAuth(userID: number, permissions: string[]) {
  vi.mocked(getAuthData).mockReturnValue({ userID: String(userID), permissions });
}

beforeEach(async () => {
  await db.execute(sql`INSERT INTO users (id, email, name, password_hash) VALUES (${OWNER}, ${`u${OWNER}@test.local`}, ${`User${OWNER}`}, 'x') ON CONFLICT (id) DO NOTHING`);
  await db.delete(financeBusiness);
  vi.mocked(documents.getDocument).mockReset();
});

describe("business documents", () => {
  it("links a readable document to the business, an asset or a parcel, lists it with its meta, and unlinks it", async () => {
    setAuth(OWNER, MANAGE);
    const farm = await createBusiness({ name: "Hof Beispielheim", kind: "landwirtschaft" });
    const barn = await createAsset({ id: farm.id, name: "Stall", kind: "gebaeude", acquisition_date: "2020-01-01", acquisition_cost: 120000 });
    const field = await createParcel({ id: farm.id, gemarkung: "Musterfeld", flurstueck: "12/3", usage: "acker" });

    vi.mocked(documents.getDocument).mockImplementation(async ({ id }: { id: number }) => {
      if (id === 404) throw new Error("not found");
      return { id, title: id === 71 ? "Pachtvertrag Musterfeld" : "Rechnung Dachdecker", original_filename: `${id}.pdf`, doc_date: "2025-03-01", category_slug: "landwirtschaft-pacht", correspondent_display: "Beispiel Agrar GbR", sender: null } as never;
    });

    const lease = await linkBusinessDocument({ id: farm.id, document_id: 71, target_kind: "parcel", target_id: field.id, note: "Pacht ab 2025" });
    expect(lease).toMatchObject({ target_kind: "parcel", target_id: field.id, target_name: "Musterfeld Flst. 12/3", note: "Pacht ab 2025", document: { id: 71, title: "Pachtvertrag Musterfeld" } });
    const invoice = await linkBusinessDocument({ id: farm.id, document_id: 72, target_kind: "asset", target_id: barn.id });
    expect(invoice.target_name).toBe("Stall");
    const general = await linkBusinessDocument({ id: farm.id, document_id: 73 });
    expect(general).toMatchObject({ target_kind: "business", target_id: null, target_name: null });

    await expect(linkBusinessDocument({ id: farm.id, document_id: 71, target_kind: "parcel", target_id: field.id })).rejects.toThrow(/already linked/);
    await expect(linkBusinessDocument({ id: farm.id, document_id: 404 })).rejects.toThrow(/not found or not readable/);
    await expect(linkBusinessDocument({ id: farm.id, document_id: 75, target_kind: "asset", target_id: 999999 })).rejects.toThrow(/does not belong/);
    await expect(linkBusinessDocument({ id: farm.id, document_id: 75, target_kind: "asset" })).rejects.toThrow(/target_id is required/);

    const list = await listBusinessDocuments({ id: farm.id });
    expect(list.items.map((l) => [l.document_id, l.target_kind, l.document?.title])).toEqual([
      [73, "business", "Rechnung Dachdecker"], [72, "asset", "Rechnung Dachdecker"], [71, "parcel", "Pachtvertrag Musterfeld"],
    ]);

    // A document the caller lost access to stays in the list, without its meta.
    vi.mocked(documents.getDocument).mockRejectedValue(new Error("forbidden"));
    expect((await listBusinessDocuments({ id: farm.id })).items.every((l) => l.document === null)).toBe(true);

    await unlinkBusinessDocument({ linkId: general.id });
    expect((await listBusinessDocuments({ id: farm.id })).items).toHaveLength(2);

    setAuth(OWNER, ["module.finance", "finance.view"]);
    await expect(unlinkBusinessDocument({ linkId: lease.id })).rejects.toThrow();
  });
});
