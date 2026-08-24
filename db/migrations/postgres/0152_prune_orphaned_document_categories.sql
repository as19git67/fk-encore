-- Remove document categories that the seed taxonomy no longer defines.
--
-- The classifier's label set is read from this table (loadTaxonomyForClassifier
-- in documents/document-ops.ts), while the hints that describe each label come
-- from documents/taxonomy.ts, matched by slug. A category that was dropped or
-- renamed in taxonomy.ts therefore stayed selectable here but lost its hint —
-- the model kept offering a label nobody described any more. The cloud audit
-- also compares against taxonomy.ts, so such a category could never be
-- confirmed: a 2026-08-24 run found 'vertraege-agbs' and
-- 'betriebliche-unterlagen' at 0 % agreement for exactly this reason.
--
-- The list below is the taxonomy as of this migration. It is deliberately a
-- point-in-time snapshot: later additions arrive through the seed, and a later
-- removal needs its own migration rather than silently widening this one.
--
-- Documents are moved to 'sonstiges' first. The FK is ON DELETE SET NULL, so
-- deleting outright would leave them with no category at all — and a document
-- whose category is pinned (category_source in cloud/user/system,
-- attributes_reviewed, a receipt) is skipped by runClassify's category guard,
-- so a re-classify would never give it one back. 'sonstiges' keeps them
-- visible, and unpinned ones get re-classified out of it normally.

CREATE TEMP TABLE orphaned_categories ON COMMIT DROP AS
SELECT id FROM document_categories WHERE slug NOT IN (
    'altersvorsorge', 'altersvorsorge-betrieblich',
    'altersvorsorge-gesetzlich', 'altersvorsorge-lebensversicherung',
    'altersvorsorge-rentenversicherung', 'anschaffungen', 'behoerden',
    'behoerden-bescheide', 'behoerden-mitteilungen',
    'behoerden-steuerbescheid', 'belege', 'beruf', 'beruf-arbeitsagentur',
    'beruf-arbeitsvertrag', 'beruf-betriebliche-unterlagen',
    'beruf-zeugnisse', 'betreuung', 'betreuung-bestellung',
    'betreuung-genehmigung', 'betreuung-korrespondenz',
    'betreuung-rechenschaftsbericht', 'betreuung-vermoegensverzeichnis',
    'bildung', 'bildung-zertifikate', 'bildung-zeugnisse', 'fahrzeug',
    'fahrzeug-papiere', 'fahrzeug-tuev', 'fahrzeug-versicherung',
    'fahrzeug-werkstatt', 'familie', 'familie-ausweise',
    'familie-familienleistungen', 'familie-schule', 'familie-urkunden',
    'finanzen', 'finanzen-bausparen', 'finanzen-gehalt',
    'finanzen-kirchensteuer', 'finanzen-kontoauszuege', 'finanzen-kredite',
    'finanzen-rechnungen', 'finanzen-sozialversicherung',
    'finanzen-spenden', 'finanzen-steuern', 'finanzen-wertpapiere',
    'gesundheit', 'gesundheit-arzt', 'gesundheit-befunde',
    'gesundheit-kasse', 'gesundheit-pflege', 'gesundheit-pflegekasse',
    'gesundheit-rezepte', 'gesundheit-schwerbehinderung',
    'kapitalanlage-immobilie', 'kapitalanlage-immobilie-anlage-v',
    'kapitalanlage-immobilie-eigentuemerversammlung',
    'kapitalanlage-immobilie-finanzierung',
    'kapitalanlage-immobilie-gebaeudeversicherung',
    'kapitalanlage-immobilie-grundsteuer',
    'kapitalanlage-immobilie-hausgeld',
    'kapitalanlage-immobilie-instandhaltung',
    'kapitalanlage-immobilie-kaufvertrag',
    'kapitalanlage-immobilie-mieteingaenge',
    'kapitalanlage-immobilie-mietvertrag',
    'kapitalanlage-immobilie-nebenkostenabrechnung',
    'kapitalanlage-immobilie-weg-jahresabrechnung', 'landwirtschaft',
    'landwirtschaft-instandhaltung', 'landwirtschaft-pacht',
    'landwirtschaft-steuer', 'landwirtschaft-versicherung', 'rechtliches',
    'rechtliches-nachlass', 'rechtliches-verfahren',
    'rechtliches-verfuegungen', 'rechtliches-vollmachten', 'sonstiges',
    'vereine', 'vereine-mitgliedschaft', 'vereine-urkunden',
    'versicherungen', 'versicherungen-berufsunfaehigkeit',
    'versicherungen-kranken', 'versicherungen-sach', 'vertraege',
    'vertraege-abos', 'vertraege-gas', 'vertraege-strom',
    'vertraege-telekom', 'wohnen', 'wohnen-haus',
    'wohnen-haus-eigentuemerversammlung', 'wohnen-haus-finanzierung',
    'wohnen-haus-gebaeudeversicherung', 'wohnen-haus-grundsteuer',
    'wohnen-haus-hausgeld', 'wohnen-haus-instandhaltung',
    'wohnen-haus-kaufvertrag', 'wohnen-haus-photovoltaik',
    'wohnen-haus-weg-jahresabrechnung', 'wohnen-kommunale-abgaben',
    'wohnen-miete', 'wohnen-nebenkosten', 'wohnen-versicherung'
);

UPDATE documents
SET category_id = (SELECT id FROM document_categories WHERE slug = 'sonstiges')
WHERE category_id IN (SELECT id FROM orphaned_categories)
  AND EXISTS (SELECT 1 FROM document_categories WHERE slug = 'sonstiges');

-- Children of an orphan are orphans themselves (they cannot be in the
-- taxonomy while their parent is not), so this only detaches rows already
-- queued for deletion.
UPDATE document_categories
SET parent_id = NULL
WHERE parent_id IN (SELECT id FROM orphaned_categories);

DELETE FROM document_categories WHERE id IN (SELECT id FROM orphaned_categories);
