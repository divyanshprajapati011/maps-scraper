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

    // disable timeouts
    page.setDefaultNavigationTimeout(0);
    page.setDefaultTimeout(0);

    // Open Google Maps search
    const mapsUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
    console.log("Opening Maps URL:", mapsUrl);

    await page.goto(mapsUrl, { waitUntil: "domcontentloaded", timeout: 0 });
    console.log("Maps page loaded, waiting for results...");

    // Wait for left-panel results list
    await page.waitForSelector("div[role='feed']", { timeout: 60000 });
    console.log("Results panel detected!");

    // Scroll to load enough items
    const resultsSelector = "div[role='feed'] > div:not([jscontroller*='lxa'])";
    async function loadEnough(count) {
      for (let tries = 0; tries < 20; tries++) {
        const num = await page.$$eval(resultsSelector, (els) => els.length);
        console.log(`Loaded items: ${num}`);
        if (num >= count) break;
        await page.evaluate(() => {
          const scroller = document.querySelector("div[role='feed']");
          scroller && scroller.scrollBy(0, 1000);
        });
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
    await loadEnough(limit);

    const items = await page.$$(resultsSelector);
    const take = Math.min(items.length, limit);
    const data = [];

    console.log(`Scraping ${take} results...`);

    for (let i = 0; i < take; i++) {
      console.log(`Scraping item ${i + 1} of ${take}...`);

      await items[i].click();
      // wait until business name is visible
      await page.waitForSelector("h1 span", { timeout: 8000 }).catch(() => {});

      const place = await page.evaluate(() => {
        const qs = (s) => document.querySelector(s);
        const qsa = (s) => Array.from(document.querySelectorAll(s));

        const name =
          qs("h1 span")?.innerText?.trim() || null;

        const address =
          qsa("button[data-item-id*='address']")?.[0]?.innerText?.trim() || null;

        const phone =
          qsa("button[data-item-id*='phone']")?.[0]?.innerText?.trim() || null;

        let website =
          qsa("a[data-item-id='authority']")?.[0]?.href || null;
        if (website && website.includes("http")) {
          website = website.match(/https?:\/\/[^\s"]+/)?.[0] || website;
        }

        const rating =
          qs("span[aria-label*='stars']")?.innerText?.trim() ||
          null;

        let reviews = null;
        const reviewsBtn = qsa("button").find((b) =>
          (b.getAttribute("aria-label") || "").toLowerCase().includes("reviews")
        );
        if (reviewsBtn) {
          const m = reviewsBtn.getAttribute("aria-label").match(/([\d,\.]+)/);
          reviews = m ? parseInt(m[1].replace(/[,.]/g, "")) : null;
        }

        const description =
          qs("div[jsaction*='pane'] div[aria-label]")?.innerText?.trim() ||
          null;

        return { name, address, phone, website, description, rating, reviews };
      });

      data.push({
        name: place.name || "",
        email: "", // (skip email for speed, can add later)
        mobile: place.phone || "",
        address: place.address || "",
        website: place.website || "",
        description: place.description || "",
        rating: place.rating || "",
        reviews: place.reviews || 0,
      });
    }

    console.log("Scraping finished!");
    res.json({ success: true, results: data });
  } catch (err) {
    console.error("SCRAPER ERROR:", err);
    res.json({ success: false, message: err.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});
