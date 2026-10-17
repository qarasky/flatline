-- Monitor hosting provider, migration 10.
--
-- A free-form id, usually a domain ("hetzner", "digitalocean.com"), drawn as a
-- transparent logo next to the card title on the Superboard. Display-only: the
-- server stores the string and never acts on it, and the provider catalog lives
-- in the frontend, so adding a provider needs no migration here.
--
-- Imported from the Node database when the column exists there; rows created
-- before this migration simply have no provider and draw no logo.

ALTER TABLE monitors ADD COLUMN provider TEXT;
