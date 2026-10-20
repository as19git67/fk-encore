// Attributes for every field whose text is a search term. Browser spell
// checking and autocorrect (iOS Safari above all) rewrite a typed term like
// "Mülr" into "Müller" or capitalise it; the filtered options the user wanted
// to tap vanish before they can. A search term is matched literally, so none
// of the browser's text help applies to it.
export const searchInputAttrs = {
  autocomplete: 'off',
  autocorrect: 'off',
  autocapitalize: 'off',
  spellcheck: 'false',
} as const

const filterInput = { root: searchInputAttrs }

// Global PassThrough for the filter inputs PrimeVue renders itself (the
// search field in the overlay of Select, MultiSelect, Listbox and the
// TreeSelect tree, and the text input of AutoComplete). Passed to
// `app.use(PrimeVue, { pt })` so no call site has to remember it.
export const searchInputPassThrough = {
  select: { pcFilter: filterInput },
  multiselect: { pcFilter: filterInput },
  listbox: { pcFilter: filterInput },
  tree: { pcFilterInput: filterInput },
  treeselect: { pcTree: { pcFilterInput: filterInput } },
  autocomplete: {
    pcInputText: filterInput,
    input: searchInputAttrs,
  },
}
