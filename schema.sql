-- Run this only if you want manual setup; the server also ensures tables exist.
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(100) UNIQUE NOT NULL,
  mobile VARCHAR(20) UNIQUE NOT NULL,
  password TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS businesses (
  id SERIAL PRIMARY KEY,
  name TEXT,
  email TEXT,
  mobile TEXT,
  address TEXT,
  website TEXT,
  description TEXT,
  rating NUMERIC,
  reviews INT,
  scraped_at TIMESTAMP DEFAULT NOW()
);
