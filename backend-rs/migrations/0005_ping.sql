-- Ping monitors, migration 5.
--
-- Added after the M5 import validation showed the operator's fleet keeps
-- three ICMP monitors. The checker runs the system `ping` binary (iputils
-- in the image) with the same contract as the Node implementation:
-- count/packet size/per-request timeout/global deadline, first reply time
-- as the reading.

ALTER TABLE monitors ADD COLUMN hostname TEXT;
ALTER TABLE monitors ADD COLUMN packet_size INTEGER NOT NULL DEFAULT 56;
ALTER TABLE monitors ADD COLUMN ping_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE monitors ADD COLUMN ping_numeric INTEGER NOT NULL DEFAULT 1;
ALTER TABLE monitors ADD COLUMN ping_per_request_timeout INTEGER NOT NULL DEFAULT 2;
