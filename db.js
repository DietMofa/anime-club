import { createClient } from "@libsql/client";
import dotenv from "dotenv";

dotenv.config();

// Il codice ora cerca entrambe le versioni dei nomi che abbiamo usato finora
const dbUrl = process.env.TURSO_URL || process.env.TURSO_DATABASE_URL;
const dbToken = process.env.TURSO_TOKEN || process.env.TURSO_AUTH_TOKEN;

// Controllo di sicurezza: se il token è vuoto, lo segnala subito nei log di Render
if (!dbToken) {
    console.error("🚨 ALLARME CRITICO: Il Server non riesce a leggere il token di Turso dalle variabili di Render!");
}

export const turso = createClient({
  url: dbUrl,
  authToken: dbToken,
});

export async function initDB() {
  try {
    // 1. TABELLA UTENTI
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        avatar_url TEXT,
        is_owner INTEGER DEFAULT 0
      );
    `);

    // 2. TABELLA SESSIONI ANIME
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        anime_title TEXT NOT NULL,
        anime_image_url TEXT,
        active INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 3. TABELLA QUIZ E PUNTEGGI
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS quizzes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        session_id INTEGER,
        score INTEGER DEFAULT 0,
        completed_at TEXT,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
        FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE SET NULL
      );
    `);

    console.log("📂 Database allineato e connesso con successo!");
  } catch (error) {
    console.error("❌ Errore inizializzazione DB:", error);
  }
}
