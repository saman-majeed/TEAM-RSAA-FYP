const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const fetch = require("node-fetch");
const cors = require("cors")({ origin: true });

const groqApiKey = process.env.GROQ_API_KEY;

exports.generateQuestion = onRequest(
    { secrets: [groqApiKey] },
    async (req, res) => {
        cors(req, res, async () => {
            if (req.method !== "POST") return res.status(405).end();

            // Verify Firebase Auth token
            const authHeader = req.headers.authorization;
            if (!authHeader?.startsWith("Bearer ")) {
                return res.status(401).json({ error: "Unauthorized" });
            }

            const { role, difficulty, skills, previousTopics } = req.body;

            const prompt = `Generate a single multiple-choice question for a ${role} candidate.
Difficulty: ${difficulty}
Skills: ${skills.join(", ")}
Avoid topics: ${previousTopics?.join(", ") || "none"}

Return ONLY JSON:
{
  "question": "...",
  "options": ["A", "B", "C", "D"],
  "correctIndex": 0,
  "topic": "...",
  "explanation": "..."
}`;

            try {
                const response = await fetch(
                    "https://api.groq.com/openai/v1/chat/completions",
                    {
                        method: "POST",
                        headers: {
                            Authorization: `Bearer ${groqApiKey.value()}`,
                            "Content-Type": "application/json",
                        },
                        body: JSON.stringify({
                            model: "llama3-70b-8192",
                            messages: [{ role: "user", content: prompt }],
                            temperature: 0.7,
                            max_tokens: 500,
                        }),
                    }
                );

                const data = await response.json();
                const text = data.choices?.[0]?.message?.content || "";
                const match = text.match(/\{[\s\S]*\}/);
                if (!match) throw new Error("Invalid JSON response");

                const question = JSON.parse(match[0]);
                res.json(question);
            } catch (err) {
                console.error("Groq error:", err);
                res.status(500).json({ error: "Failed to generate question" });
            }
        });
    }
);

// Set secret: firebase functions:secrets:set GROQ_API_KEY