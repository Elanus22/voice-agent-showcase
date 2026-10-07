// Wird von den Prüfskripten als ERSTES importiert.
//
// Lädt die .env (für die Skripte, die wirklich mit Google reden) und legt
// sonst einen Dummy-Key hin: Ohne ihn meckert der Google-Client schon beim
// Import los ("API key should be set"), und der Technik-Test sähe kaputt aus,
// obwohl er gar keine API braucht.
import "dotenv/config";

process.env.GEMINI_API_KEY ||= "dummy-nur-fuer-pruefungen-ohne-api";
