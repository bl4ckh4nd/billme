-- Lite bank accounts do not carry a default SKR account number.
ALTER TABLE accounts ALTER COLUMN default_skr_account_number DROP NOT NULL;
