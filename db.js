// db.js (Integrazione e Schema per il design neon)
import { createClient } from "@libsql/client";
import dotenv from "dotenv";
dotenv.config();

export const turso = createClient({
  url: process.env.TURSO_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

export async function initDB() {
  await turso.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password TEXT,
      is_owner BOOLEAN DEFAULT 0,
      avatar_url TEXT DEFAULT 'https://via.placeholder.com/60/9c27b0/fff?text=User'
    )
  `);

  await turso.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anime_title TEXT,
      anime_image_url TEXT DEFAULT 'https://via.placeholder.com/150x200?text=Poster',
      active BOOLEAN DEFAULT 1,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await turso.execute(`
    CREATE TABLE IF NOT EXISTS quizzes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      session_id INTEGER,
      episodes_watched INTEGER,
      score INTEGER,
      rating INTEGER,
      qa_data TEXT,
      completed_at DATETIME
    )
  `);
  console.log("Database inizializzato con lo schema aggiornato per il design neon!");
}