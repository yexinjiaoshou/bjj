UPDATE positions SET category = 'control' WHERE category = 'pin';

CREATE TRIGGER positions_reject_pin_insert
BEFORE INSERT ON positions
WHEN NEW.category = 'pin'
BEGIN
    SELECT RAISE(ABORT, 'pin category has been merged into control');
END;

CREATE TRIGGER positions_reject_pin_update
BEFORE UPDATE OF category ON positions
WHEN NEW.category = 'pin'
BEGIN
    SELECT RAISE(ABORT, 'pin category has been merged into control');
END;