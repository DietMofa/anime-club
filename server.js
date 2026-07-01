// server.js (Logica aggiornata per image_0.png, Turso e Render)
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
app.use(express.static("public")); // <--- Aggiunta per il CSS

initDB();

const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.redirect("/login");
  next();
};

app.get("/", (req, res) => res.redirect("/dashboard"));

app.get("/login", (req, res) => res.render("login"));
app.get("/register", (req, res) => res.render("register"));
app.get("/logout", (req, res) => { req.session.destroy(); res.redirect("/login"); });

app.post("/register", async (req, res) => {
  const { username, password } = req.body;
  const hash = await bcrypt.hash(password, 10);
  
  const usersCount = await turso.execute("SELECT COUNT(*) as count FROM users");
  const isOwner = usersCount.rows[0].count === 0 ? 1 : 0;
  // Avatar predefinito per il primo utente (owner) diverso
  const avatarUrl = isOwner ? 'https://via.placeholder.com/60/e91e63/fff?text=Ryu' : `https://via.placeholder.com/60/03a9f4/fff?text=${username.charAt(0).toUpperCase()}`;

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

  // Simula feed attività
  const simulatedActivity = [
    { username: allUsers[0]?.username, type: 'online', time: '13 hours ago' },
    { username: allUsers[1]?.username, type: 'activity', detail: 'risposto a un quiz', time: '12 hours ago' },
    { username: allUsers[2]?.username, type: 'online', time: '12 hours ago' },
    { username: allUsers[0]?.username, type: 'activity', detail: 'risposto a un quiz', time: '11 hours ago' },
    { username: allUsers[0]?.username, type: 'owner', detail: 'impostato Neon Genesis Evangelion', time: '11 hours ago' },
  ];

  res.render("dashboard", {
    user: req.session,
    avatarUrl: currentUser?.avatar_url,
    activeSession,
    users: allUsers,
    otherUsers,
    quizResults,
    activityFeed: simulatedActivity
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

app.post("/pass-owner", requireAuth, async (req, res) => {
  if (!req.session.isOwner) return res.status(403).send("Non sei l'owner.");
  const { new_owner_id } = req.body;
  await turso.execute("UPDATE users SET is_owner = 0"); 
  await turso.execute({ sql: "UPDATE users SET is_owner = 1 WHERE id = ?", args: [new_owner_id] });
  req.session.isOwner = 0; 
  res.redirect("/dashboard");
});

app.post("/generate-quiz", requireAuth, async (req, res) => {
  const { episodes, session_id, anime_title } = req.body;
  
  const quizData = await generateAnimeQuiz(anime_title, episodes);
  if (!quizData) return res.send("Errore nella generazione del quiz. Riprova.");

  const currentUser = await turso.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [req.session.userId] });
  
  req.session.currentQuiz = { session_id, episodes, data: quizData, anime_title, user_avatar: currentUser.rows[0].avatar_url };
  res.redirect("/take-quiz");
});

app.get("/take-quiz", requireAuth, (req, res) => {
  if (!req.session.currentQuiz) return res.redirect("/dashboard");
  res.render("quiz", { quiz: req.session.currentQuiz });
});

app.post("/submit-quiz", requireAuth, async (req, res) => {
  const userAnswers = req.body.answers; 
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
  res.send(`<h1>Quiz completato! Hai totalizzato ${score}/10.</h1><br><a href="/dashboard">Torna alla Home</a>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server neon avviato sulla porta ${PORT}`));