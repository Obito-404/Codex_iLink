-- v6 changes the three scheduler body columns from plain text to the
-- versioned DurableTurnInput JSON envelope. The product is still in
-- development and deliberately does not reinterpret legacy queued work.
DELETE FROM inbound_messages;
DELETE FROM queued_turns;
DELETE FROM dispatch_intents;

