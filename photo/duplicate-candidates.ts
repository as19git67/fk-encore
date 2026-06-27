export const DUPLICATE_VISUAL_THRESHOLD = 0.995;

export interface DuplicateCandidateMember {
  photo_id: number;
  similarity_score: number | null;
  taken_at: string | null;
  width: number | null;
  height: number | null;
  latitude: number | null;
  longitude: number | null;
  description: string | null;
  keywords: string[];
}

export function isHighConfidenceDuplicateGroup(
  members: DuplicateCandidateMember[],
  albumsByPhotoId: Map<number, number[]>,
): boolean {
  if (members.length < 2 || members.some((m) => (m.similarity_score ?? -1) < DUPLICATE_VISUAL_THRESHOLD)) return false;
  const first = members[0]!;
  // Missing core metadata is not evidence of equality. Keep those groups in
  // normal review instead of upgrading a visual resemblance to a duplicate.
  if (!first.taken_at || first.width == null || first.height == null) return false;
  const normalize = (value: string | null) => value?.trim() ?? "";
  const sameNumber = (a: number | null, b: number | null) =>
    a == null || b == null ? a === b : Math.abs(a - b) <= 0.00001;
  const firstAlbums = JSON.stringify(albumsByPhotoId.get(first.photo_id) ?? []);
  const firstKeywords = JSON.stringify([...first.keywords].map((v) => v.trim().toLowerCase()).sort());
  return members.every((m) =>
    m.taken_at === first.taken_at
    && m.width === first.width
    && m.height === first.height
    && sameNumber(m.latitude, first.latitude)
    && sameNumber(m.longitude, first.longitude)
    && normalize(m.description) === normalize(first.description)
    && JSON.stringify([...m.keywords].map((v) => v.trim().toLowerCase()).sort()) === firstKeywords
    && JSON.stringify(albumsByPhotoId.get(m.photo_id) ?? []) === firstAlbums
  );
}

export function recommendDuplicatePhoto<T extends {
  photo_id: number; curation: string | null; ai_quality_score: number | null;
  width: number | null; height: number | null; created_at: string | null;
}>(members: T[]): number | null {
  return [...members].sort((a, b) => {
    const favorite = Number(b.curation === "favorite") - Number(a.curation === "favorite");
    if (favorite) return favorite;
    const quality = (b.ai_quality_score ?? -1) - (a.ai_quality_score ?? -1);
    if (quality) return quality;
    const resolution = (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0);
    if (resolution) return resolution;
    return Date.parse(b.created_at ?? "") - Date.parse(a.created_at ?? "") || b.photo_id - a.photo_id;
  })[0]?.photo_id ?? null;
}
