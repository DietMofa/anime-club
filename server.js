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

// Inizializza le tabelle del DB
initDB();

// Middleware per proteggere le rotte obbligando il login
const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.redirect("/login");
  next();
};

// ==========================================
// 1. ROTTE DI AUTENTICAZIONE E BASE (RIPRISTINATE!)
// ==========================================

// Quando vai su internet sul tuo link principale, ti manda alla dashboard
app.get("/", (req, res) => {
  res.redirect("/dashboard");
});

// Mostra la pagina di Login (views/login.ejs)
app.get("/login", (req, res) => {
  res.render("login"); 
});

// Gestisce l'invio del modulo di login
app.post("/login", async (req, res) => {
  const user = (await turso.execute({ sql: "SELECT * FROM users WHERE username = ?", args: [req.body.username] })).rows[0];
  if (user && await bcrypt.compare(req.body.password, user.password)) {
    req.session.userId = user.id;
    req.session.isOwner = user.is_owner;
    req.session.username = user.username;
    req.session.avatarUrl = user.avatar_url; // Salva avatar in sessione
    res.redirect("/dashboard");
  } else {
    res.send("Credenziali errate. <a href='/login'>Riprova qui</a>");
  }
});

// Gestisce il logout
app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});


// ==========================================
// 2. ROTTA PRINCIPALE DASHBOARD
// ==========================================
app.get("/dashboard", requireAuth, async (req, res) => {
  const sessionData = await turso.execute("SELECT * FROM sessions WHERE active = 1 ORDER BY id DESC LIMIT 1");
  const activeSession = sessionData.rows[0];
  
  const allUsersResult = await turso.execute("SELECT id, username, avatar_url, is_owner FROM users");
  const allUsers = allUsersResult.rows;
  const currentUser = allUsers.find(u => u.id === req.session.userId);
  const otherUsers = allUsers.filter(u => u.id !== req.session.userId);

  // Aggiorna l'avatar in sessione per sicurezza
  if (currentUser) {
    req.session.avatarUrl = currentUser.avatar_url;
  }

  // CLASSIFICA TOTALE (Somma di tutti i punteggi per ogni utente)
  const totalLeaderboardResult = await turso.execute(`
    SELECT u.username, u.avatar_url, SUM(q.score) as total_score
    FROM quizzes q
    JOIN users u ON q.user_id = u.id
    WHERE q.completed_at IS NOT NULL
    GROUP BY u.id
    ORDER BY total_score DESC
  `);
  const totalLeaderboard = totalLeaderboardResult.rows;

  // CLASSIFICA PER ANIME
  const animeLeaderboardResult = await turso.execute(`
    SELECT s.anime_title, u.username, u.avatar_url, SUM(q.score) as score
    FROM quizzes q
    JOIN users u ON q.user_id = u.id
    JOIN sessions s ON q.session_id = s.id
    WHERE q.completed_at IS NOT NULL
    GROUP BY s.anime_title, u.id
    ORDER BY s.anime_title ASC, score DESC
  `);
  
  const leaderboardsByAnime = {};
  animeLeaderboardResult.rows.forEach(row => {
    if (!leaderboardsByAnime[row.anime_title]) leaderboardsByAnime[row.anime_title] = [];
    leaderboardsByAnime[row.anime_title].push(row);
  });

  res.render("dashboard", {
    user: req.session,
    avatarUrl: req.session.avatarUrl || 'https://images.unsplash.com/photo-1578632767115-351597cf2477?w=150',
    activeSession,
    users: allUsers,
    otherUsers,
    totalLeaderboard,
    leaderboardsByAnime
  });
});


// ==========================================
// 3. API RICERCA ANIME (MyAnimeList)
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


// ==========================================
// 4. GESTIONE INIZIO SESSIONE (RIPRISTINATA!)
// ==========================================
app.post("/session/start", requireAuth, async (req, res) => {
  if (!req.session.isOwner) return res.status(403).send("Non sei l'owner.");
  const { anime_title, anime_image_url } = req.body;
  
  // Disattiva la vecchia sessione ancora attiva
  await turso.execute("UPDATE sessions SET active = 0 WHERE active = 1");
  
  // Crea la nuova sessione settandola attiva
  await turso.execute({
    sql: "INSERT INTO sessions (anime_title, anime_image_url, active) VALUES (?, ?, 1)",
    args: [anime_title, anime_image_url]
  });
  
  res.redirect("/dashboard");
});


// ==========================================
// 5. GESTIONE PROFILO E QUIZ
// ==========================================
app.post("/profile/update", requireAuth, async (req, res) => {
  const newAvatar = req.body.avatar_url;
  await turso.execute({ 
    sql: "UPDATE users SET avatar_url = ? WHERE id = ?", 
    args: [newAvatar, req.session.userId] 
  });
  req.session.avatarUrl = newAvatar; // Aggiorna subito la sessione
  res.redirect("/dashboard");
});

app.post("/generate-quiz", requireAuth, async (req, res) => {
  const quizData = await generateAnimeQuiz(req.body.anime_title, req.body.episodes);
  if (!quizData) return res.send("Errore IA. Controlla la GEMINI_API_KEY nei log di Render.");
  req.session.currentQuiz = { data: quizData, anime_title: req.body.anime_title, session_id: req.body.session_id };
  res.redirect("/take-quiz");
});

app.get("/take-quiz", requireAuth, (req, res) => res.render("quiz", { quiz: req.session.currentQuiz }));

// Avvio Server
app.listen(process.env.PORT || 3000, () => console.log("Server reattivo e online!"));
