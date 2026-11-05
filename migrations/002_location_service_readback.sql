-- Extend existing device status with Android's confirmed global location setting.
-- This migration does not create another command transport or enable remote toggles.
ALTER TABLE device_state ADD COLUMN location_services_status TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE device_state ADD COLUMN location_services_timestamp INTEGER;
