import Database from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";

const dbPath = process.env.DATABASE_URL || "./data/app.db";
mkdirSync(dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL;");

// A fill-up log: one row per time the tank is filled.
// mpg is derived from the distance since the previous fill-up.
db.exec(`
  CREATE TABLE IF NOT EXISTS fillups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    odometer REAL NOT NULL,
    gallons REAL NOT NULL,
    price REAL NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

const publicDir = `${import.meta.dir}/public`;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

// Returns fill-ups ordered by odometer, each annotated with the miles driven
// and mpg since the previous (lower-odometer) fill-up.
function listFillups() {
  const rows = db
    .query("SELECT * FROM fillups ORDER BY odometer ASC, id ASC")
    .all() as any[];
  let prev: any = null;
  const enriched = rows.map((r) => {
    let miles: number | null = null;
    let mpg: number | null = null;
    if (prev && r.odometer > prev.odometer && r.gallons > 0) {
      miles = r.odometer - prev.odometer;
      mpg = miles / r.gallons;
    }
    prev = r;
    return { ...r, miles, mpg };
  });
  return enriched.reverse(); // newest (highest odometer) first for display
}

function stats() {
  const rows = listFillups();
  const withMpg = rows.filter((r) => r.mpg !== null);
  const totalMiles = withMpg.reduce((s, r) => s + (r.miles || 0), 0);
  const totalGallons = withMpg.reduce((s, r) => s + r.gallons, 0);
  const totalCost = rows.reduce((s, r) => s + (r.price || 0), 0);
  const avgMpg = totalGallons > 0 ? totalMiles / totalGallons : null;
  const costPerMile = totalMiles > 0 ? totalCost / totalMiles : null;
  return {
    count: rows.length,
    totalMiles,
    avgMpg,
    totalCost,
    costPerMile,
  };
}

const server = {
  port: process.env.PORT || 3000,
  async fetch(req: Request) {
    const url = new URL(req.url);
    const { pathname } = url;

    // ---- API ----
    if (pathname === "/api/fillups" && req.method === "GET") {
      return json({ fillups: listFillups(), stats: stats() });
    }

    if (pathname === "/api/fillups" && req.method === "POST") {
      try {
        const body = (await req.json()) as any;
        const date = String(body.date || "").trim();
        const odometer = Number(body.odometer);
        const gallons = Number(body.gallons);
        const price = Number(body.price) || 0;
        const note = String(body.note || "").trim();
        if (!date || !Number.isFinite(odometer) || !Number.isFinite(gallons)) {
          return json({ error: "date, odometer and gallons are required" }, 400);
        }
        if (odometer < 0 || gallons < 0 || price < 0) {
          return json({ error: "values cannot be negative" }, 400);
        }
        db.query(
          "INSERT INTO fillups (date, odometer, gallons, price, note) VALUES (?, ?, ?, ?, ?)"
        ).run(date, odometer, gallons, price, note);
        return json({ fillups: listFillups(), stats: stats() }, 201);
      } catch {
        return json({ error: "invalid request body" }, 400);
      }
    }

    const del = pathname.match(/^\/api\/fillups\/(\d+)$/);
    if (del && req.method === "DELETE") {
      db.query("DELETE FROM fillups WHERE id = ?").run(Number(del[1]));
      return json({ fillups: listFillups(), stats: stats() });
    }

    // ---- Static ----
    const filePath = `${publicDir}${pathname === "/" ? "/index.html" : pathname}`;
    const file = Bun.file(filePath);
    if (await file.exists()) return new Response(file);

    return new Response("Not found", { status: 404 });
  },
};

export default server;
