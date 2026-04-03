-- Extend the scan_service enum with 'geocoding' for automatic reverse-geocoding
-- of GPS coordinates extracted from photo EXIF data.
ALTER TYPE scan_service ADD VALUE IF NOT EXISTS 'geocoding';
