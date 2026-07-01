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

initDB();

const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.redirect("/login");
  next();
};

// API di ricerca MyAnimeList (tramite Jikan API v4)
app.get("/api/search-anime", requireAuth, async (req, res) => {
  const query = req.query.q;
  if (!query || query.length < 3) return res.json([]);
  
  try {
    const response = await fetch(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(query)}&limit=5`);
    const data = await response.json();
    
    const results = data.data.map(anime => ({
      title: anime.title,
      image_url: anime.images.jpg.image_url,
      episodes: anime.episodes || 24
    }));
    
    res.json(results);
  } catch (error) {
    console.error("Errore ricerca MAL:", error);
    res.status(500).json({ error: "Errore nel recupero dati da MyAnimeList" });
  }
});

app.get("/", (req, res) => res.redirect("/dashboard"));
app.get("/login", (req, res) => res.render("login"));
app.get("/register", (req, res) => res.render("register"));
app.get("/logout", (req, res) => { req.session.destroy(); res.redirect("/login"); });

// Profilo Utente
app.get("/profile", requireAuth, async (req, res) => {
  const userResult = await turso.execute({
    sql: "SELECT username, avatar_url FROM users WHERE id = ?",
    args: [req.session.userId]
  });
  res.render("profile", { user: userResult.rows[0] });
});

app.post("/profile/update", requireAuth, async (req, res) => {
  const { avatar_url } = req.body;
  await turso.execute({
    sql: "UPDATE users SET avatar_url = ? WHERE id = ?",
    args: [avatar_url, req.session.userId]
  });
  res.redirect("/dashboard");
});

app.post("/register", async (req, res) => {
  const { username, password } = req.body;
  const hash = await bcrypt.hash(password, 10);
  
  const usersCount = await turso.execute("SELECT COUNT(*) as count FROM users");
  const isOwner = usersCount.rows[0].count === 0 ? 1 : 0;
  const avatarUrl = 'https://images.unsplash.com/photo-1578632767115-351597cf2477?w=150'; // Avatar anime default

  try {
    await turso.execute({
      sql: "INSERT INTO users (username, password, is_owner, avatar_url) VALUES (?, ?, ?, ?)",
      args: [username, hash, isOwner, avatarUrl]
    });
    res.redirect("/login");
  } catch (e) {
    res.send("Username già in uso.");
  }
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const user = await turso.execute({
    sql: "SELECT * FROM users WHERE username = ?", args: [username]
  });

  if (user.rows.length > 0 && await bcrypt.compare(password, user.rows[0].password)) {
    req.session.userId = user.rows[0].id;
    req.session.isOwner = user.rows[0].is_owner;
    req.session.username = user.rows[0].username;
    res.redirect("/dashboard");
  } else {
    res.send("Credenziali errate.");
  }
});

app.get("/dashboard", requireAuth, async (req, res) => {
  const sessionData = await turso.execute("SELECT * FROM sessions WHERE active = 1 ORDER BY id DESC LIMIT 1");
  const activeSession = sessionData.rows[0];
  
  const allUsersResult = await turso.execute("SELECT id, username, avatar_url, is_owner FROM users");
  const allUsers = allUsersResult.rows;
  const currentUser = allUsers.find(u => u.id === req.session.userId);
  const otherUsers = allUsers.filter(u => u.id !== req.session.userId);

  let quizResults = [];
  if (activeSession) {
    const results = await turso.execute({
      sql: `SELECT u.username, u.avatar_url, q.score, q.rating FROM quizzes q JOIN users u ON q.user_id = u.id WHERE q.session_id = ? AND q.completed_at IS NOT NULL`,
      args: [activeSession.id]
    });
    quizResults = results.rows;
  }

  res.render("dashboard", {
    user: req.session,
    avatarUrl: currentUser?.avatar_url,
    activeSession,
    users: allUsers,
    otherUsers,
    quizResults,
    activityFeed: [] // Pulito per implementazioni future reali
  });
});

app.post("/set-anime", requireAuth, async (req, res) => {
  if (!req.session.isOwner) return res.status(403).send("Non sei l'owner.");
  const { anime_title, anime_image_url } = req.body;
  
  await turso.execute("UPDATE sessions SET active = 0"); 
  await turso.execute({
    sql: "INSERT INTO sessions (anime_title, anime_image_url, active) VALUES (?, ?, 1)",
    args: [anime_title, anime_image_url]
  });
  res.redirect("/dashboard");
});

// FIX: Generazione Quiz dinamica lato membro in base agli episodi visti
app.post("/generate-quiz", requireAuth, async (req, res) => {
  const { episodes, session_id, anime_title } = req.body;
  
  // Richiesta a Gemini limitata agli episodi passati dal form del membro
  const quizData = await generateAnimeQuiz(anime_title, episodes);
  if (!quizData) return res.send("Errore di comunicazione con l'IA. Riprova.");

  const currentUser = await turso.execute({ sql: "SELECT avatar_url FROM users WHERE id = ?", args: [req.session.userId] });
  
  req.session.currentQuiz = { 
    session_id, 
    episodes, 
    data: quizData, 
    anime_title, 
    user_avatar: currentUser.rows[0].avatar_url 
  };
  res.redirect("/take-quiz");
});

app.get("/take-quiz", requireAuth, (req, res) => {
  if (!req.session.currentQuiz) return res.redirect("/dashboard");
  res.render("quiz", { quiz: req.session.currentQuiz });
});

app.post("/submit-quiz", requireAuth, async (req, res) => {
  const userAnswers = req.body.answers || {}; 
  const rating = req.body.rating || 0;
  const quiz = req.session.currentQuiz;
  
  if (!quiz) return res.redirect("/dashboard");

  let score = 0;
  quiz.data.forEach((q, index) => {
    if (userAnswers[index] === q.correct_answer) score++;
  });

  await turso.execute({
    sql: "INSERT INTO quizzes (user_id, session_id, episodes_watched, score, rating, qa_data, completed_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
    args: [req.session.userId, quiz.session_id, quiz.episodes, score, rating, JSON.stringify(quiz.data)]
  });

  delete req.session.currentQuiz;
  res.send(`
    <style>body{background:#121212;color:#fff;font-family:sans-serif;text-align:center;padding-top:100px;}a{color:#00bcd4;}</style>
    <h1>Quiz completato con successo! 🎉</h1>
    <h2>Il tuo punteggio: ${score}/10</h2>
    <p>Hai valutato questo anime con ${rating}/5 stelle.</p>
    <br><a href="/dashboard">Torna alla Dashboard della Night</a>
  `);
});

app.post("/pass-owner", requireAuth, async (req, res) => {
  if (!req.session.isOwner) return res.status(403).send("Non sei l'owner.");
  const { new_owner_id } = req.body;
  await turso.execute("UPDATE users SET is_owner = 0"); 
  await turso.execute({ sql: "UPDATE users SET is_owner = 1 WHERE id = ?", args: [new_owner_id] });
  req.session.isOwner = 0; 
  res.redirect("/dashboard");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server neon avviato sulla porta ${PORT}`));