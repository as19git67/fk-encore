/**
 * Flat category rows → a typeahead option list for the document category
 * picker.
 *
 * Two properties matter and are easy to get wrong:
 *
 * 1. **Every level** of the taxonomy must be offered, not just the first two.
 *    The taxonomy is three levels deep in places (Wohnen › Haus & Grund ›
 *    Grundsteuer); a two-level walk silently drops the deepest categories.
 * 2. **Typing a parent name must reveal its children.** Filtering on the leaf
 *    label alone means "Landwirtschaft" matches only the parent itself, so the
 *    user never gets to see which subcategories that area offers. Each option
 *    therefore carries its whole root→leaf path as `search` text.
 */

export interface CategoryNode {
  id: number
  slug: string
  name: string
  parent_id: number | null
}

export interface SlugOption {
  /** Display text; descendants are prefixed with one "— " per level. */
  label: string
  slug: string
  /** Lowercased text the typeahead matches against. */
  search: string
}

/**
 * Options in reading order: top-level categories alphabetically, each
 * immediately followed by its (also alphabetical) descendants.
 */
export function buildCategoryOptions(categories: readonly CategoryNode[]): SlugOption[] {
  const byName = (a: CategoryNode, b: CategoryNode) => a.name.localeCompare(b.name, 'de')
  const opts: SlugOption[] = []
  // Cycles or a missing parent row would otherwise loop / drop rows silently.
  const seen = new Set<number>()

  const walk = (parentId: number | null, depth: number, trail: string[]) => {
    const children = categories
      .filter((c) => (c.parent_id ?? null) === parentId)
      .slice()
      .sort(byName)
    for (const cat of children) {
      if (seen.has(cat.id)) continue
      seen.add(cat.id)
      const path = [...trail, cat.name]
      opts.push({
        label: depth === 0 ? cat.name : `${'— '.repeat(depth)}${cat.name}`,
        slug: cat.slug,
        // The slug joins the path so "landwirtschaft" also matches a child
        // whose display name never repeats the parent's wording.
        search: `${path.join(' ')} ${cat.slug.replace(/-/g, ' ')}`.toLowerCase(),
      })
      walk(cat.id, depth + 1, path)
    }
  }
  walk(null, 0, [])

  // Rows whose parent is unknown (stale cache, permission-filtered parent)
  // would be invisible otherwise — append them flat rather than lose them.
  for (const cat of categories.filter((c) => !seen.has(c.id)).slice().sort(byName)) {
    seen.add(cat.id)
    opts.push({
      label: cat.name,
      slug: cat.slug,
      search: `${cat.name} ${cat.slug.replace(/-/g, ' ')}`.toLowerCase(),
    })
  }

  return opts
}

/** Split a typeahead query into its search terms. */
export function queryTerms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

/**
 * All terms must appear somewhere in the option's search text, so
 * "landwirtschaft inst" narrows to the Instandhaltung subcategory while plain
 * "landwirtschaft" still lists the whole area.
 */
export function matchesQuery(option: SlugOption, terms: readonly string[]): boolean {
  return terms.every((t) => option.search.includes(t))
}

/** Filter helper for AutoComplete `@complete`: empty query → full list. */
export function filterOptions(options: readonly SlugOption[], query: string): SlugOption[] {
  const terms = queryTerms(query)
  if (terms.length === 0) return [...options]
  return options.filter((o) => matchesQuery(o, terms))
}
