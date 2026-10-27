/**
 * The file name under which a benchmark run is saved as JSON from the
 * benchmark page: the day it started, its id and a slug of its label, so
 * two downloads sort by date and tell their runs apart without opening them.
 */
export function benchRunFileName(run: { id: number; label: string; started_at: string }): string {
  const day = run.started_at.slice(0, 10)
  const slug = run.label
    .toLowerCase()
    .replace(/[^a-z0-9äöüß]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `benchmark-${day}-${run.id}${slug ? `-${slug}` : ''}.json`
}
