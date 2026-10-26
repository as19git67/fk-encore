import type { Area } from "./index";

export const PHOTOS_AREA: Area = {
  id: "photos",
  description: "Fotos: photos by date, place, person, quality and favourites, search by content, a photo's details, albums and their shares, people, recaps, comments and activity, collages.",
  tools: [
    "list_photos",
    "photo_details",
    "search_photos",
    "list_recaps",
    "list_albums",
    "list_album_shares",
    "photo_comments",
    "photo_activity",
    "list_persons",
    "create_album",
    "add_photos_to_album",
    "set_photo_favorite",
    "create_photo_collage",
  ],
  rules: [
    "Photos (list_photos, search_photos) appear as a grid of pictures right below your answer. Never list them in your text — no ids, no table, no list of dates or places; say in a sentence or two how many there are and what they show (period, place), and leave the pictures to the grid.",
    'Hidden photos (ausgeblendet) are what the user put out of sight: every photo tool leaves them out of results, counts and new albums, and that is what you answer with. Set hidden = "include" (also the hidden ones) or hidden = "only" (just the hidden ones) only when the user asks for hidden photos in so many words ("auch die ausgeblendeten", "meine ausgeblendeten Fotos"), and keep it on the follow-up calls of that request. Never mention that hidden photos exist unless asked.',
    'A place, a period, a person or "die besten" is list_photos with its filters; search_photos is only for what is in the picture ("Strand", "Hund", "Sonnenuntergang"). Questions about a photo\'s metadata (where, when, who, which keywords, how good) → photo_details(ids).',
  ],
  examples: [
    '"Leg ein Album mit allen Favoriten von 2025 an." → create_album(name = "Favoriten 2025", photos = {favorite: true, date_from: "2025-01-01", date_to: "2025-12-31"}) → say the album is proposed with the count the tool printed and waits for "Ausführen".',
    'After an answer listing photos: "Nur die aus München, und mach daraus ein Album." → list_photos(from_previous_result = true, place = "München") → create_album(name = …, from_previous_result = true) → say what was proposed.',
    '"Zeige mir die 20 besten Fotos aus Beispielland." → list_photos(place = "Beispielland", rank_by = "quality", limit = 20) → say how many photos from there are and that the best are shown; "die besten" is rank_by = "quality", not favorite = true, and a place is list_photos(place), never search_photos.',
    '"Zeige mir 50 Fotos, bei denen die Beschreibung einen Inhalt hat." → list_photos(has_description = true, limit = 50).',
    '"Such für jedes Jahr das Foto mit Max mit den meisten Likes und leg es ins Album Beste Kinder." → list_persons → list_albums(q = "Beste Kinder") → list_photos(person_ids = [the id of Max], rank_by = "favorites_count", group_by = "year") → add_photos_to_album(album_id = the album\'s id, from_previous_result = true) → say which photo per year was picked and that the album change waits for "Ausführen". "Für jedes Jahr/jeden Monat das …" is always one list call with group_by, never one call per year; "die wenigsten" is direction = "asc".',
  ],
  keywords:
    "foto|bild|album|alben|collage|favorit|ausgeblendet|kommentar|kommentiert|like|person|aufgenommen|bibliothek|rückblick|"
    + "photo|picture|image|favourite|favorite|comment|recap",
};
