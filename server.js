import express from "express";
import session from "express-session";
import bcrypt from "bcrypt";
import dotenv from "dotenv";
import { turso, initDB } from "./db.js";
import { generateAnimeQuiz } from "./ai.js";

dotenv.config();
const app = express();

app.set("view engine", "ejs");
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({ secret: "anime-secret-neon", resave: false, saveUninitialized: true }));
app.use(express.static("public"));

// Inizializza le tabelle del Database all'avvio
initDB();

// Middleware di protezione
const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.redirect("/login");
  next();
};

// ==========================================
// 1. ROTTE DI BASE E AUTENTICAZIONE
// ==========================================

app.get("/", (req, res) => {
  res.redirect("/dashboard");
});

app.get("/login", (req, res) => {
  res.render("login"); 
});

app.post("/login", async (req, res) => {
  try {
    const username = req.body.username || "";
    const result = await turso.execute({ 
      sql: "SELECT * FROM users WHERE username = ?", 
      args: [username] 
    });
    const user = result.rows[0];

    if (user && await bcrypt.compare(req.body.password, user.password)) {
      req.session.userId = user.id;
      req.session.isOwner = user.is_owner;
      req.session.username = user.username;
      req.session.avatarUrl = user.avatar_url;
      res.redirect("/dashboard");
    } else {
      res.send("Credenziali errate. <a href='/login'>Riprova qui</a>");
    }
  } catch (error) {
    console.error("Errore critico durante il login:", error);
    // MODIFICA DIAGNOSTICA: Mostra l'errore reale nel browser così capiamo cos'ha Turso
    res.status(500).send(`❌ ERRORE DATABASE DURANTE IL LOGIN: ${error.message}`);
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});


// ==========================================
// 2. ROTTA DASHBOARD (ANTI-CRASH)
// ==========================================
app.get("/dashboard", requireAuth, async (req, res) => {
  let activeSession = null;
  let allUsers = [];
  let totalLeaderboard = [];
  let leaderboardsByAnime = {};

  try {
    const sessionData = await turso.execute("SELECT * FROM sessions WHERE active = 1 ORDER BY id DESC LIMIT 1");
    activeSession = sessionData.rows[0];
    
    const allUsersResult = await turso.execute("SELECT id, username, avatar_url, is_owner FROM users");
    allUsers = allUsersResult.rows;
    
    const currentUser = allUsers.find(u => u.id === req.session.userId);
    if (currentUser) {
      req.session.avatarUrl = currentUser.avatar_url;
    }
  } catch (err) {
    console.error("Errore database dati vitali:", err);
    return res.status(500).send(`Errore critico dati vitali: ${err.message}`);
  }

  try {
    const totalLeaderboardResult = await turso.execute(`
      SELECT u.username, u.avatar_url, SUM(q.score) as total_score
      FROM quizzes q
      JOIN users u ON q.user_id = u.id
      WHERE q.completed_at IS NOT NULL
      GROUP BY u.id, u.username, u.avatar_url
      ORDER BY total_score DESC
    `);
    totalLeaderboard = totalLeaderboardResult.rows;
  } catch (err) {
    console.warn("⚠️ Classifica globale non ancora disponibile:", err.message);
  }

  try {
    const animeLeaderboardResult = await turso.execute(`
      SELECT s.anime_title, u.username, u.avatar_url, SUM(q.score) as score
      FROM quizzes q
      JOIN users u ON q.user_id = u.id
      JOIN sessions s ON q.session_id = s.id
      WHERE q.completed_at IS NOT NULL
      GROUP BY s.anime_title, u.id, u.username, u.avatar_url
      ORDER BY s.anime_title ASC, score DESC
    `);
    
    animeLeaderboardResult.rows.forEach(row => {
      if (!leaderboardsByAnime[row.anime_title]) leaderboardsByAnime[row.anime_title] = [];
      leaderboardsByAnime[row.anime_title].push(row);
    });
  } catch (err) {
    console.warn("⚠️ Classifica anime non ancora disponibile:", err.message);
  }

  res.render("dashboard", {
    user: req.session,
    avatarUrl: req.session.avatarUrl || 'https://images.unsplash.com/photo-1578632767115-351597cf2477?w=150',
    activeSession,
    users: allUsers,
    otherUsers: allUsers.filter(u => u.id !== req.session.userId),
    totalLeaderboard,
    leaderboardsByAnime
  });
});


// ==========================================
// 3. API & LOGICA FUNZIONALE
// ==========================================

app.get("/api/search-anime", requireAuth, async (req, res) => {
  const query = req.query.q;
  if (!query || query.length < 3) return res.json([]);
  try {
    const response = await fetch(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(query)}&limit=5`);
    const data = await response.json();
    res.json(data.data.map(anime => ({ title: anime.title, image_url: anime.images.jpg.image_url })));
  } catch (error) { res.status(500).json([]); }
});

app.post("/session/start", requireAuth, async (req, res) => {
  if (!req.session.isOwner) return res.status(403).send("Azione riservata all'owner.");
  const { anime_title, anime_image_url } = req.body;
  try {
    await turso.execute("UPDATE sessions SET active = 0 WHERE active = 1");
    await turso.execute({
      sql: "INSERT INTO sessions (anime_title, anime_image_url, active) VALUES (?, ?, 1)",
      args: [anime_title, anime_image_url]
    });
    res.redirect("/dashboard");
  } catch (error) {
    console.error(error);
    res.status(500).send("Errore nell'avvio della sessione.");
  }
});

app.post("/profile/update", requireAuth, async (req, res) => {
  const newAvatar = req.body.avatar_url;
  try {
    await turso.execute({ 
      sql: "UPDATE users SET avatar_url = ? WHERE id = ?", 
      args: [newAvatar, req.session.userId] 
    });
    req.session.avatarUrl = newAvatar;
    res.redirect("/dashboard");
  } catch (error) {
    console.error(error);
    res.status(500).send("Errore nell'aggiornamento del profilo.");
  }
});


// ==========================================
// 4. GESTIONE QUIZ
// ==========================================

app.post("/generate-quiz", requireAuth, async (req, res) => {
  const { anime_title, episodes, session_id } = req.body;
  const quizData = await generateAnimeQuiz(anime_title, episodes);
  if (!quizData) return res.send("Errore di comunicazione con l'IA.");
  
  req.session.currentQuiz = { data: quizData, anime_title, session_id };
  res.redirect("/take-quiz");
});

app.get("/take-quiz", requireAuth, (req, res) => {
  if (!req.session.currentQuiz) return res.redirect("/dashboard");
  res.render("quiz", { quiz: req.session.currentQuiz });
});

app.post("/submit-quiz", requireAuth, async (req, res) => {
  const { score, session_id } = req.body;
  try {
    await turso.execute({
      sql: "INSERT INTO quizzes (user_id, session_id, score, completed_at) VALUES (?, ?, ?, datetime('now'))",
      args: [req.session.userId, session_id || null, score || 0]
    });
    req.session.currentQuiz = null;
    res.redirect("/dashboard");
  } catch (error) {
    console.error("Errore salvataggio punteggio:", error);
    res.redirect("/dashboard");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server online sulla porta ${PORT}`));
