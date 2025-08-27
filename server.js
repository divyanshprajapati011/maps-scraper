import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import bodyParser from "body-parser";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import pool from "./db.js";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";

dotenv.config();
const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";

// simple sleep helper
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- SQL bootstrap (creates tables if not exist) ---
async function ensureTables(){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      email VARCHAR(100) UNIQUE NOT NULL,
      mobile VARCHAR(20) UNIQUE NOT NULL,
      password TEXT NOT NULL
    );
  `);
  await pool.query(`
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
  `);
}
ensureTables().catch(console.error);

// --- Auth middleware ---
function auth(req,res,next){
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if(!token) return res.status(401).json({success:false, message:"No token"});
  try{
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  }catch(e){
    return res.status(401).json({success:false, message:"Invalid token"});
  }
}

// --- Routes ---
app.post("/api/signup", async (req, res) => {
  const { username, email, mobile, password } = req.body;
  try {
    if(!username || !email || !mobile || !password){
      return res.json({success:false, message:"All fields are required"});
    }
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      "INSERT INTO users (username,email,mobile,password) VALUES ($1,$2,$3,$4)",
      [username, email, mobile, hash]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    if (err.code === "23505") {
      res.json({ success: false, message: "User/email/mobile already exists" });
    } else {
      res.json({ success: false, message: "Signup failed" });
    }
  }
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query("SELECT * FROM users WHERE username=$1", [username]);
    if (result.rows.length === 0) return res.json({ success: false, message: "User not found" });
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.json({ success: false, message: "Wrong password" });
    const token = jwt.sign({ id:user.id, username:user.username }, JWT_SECRET, { expiresIn:"6h" });
    res.json({ success:true, token });
  } catch (err) {
    console.error(err);
    res.json({ success:false, message:"Login failed" });
  }
});

// Helper: extract first email via regex from HTML string
function extractEmailFromHtml(html){
  const matches = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
  if(!matches) return null;
  const uniq = Array.from(new Set(matches)).filter(e=>!e.toLowerCase().includes("example."));
  return uniq[0] || null;
}

// scrape route
app.post("/api/scrape", auth, async (req, res) => {
  const { query, max = 20 } = req.body;
  if (!query) return res.json({ success: false, message: "query is required" });
  const limit = Math.min(Number(max) || 20, 100);

  let browser;
  try {
    console.log("Launching Chromium...");

    // Launch puppeteer with Render-safe flags
    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
        "--disable-gpu",
      ],
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();

    // remove all timeouts
    page.setDefaultNavigationTimeout(0);
    page.setDefaultTimeout(0);

   // Open Google Maps search
const mapsUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
console.log("Opening Maps URL:", mapsUrl);

await page.goto(mapsUrl, { waitUntil: "domcontentloaded", timeout: 120000 });

// Try to dismiss consent/geo banners quietly
try {
  await page.waitForSelector('form[action*="consent"] button, button[aria-label*="Accept"]', { timeout: 5000 });
  await page.evaluate(() => {
    const b = document.querySelector('form[action*="consent"] button, button[aria-label*="Accept"]');
    b && b.click();
  });
} catch {}

// Wait for the results feed to appear
const FEED = "div[role='feed']";
await page.waitForSelector(FEED, { timeout: 60000 });
console.log("Results feed detected");

// Helper: scroll the left feed to load more cards
async function loadEnough(count) {
  let seen = 0;
  let stagnant = 0;
  for (let i = 0; i < 40; i++) {
    // count anchors that point to /maps/place/ (works on new UI)
    const n = await page.$$eval(`${FEED} a[href*="/maps/place/"]`, els => els.length);
    console.log("loaded cards:", n);
    if (n >= count) return;

    await page.evaluate((sel) => {
      const feed = document.querySelector(sel);
      if (feed) feed.scrollBy(0, 1000);
      window.scrollBy(0, 100); // fallback
    }, FEED);

    await sleep(1200);

    if (n === seen) stagnant++; else stagnant = 0;
    seen = n;
    if (stagnant >= 6) return; // nothing new is loading
  }
}

await loadEnough(limit);

// Now collect items (we will re-query every iteration to avoid stale handles)
const data = [];
const take = Math.min(
  await page.$$eval(`${FEED} a[href*="/maps/place/"]`, els => els.length),
  limit
);

console.log(`Scraping up to ${take} results...`);

let lastName = null;
for (let i = 0; i < take; i++) {
  console.log(`Item ${i + 1}/${take}`);

  // Re-query each loop so we don't hold stale element handles
  const clicked = await page.evaluate((sel, index) => {
    const list = Array.from(document.querySelectorAll(`${sel} a[href*="/maps/place/"]`));
    const el = list[index];
    if (el) {
      el.scrollIntoView({ block: "center" });
      (el as HTMLElement).click();
      return true;
    }
    return false;
  }, FEED, i);

  if (!clicked) continue;

  await page.waitForTimeout(1500);

  // Wait for place header (business name) to appear
  let name = "";
  try {
    await page.waitForSelector("h1.DUwDvf, h1[aria-level='1']", { timeout: 15000 });
    name = await page.evaluate(() => {
      const a = document.querySelector("h1.DUwDvf")?.textContent?.trim();
      const b = document.querySelector('h1[aria-level="1"]')?.textContent?.trim();
      return a || b || "";
    });
  } catch {
    console.log("No name found, skipping");
    continue;
  }

  if (!name || name === lastName) {
    console.log("Duplicate/empty name, skipping");
    continue;
  }
  lastName = name;

  // Extract details safely from the details pane
  const place = await page.evaluate(() => {
    const qs  = (s) => document.querySelector(s);
    const qsa = (s) => Array.from(document.querySelectorAll(s));

    const pickText = (el) => (el && (el.textContent || "").trim()) || "";

    const name =
      pickText(qs("h1.DUwDvf")) ||
      pickText(qs('h1[aria-level="1"]'));

    const address = pickText(qs('button[data-item-id*="address"]'));

    const phoneBtn = qsa('button[data-item-id*="phone"]').find(Boolean);
    const phone = pickText(phoneBtn);

    let website = (qs('a[data-item-id="authority"]')?.getAttribute("href")) || "";
    if (website && website.includes("http")) {
      const m = website.match(/https?:\/\/[^\s"]+/);
      if (m) website = m[0];
    }

    // rating
    let rating = "";
    const r1 = qs("span.F7nice");
    if (r1) rating = pickText(r1);

    // reviews (parse from aria-label if present)
    let reviews = 0;
    const revBtn = qsa("button").find(b => (b.getAttribute("aria-label") || "").toLowerCase().includes("reviews"));
    if (revBtn) {
      const m = (revBtn.getAttribute("aria-label") || "").match(/[\d,\.]+/);
      if (m) reviews = parseInt(m[0].replace(/[,\.\s]/g, ""), 10);
    }

    // description (if present in the pane)
    const desc =
      pickText(qs("div[jsaction*='pane'] div[aria-label][jsan*='description']")) ||
      pickText(qs("div[jsname='bN97Pc']"));

    return { name, address, phone, website, description: desc, rating, reviews };
  });

  data.push({
    name: place.name || "",
    email: "", // (optional) you can add website crawling later
    mobile: place.phone || "",
    address: place.address || "",
    website: place.website || "",
    description: place.description || "",
    rating: place.rating ? String(place.rating) : "",
    reviews: place.reviews || 0,
  });
}

console.log("Scraping finished!");
res.json({ success: true, results: data });

    if (browser) await browser.close().catch(() => {});
  }
});
