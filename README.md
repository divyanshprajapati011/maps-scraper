# Maps Scraper (Node + Puppeteer + PostgreSQL/Supabase)

This is a ready-to-run app that:
- Provides **Signup/Login** (username, email, mobile, password) using Supabase PostgreSQL
- Scrapes **Google Maps** results with Puppeteer
- Extracts **Business Name, Email, Mobile, Address, Website, Description, Rating, Reviews**
- Serves the frontend via Express at `http://localhost:5000`

## Prerequisites
- Node.js 18+
- Your Supabase Postgres credentials (already placed in `.env` for convenience)

## Setup
```bash
npm install
npm start
```

Open: http://localhost:5000

## Notes
- Puppeteer scrapes Google Maps; selectors can change over time.
- Email extraction is done from the business website (homepage, then tries contact page).
- For production, rotate proxies and update the `JWT_SECRET` in `.env`.
