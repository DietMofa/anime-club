// ai.js (Generazione Domande con Gemini)
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export async function generateAnimeQuiz(anime, episodes) {
  const prompt = `Sei un esperto di anime. Genera un quiz di 10 domande a risposta multipla sull'anime "${anime}", coprendo rigorosamente la trama SOLO fino all'episodio ${episodes}. 
  Rispondi ESCLUSIVAMENTE con un array JSON valido, senza blocchi di codice (senza \`\`\`json). Struttura di ogni oggetto:
  {
    "question": "testo domanda",
    "options": ["A", "B", "C", "D"],
    "correct_answer": "Testo esatto dell'opzione corretta"
  }`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
    });
    
    let jsonStr = response.text.replace(/```json/g, "").replace(/```/g, "").trim();
    return JSON.parse(jsonStr);
  } catch (error) {
    console.error("Errore generazione quiz:", error);
    return null;
  }
}