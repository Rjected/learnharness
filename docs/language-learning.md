# Language learning (Chinese, Japanese) with your own Anki

This branch adds a language-learning layer to LearnHarness. Pick the language you're studying, and the tutor:

- **Knows your Anki.** It checks which words you already know (`anki_lookup`) and can pull any slice of your cards (`anki_cards`: due, next new, forgotten, known…) to practise them in sentences before you review and writes those bare, giving readings only for new words. At the end of a lesson it offers flashcards, each with an **Add to Anki** button.
- **Lets you review in the app.** The **Review** page in the sidebar shows your due cards, while Anki still does the scheduling. Space shows the answer, 1–4 grades it, R replays the audio. Reviews sync to AnkiWeb when you finish. The sliders icon gives each deck a role: **Daily** decks are your main review (and what the teacher practises by default), each **Separate** deck is its own session with a **Practise with teacher** button, **Paused** decks are suspended in Anki until you resume them (overdue reviews are then spread over a week), and **Off** decks aren't used.
- **Speaks every sentence.** Each run of Chinese or Japanese gets a speaker button. Tap again within 4 seconds for a slow teacher voice. If one of your Anki cards already has a recording of that exact text, it plays that recording.
- **Shows readings on demand.** Hover (laptop) or tap (phone) any Chinese or Japanese in the tutor's messages or a revealed answer to see the reading (pinyin or kana) and each word's meanings. Question blocks never get the popup, so it can't give away answers.
- **Takes mixed dictation.** The chip next to **Dictate** (中英 / 日英) records you and transcribes mixed English and the language you're studying.

Without a language picked (**Studying: None**), LearnHarness behaves exactly as upstream.

## Set up

1. **Run this branch:**
   ```bash
   git clone -b language-learning https://github.com/Rjected/learnharness
   cd learnharness
   npm install
   npm run build && npm start     # http://localhost:3000
   ```
   Choose your models as usual (see the main [README](../README.md)).
2. **Pick your language:** **Settings → Agent → Language learning → Studying**. The options are None, Chinese or Japanese, and Chinese is the default.
3. **Connect Anki:** in desktop Anki, go to **Tools → Add-ons → Get Add-ons…** and enter code `2055492159` to install [AnkiConnect](https://ankiweb.net/shared/info/2055492159). Restart Anki, then leave it running whenever you use LearnHarness. On the **Review** page, the sliders icon sets each deck's role. New cards go into `Chinese::LearnHarness` or `Japanese::LearnHarness` as Basic notes; the Review settings can change the deck.
4. **Turn on audio:** the speaker buttons stay dimmed until a Google key is saved. Tapping one opens **Settings → Keys → Audio**, which walks you through these steps:
   1. Open [aistudio.google.com/apikey](https://aistudio.google.com/apikey) and sign in with any Google account.
   2. Accept the terms. AI Studio creates a project and a key for you, so there's no billing or Cloud console step.
   3. Paste the key into the Google row.

   Google's free tier covers the speech model. Each clip is generated once and saved in `data/tts/`, so replays cost nothing. On a paid key, speech costs about $0.04 per 1,000 characters ($0.81 per hour of audio), rising to about $0.08 per 1,000 characters on Jan 1, 2027. The same key also unlocks Gemini models.

The reading popup's dictionary downloads automatically the first time you open a popup, and only for the language you're studying. It's saved to `data/dictionaries/`.

## Where things live

| Piece | Code |
|---|---|
| Language profiles (speech tag, TTS style, dictation, card fields) | `src/core/languages.ts` |
| The setting (`agent.language`) and `GET /api/language` | `src/core/settings.ts`, `src/server/language.ts` |
| Tutor rules per language | `src/agent/prompts/languages/<id>/{teacher,prober}.md` |
| Anki bridge (AnkiConnect), Review page, teacher tools | `src/server/anki.ts`, `src/server/anki-cards.ts`, `src/agent/tools/anki.ts`, `components/review/` |
| Speech (Gemini TTS) and mixed dictation | `src/server/tts.ts`, `src/server/stt.ts`, `components/language/player.ts` |
| Speaker buttons and reading popup | `components/language/` (`say.tsx`, `gloss.tsx`, `remark-say.ts`) |
| Dictionaries and readings | `src/server/gloss.ts`, `gloss-zh.ts`, `gloss-ja.ts` |

Adding a language means adding a profile, a prompt folder and, for the popup, a dictionary plus a `gloss-<id>.ts`.

## Credits

- Chinese readings: [CC-CEDICT](https://cc-cedict.org/) (MDBG export), CC BY-SA 4.0, plus [pinyin-pro](https://github.com/zh-lx/pinyin-pro) for readings in context.
- Japanese readings: this publication has included material from the [JMdict](https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project) (EDICT, etc.) dictionary files in accordance with the licence provisions of the Electronic Dictionaries Research Group. CC BY-SA 4.0.
