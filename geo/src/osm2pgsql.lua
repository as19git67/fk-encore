-- osm2pgsql Flex configuration for the fk-encore geo service.
--
-- Produces three tables per region database:
--   osm_highways  (lines, used by /reverse street lookup)
--   osm_pois      (points, used by /reverse POI lookup and /pois)
--   osm_admin     (multipolygons, used by /reverse city/country lookup)
--
-- The filter set mirrors what the application actually queries — we
-- intentionally drop everything else so the database stays small and
-- the GIST indexes stay fast. To extend it, edit the four allow-lists
-- below; nothing else in the geo service depends on table shape
-- beyond these column names.

local tables = {}

tables.highways = osm2pgsql.define_table({
  name = 'osm_highways',
  ids = { type = 'way', id_column = 'osm_id' },
  columns = {
    { column = 'name',        type = 'text' },
    { column = 'highway',     type = 'text' },
    { column = 'housenumber', type = 'text' },
    { column = 'geom',        type = 'linestring', projection = 4326, not_null = true },
  },
})

tables.pois = osm2pgsql.define_table({
  name = 'osm_pois',
  ids = { type = 'any', id_column = 'osm_id', type_column = 'osm_type' },
  columns = {
    { column = 'kind', type = 'text' },
    { column = 'name', type = 'text' },
    { column = 'tags', type = 'jsonb' },
    { column = 'geom', type = 'point', projection = 4326, not_null = true },
  },
})

tables.admin = osm2pgsql.define_table({
  name = 'osm_admin',
  ids = { type = 'area', id_column = 'osm_id' },
  columns = {
    { column = 'name',        type = 'text' },
    { column = 'admin_level', type = 'int' },
    { column = 'geom',        type = 'multipolygon', projection = 4326, not_null = true },
  },
})

-- Highway values worth keeping for nearest-street lookup. Motorways
-- and trunks are intentionally excluded — we only want streets a
-- pedestrian could plausibly stand on while taking a photo.
local highway_values = {
  residential = true, primary = true, secondary = true, tertiary = true,
  unclassified = true, living_street = true, footway = true, path = true,
  pedestrian = true, service = true, track = true, cycleway = true,
}

-- POI tag filters — must stay in sync with osm-admin/poi.config.ts.
-- A value of '*' means "match any non-empty value for this key".
local poi_filters = {
  tourism  = { attraction = true, museum = true, artwork = true, viewpoint = true, gallery = true, monument = true },
  historic = '*',
  amenity  = { place_of_worship = true, theatre = true },
  building = { castle = true, cathedral = true, church = true, monastery = true, palace = true },
  man_made = { tower = true, lighthouse = true, bridge = true, obelisk = true },
}

-- Tag keys preserved in the jsonb `tags` column. The POI matcher
-- needs name, name:de, wikidata and wikipedia; the matched filter
-- keys are also kept so the admin UI can render "why was this a
-- candidate".
local poi_tag_allowlist = {
  ['name']     = true, ['name:de']  = true,
  ['wikidata'] = true, ['wikipedia'] = true,
  ['tourism']  = true, ['historic']  = true, ['amenity'] = true,
  ['building'] = true, ['man_made']  = true,
}

local function matches_poi(tags)
  for key, allowed in pairs(poi_filters) do
    local v = tags[key]
    if v ~= nil and v ~= '' then
      if allowed == '*' then return key, v end
      if allowed[v] then return key, v end
    end
  end
  return nil, nil
end

local function poi_tag_subset(tags)
  local out = {}
  for k, v in pairs(tags) do
    if poi_tag_allowlist[k] then out[k] = v end
  end
  return out
end

function osm2pgsql.process_node(object)
  local kind, val = matches_poi(object.tags)
  if kind then
    tables.pois:insert({
      kind = kind .. '=' .. val,
      name = object.tags.name,
      tags = poi_tag_subset(object.tags),
      geom = object:as_point(),
    })
  end
end

function osm2pgsql.process_way(object)
  local hwy = object.tags.highway
  if hwy and highway_values[hwy] then
    tables.highways:insert({
      name = object.tags.name,
      highway = hwy,
      housenumber = object.tags['addr:housenumber'],
      geom = object:as_linestring(),
    })
  end

  local kind, val = matches_poi(object.tags)
  if kind and object.is_closed then
    tables.pois:insert({
      kind = kind .. '=' .. val,
      name = object.tags.name,
      tags = poi_tag_subset(object.tags),
      geom = object:as_polygon():centroid(),
    })
  end
end

function osm2pgsql.process_relation(object)
  -- Administrative boundaries → osm_admin.
  if object.tags.boundary == 'administrative' and object.tags.admin_level then
    local lvl = tonumber(object.tags.admin_level)
    if lvl and object.tags.type == 'boundary' then
      tables.admin:insert({
        name = object.tags.name,
        admin_level = lvl,
        geom = object:as_multipolygon(),
      })
    end
  end

  -- Multipolygon POIs (e.g. complex castle outlines) collapse to their centroid.
  if object.tags.type == 'multipolygon' then
    local kind, val = matches_poi(object.tags)
    if kind then
      tables.pois:insert({
        kind = kind .. '=' .. val,
        name = object.tags.name,
        tags = poi_tag_subset(object.tags),
        geom = object:as_multipolygon():centroid(),
      })
    end
  end
end
