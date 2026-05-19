import { useState, useEffect, useRef, useCallback, createContext, useContext, useMemo } from "react";
import {
  buildAssessmentInviteMailto,
  isEmailJsConfigured,
  isProbablyValidEmail,
  sendAssessmentInviteEmail,
  EMAILJS_DOCS_URL,
  getInviteBlockedReason,
  resolveCandidateInviteLink,
} from "./email/inviteEmail";
import { auth, db, storage } from "./firebase/config";
import { signInAnonymously, signOut as firebaseSignOut } from "firebase/auth";
import {
  collection,
  doc,
  setDoc,
  deleteDoc,
  getDoc,
  query,
  where,
  getDocs,
  onSnapshot,
  serverTimestamp,
} from "firebase/firestore";
import { ref as storageRef, uploadBytes, getDownloadURL } from "firebase/storage";

/** Shown when Storage uploads need Firebase Anonymous auth (see Firebase Console). */
const ANONYMOUS_AUTH_HELP =
  "Anonymous sign-in is turned off for your Firebase project.\n\n" +
  "Enable it:\n" +
  "1) Open console.firebase.google.com → select this project\n" +
  "2) Build → Authentication → Sign-in method\n" +
  "3) Click “Anonymous” → Enable → Save\n" +
  "4) In this app: log out, then sign in again as the candidate";

/** Base URL for candidate test links (emails / copy). If unset, uses current browser origin. */
function getPublicAppOrigin() {
  const raw = import.meta.env.VITE_PUBLIC_APP_URL;
  if (raw == null || String(raw).trim() === "") return window.location.origin;
  return String(raw).trim().replace(/\/+$/, "");
}

/** "inline" (default) = JPEG data URLs on the Firestore results doc (no Storage). "storage" = Firebase Storage uploads. */
const PROCTORING_USE_FIREBASE_STORAGE =
  String(import.meta.env.VITE_PROCTORING_STORAGE || "inline").toLowerCase() === "storage";

/** Cap how many shots we keep when using inline mode (Firestore ~1MB doc limit). */
const MAX_INLINE_PROCTORING_SHOTS = 10;

/** Firestore document max ~1 MiB — trim proctoring frames if JSON is still too large. */
const FIRESTORE_DOC_SAFE_CHARS = 950_000;

function trimResultForFirestoreSize(result) {
  const base = {
    ...result,
    proctoringScreenshots: Array.isArray(result.proctoringScreenshots)
      ? [...result.proctoringScreenshots]
      : [],
  };
  while (
    base.proctoringScreenshots.length > 0 &&
    JSON.stringify(base).length > FIRESTORE_DOC_SAFE_CHARS
  ) {
    base.proctoringScreenshots.pop();
  }
  return base;
}

function drawSourceToJpegDataUrl(source, maxW, quality) {
  if (!source) return null;
  const sw = source.videoWidth ?? source.width ?? 0;
  const sh = source.videoHeight ?? source.height ?? 0;
  if (!sw || !sh) return null;
  const scale = Math.min(1, maxW / sw);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  try {
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  } catch {
    return null;
  }
  return canvas.toDataURL("image/jpeg", quality);
}

async function copyTextToClipboard(text) {
  const s = text == null ? "" : String(text);
  if (!s) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = s;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// ─── DB HELPERS ───────────────────────────────────────────────────────────────
async function dbSet(col, id, data) {
  await setDoc(doc(db, col, id), { ...data, updatedAt: serverTimestamp() });
  return { id, ...data };
}

async function dbGet(col, id) {
  const snap = await getDoc(doc(db, col, id));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

async function dbQuery(col, field, value) {
  const q = query(collection(db, col), where(field, "==", value));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** Webcam constraints for getUserMedia (needs https or localhost). */
const CAMERA_MEDIA_CONSTRAINTS = {
  video: {
    facingMode: { ideal: "user" },
    width: { ideal: 1280 },
    height: { ideal: 720 },
  },
  audio: false,
};

async function getCameraStream() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("CAMERA_API_UNAVAILABLE");
  }
  try {
    return await navigator.mediaDevices.getUserMedia(CAMERA_MEDIA_CONSTRAINTS);
  } catch (err) {
    console.warn("Camera: falling back to default constraints:", err?.name, err?.message);
    return await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  }
}

/** Bind MediaStream to a <video> and wait until frames can render (reduces black preview). */
async function attachCameraStreamToVideo(videoEl, stream) {
  if (!videoEl || !stream) return;
  videoEl.srcObject = stream;
  videoEl.setAttribute("playsinline", "");
  videoEl.muted = true;
  await new Promise((resolve) => {
    const finish = () => {
      videoEl.removeEventListener("loadedmetadata", finish);
      videoEl.removeEventListener("loadeddata", finish);
      videoEl.removeEventListener("canplay", finish);
      resolve();
    };
    videoEl.addEventListener("loadedmetadata", finish);
    videoEl.addEventListener("loadeddata", finish);
    videoEl.addEventListener("canplay", finish);
    setTimeout(finish, 4000);
  });
  await videoEl.play().catch(() => { });
}

/** Remove visible difficulty cues like "(easy)" from question text shown to candidates. */
function stripDifficultyFromQuestionText(text) {
  if (typeof text !== "string") return text;
  let t = text.trim();
  while (/^\((EASY|MEDIUM|HARD)\)\s*/i.test(t)) {
    t = t.replace(/^\((EASY|MEDIUM|HARD)\)\s*/i, "").trim();
  }
  return t;
}

const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile";
const GROQ_MAX_ATTEMPTS = 5;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Extract first balanced JSON object from model output (handles ```json fences). */
function extractJsonObjectFromText(text) {
  if (!text || typeof text !== "string") return null;
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*\n?([\s\S]*?)```/im);
  if (fence) t = fence[1].trim();

  const start = t.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < t.length; i += 1) {
    const ch = t[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(t.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function normalizeGroqQuestion(parsed, topicLabel) {
  if (!parsed || typeof parsed !== "object") return null;
  const question = stripDifficultyFromQuestionText(String(parsed.question ?? "").trim());
  if (!question) return null;

  let options = parsed.options;
  if (!Array.isArray(options)) return null;
  options = options.map((o) => String(o ?? "").trim()).filter(Boolean);
  if (options.length !== 4) return null;

  let correctIndex = Number(parsed.correctIndex);
  if (!Number.isInteger(correctIndex)) correctIndex = parseInt(String(parsed.correctIndex), 10);
  if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex > 3) return null;

  return { question, options, correctIndex, topic: topicLabel };
}

// ─── GROQ AI QUESTION GENERATOR ───────────────────────────────────────────────
export async function generateQuestion(role, difficulty, skills, previousQuestions = []) {
  const topic = skills?.[0] || role || "General Aptitude";
  const skillLine = Array.isArray(skills) && skills.length
    ? skills.join(", ")
    : role || topic;
  const asked = new Set(
    (previousQuestions || [])
      .map((q) => stripDifficultyFromQuestionText(q?.question || "").trim().toLowerCase())
      .filter(Boolean)
  );

  const avoidSnippets = (previousQuestions || [])
    .map((q) => stripDifficultyFromQuestionText(q?.question || "").trim())
    .filter(Boolean)
    .slice(-10)
    .filter((q) => q.length > 0);

  const avoidBlock =
    avoidSnippets.length === 0
      ? "(none yet)"
      : avoidSnippets.map((q, i) => `${i + 1}. ${q.slice(0, 200)}${q.length > 200 ? "…" : ""}`).join("\n");

  const systemPrompt =
    "You output exactly one JSON object and nothing else. No markdown, no code fences, no explanation.";

  const userPrompt = `Create one multiple-choice question for a technical hiring assessment.

JSON shape (required keys only):
{"question":"string","options":["four distinct strings"],"correctIndex":0}

Constraints:
- Target role: ${role}
- Skills / topics to draw from: ${skillLine}
- Internal difficulty level: ${difficulty} (match depth to this level; never write the words easy, medium, hard, or (easy) in the question)
- Exactly 4 options; exactly one is correct; plausible wrong answers
- Do not repeat or paraphrase these prior questions:
${avoidBlock}

Respond with valid JSON only.`;

  const apiKey = (import.meta.env.VITE_GROQ_API_KEY || "").trim();
  const model = (import.meta.env.VITE_GROQ_MODEL || DEFAULT_GROQ_MODEL).trim();

  const fallbackBank = {
    easy: [
      {
        question: `What is the primary goal of ${topic} in software projects?`,
        options: [
          "Improve reliability and maintainability of solutions.",
          "Avoid planning and only focus on coding speed.",
          "Remove the need for testing completely.",
          "Guarantee no bugs can ever happen.",
        ],
        correctIndex: 0,
      },
      {
        question: `Which practice is most important when starting with ${topic}?`,
        options: [
          "Understand fundamentals before using advanced tools.",
          "Skip basics and copy production code immediately.",
          "Ignore documentation to save time.",
          "Avoid code reviews during implementation.",
        ],
        correctIndex: 0,
      },
      {
        question: `In ${topic}, what usually leads to better long-term code quality?`,
        options: [
          "Clear structure, readability, and iterative improvement.",
          "Large files with repeated logic everywhere.",
          "No naming conventions across the project.",
          "Frequent hotfixes without root-cause analysis.",
        ],
        correctIndex: 0,
      },
    ],
    medium: [
      {
        question: `Which approach best scales ${topic} across a growing codebase?`,
        options: [
          "Modular design with reusable components and tests.",
          "Centralize all logic in one massive file.",
          "Duplicate code for each new feature.",
          "Avoid refactoring to prevent any change risk.",
        ],
        correctIndex: 0,
      },
      {
        question: `What is the strongest indicator that ${topic} implementation needs refactoring?`,
        options: [
          "Frequent regressions and difficult onboarding for teammates.",
          "Stable behavior with good test coverage.",
          "Consistent coding conventions in pull requests.",
          "Predictable release cycle outcomes.",
        ],
        correctIndex: 0,
      },
      {
        question: `For ${topic}, which trade-off is usually best in production systems?`,
        options: [
          "Balance performance, readability, and maintainability.",
          "Optimize only micro-benchmarks and ignore clarity.",
          "Use clever code over understandable code.",
          "Ship without monitoring and iterate later.",
        ],
        correctIndex: 0,
      },
    ],
    hard: [
      {
        question: `During high-scale usage, what is the best strategy for hardening ${topic}?`,
        options: [
          "Measure bottlenecks, validate assumptions, and optimize targeted paths.",
          "Apply broad optimizations without profiling data.",
          "Disable observability to reduce overhead.",
          "Increase complexity before validating correctness.",
        ],
        correctIndex: 0,
      },
      {
        question: `Which decision most improves resilience in ${topic} architecture?`,
        options: [
          "Design for graceful failure and clear rollback paths.",
          "Treat all failures as edge cases and ignore retries.",
          "Depend on manual fixes during incidents.",
          "Bundle unrelated responsibilities into single services.",
        ],
        correctIndex: 0,
      },
      {
        question: `What is the most mature way to validate complex ${topic} changes?`,
        options: [
          "Use staged rollout, monitoring, and fast rollback controls.",
          "Deploy globally without canary checks.",
          "Skip tests if local checks pass once.",
          "Rely only on customer reports for validation.",
        ],
        correctIndex: 0,
      },
    ],
  };

  const level = fallbackBank[difficulty] ? difficulty : "easy";
  const candidates = fallbackBank[level].filter(
    (q) => !asked.has((q.question || "").trim().toLowerCase())
  );
  const pool = candidates.length ? candidates : fallbackBank[level];
  const fallbackQuestion = { topic, ...pool[Math.floor(Math.random() * pool.length)] };

  const randomizeCorrectOption = (q) => {
    if (!q || !Array.isArray(q.options) || !Number.isInteger(q.correctIndex)) return q;
    const indexed = q.options.map((opt, idx) => ({ opt, idx }));
    for (let i = indexed.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [indexed[i], indexed[j]] = [indexed[j], indexed[i]];
    }
    return {
      ...q,
      options: indexed.map((x) => x.opt),
      correctIndex: indexed.findIndex((x) => x.idx === q.correctIndex),
    };
  };

  if (!apiKey) {
    console.warn("VITE_GROQ_API_KEY is missing — using offline question bank");
    return randomizeCorrectOption(fallbackQuestion);
  }

  const fetchGroqQuestion = async (useJsonObjectMode) => {
    if (!apiKey) throw new Error("VITE_GROQ_API_KEY is missing");

    const body = {
      model,
      temperature: 0.65,
      max_tokens: 800,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    };
    if (useJsonObjectMode) {
      body.response_format = { type: "json_object" };
    }

    const response = await fetch(GROQ_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg = data?.error?.message || response.statusText || "Request failed";
      const err = new Error(`Groq ${response.status}: ${msg}`);
      err.status = response.status;
      throw err;
    }

    const text = data.choices?.[0]?.message?.content || "";
    const parsed = extractJsonObjectFromText(text);
    const normalized = normalizeGroqQuestion(parsed, topic);
    if (!normalized) throw new Error("Groq returned JSON that could not be normalized");
    if (asked.has(normalized.question.trim().toLowerCase())) {
      throw new Error("Duplicate question from model");
    }
    return normalized;
  };

  let lastErr = null;
  let authFatal = false;

  for (let attempt = 0; attempt < GROQ_MAX_ATTEMPTS && !authFatal; attempt += 1) {
    const backoff = 400 * 2 ** attempt + Math.floor(Math.random() * 250);
    const tryJsonObjectFirst = attempt === 0;
    const modes = tryJsonObjectFirst ? [true, false] : [false];

    for (const useJsonObject of modes) {
      try {
        const q = await fetchGroqQuestion(useJsonObject);
        return randomizeCorrectOption(q);
      } catch (err) {
        lastErr = err;
        const st = err?.status;
        if (st === 401 || st === 403) {
          console.error("Groq authentication failed:", err.message);
          authFatal = true;
          break;
        }
        if (st === 404) {
          console.error("Groq model not found — check VITE_GROQ_MODEL:", err.message);
          authFatal = true;
          break;
        }
        if (useJsonObject && st === 400) {
          continue;
        }
        break;
      }
    }

    const st = lastErr?.status;
    const retryable =
      st === 429 ||
      st === 408 ||
      st === 503 ||
      st === 502 ||
      st === 500 ||
      st === undefined;
    if (authFatal) break;
    if (retryable && attempt < GROQ_MAX_ATTEMPTS - 1) {
      await sleep(backoff);
    }
  }

  console.error("Groq question generation failed after retries:", lastErr);
  return randomizeCorrectOption(fallbackQuestion);
}

// ─── UTILITIES ────────────────────────────────────────────────────────────────
const uid = () => Math.random().toString(36).slice(2, 10).toUpperCase();
const nowISO = () => new Date().toISOString();

// ─── THEME (light / dark / system) ────────────────────────────────────────────
const THEME_PREF_KEY = "team-rsaa-appearance";

const ThemeCtx = createContext(null);

function ThemeProvider({ children }) {
  const [pref, setPrefState] = useState(() => {
    try {
      const s = localStorage.getItem(THEME_PREF_KEY);
      if (s === "light" || s === "dark" || s === "system") return s;
    } catch {
      /* ignore */
    }
    return "system";
  });
  const [systemDark, setSystemDark] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches,
  );

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = () => setSystemDark(mq.matches);
    mq.addEventListener("change", listener);
    return () => mq.removeEventListener("change", listener);
  }, []);

  const effective = pref === "system" ? (systemDark ? "dark" : "light") : pref;
  const isDark = effective === "dark";

  const setPref = (next) => {
    setPrefState(next);
    try {
      localStorage.setItem(THEME_PREF_KEY, next);
    } catch {
      /* ignore */
    }
  };

  const themeValue = useMemo(() => {
    const C = buildColors(isDark);
    const S = buildStyles(C, isDark);
    return { C, S, pref, setPref, effective, isDark };
  }, [isDark, pref]);

  useEffect(() => {
    const { effective: eff, isDark: dark, C } = themeValue;
    document.documentElement.dataset.theme = eff;
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
    document.body.style.backgroundColor = C.bg;
    document.body.style.color = C.text;
  }, [themeValue]);

  return <ThemeCtx.Provider value={themeValue}>{children}</ThemeCtx.Provider>;
}

function useTheme() {
  const v = useContext(ThemeCtx);
  if (!v) throw new Error("useTheme must be used inside ThemeProvider");
  return v;
}

function useResponsive(bp = 880) {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${bp}px)`);
    const fn = () => setCompact(mq.matches);
    fn();
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, [bp]);
  return compact;
}

function buildColors(isDark) {
  if (!isDark) {
    return {
      bg: "#f8f7ff",
      bgMuted: "#eef2ff",
      surface: "#ffffff",
      surfaceHover: "#fafbff",
      border: "#c7d2fe",
      accent: "#6366f1",
      accent2: "#a855f7",
      accent3: "#ec4899",
      cyan: "#06b6d4",
      coral: "#f97316",
      accentDim: "rgba(99, 102, 241, 0.16)",
      text: "#0f172a",
      muted: "#575d73",
      success: "#10b981",
      warning: "#f59e0b",
      danger: "#ef4444",
      purple: "#c026d3",
      modalBackdrop: "rgba(15, 23, 42, 0.48)",
      shellTint: "",
      sidebarGradient:
        "linear-gradient(175deg, #fdf4ff 0%, #eef2ff 38%, #ecfeff 72%, #fffbeb 100%)",
      inputInset: "inset 0 1px 2px rgba(99, 102, 241, 0.06)",
      cardGlow:
        "0 4px 28px rgba(99, 102, 241, 0.09), 0 2px 10px rgba(236, 72, 153, 0.05), inset 0 1px 0 rgba(255, 255, 255, 0.95)",
      loginToggleShadow: "0 2px 12px rgba(15, 23, 42, 0.08)",
    };
  }
  return {
    bg: "#0b0c12",
    bgMuted: "#13151f",
    surface: "#151822",
    surfaceHover: "#1a1e2e",
    border: "#2d3352",
    accent: "#818cf8",
    accent2: "#c084fc",
    accent3: "#f472b6",
    cyan: "#22d3ee",
    coral: "#fb923c",
    accentDim: "rgba(129, 140, 248, 0.22)",
    text: "#f1f5f9",
    muted: "#94a3b8",
    success: "#34d399",
    warning: "#fbbf24",
    danger: "#f87171",
    purple: "#e879f9",
    modalBackdrop: "rgba(2, 6, 23, 0.78)",
    shellTint: "rgba(15, 23, 42, 0.5)",
    sidebarGradient:
      "linear-gradient(175deg, #18101f 0%, #121726 38%, #0f1424 72%, #1a1610 100%)",
    inputInset: "inset 0 1px 2px rgba(0, 0, 0, 0.35)",
    cardGlow:
      "0 4px 32px rgba(0, 0, 0, 0.45), 0 1px 0 rgba(255, 255, 255, 0.06) inset",
    loginToggleShadow: "0 2px 16px rgba(0, 0, 0, 0.35)",
  };
}

function buildStyles(C, isDark) {
  const badgeFg = {
    success: isDark ? "#6ee7b7" : "#047857",
    warning: isDark ? "#fcd34d" : "#b45309",
    danger: isDark ? "#fca5a5" : "#b91c1c",
    default: isDark ? "#a5b4fc" : "#4338ca",
  };
  const appLayers = isDark
    ? `
      radial-gradient(ellipse 100% 85% at 0% -15%, rgba(99, 102, 241, 0.2), transparent 52%),
      radial-gradient(ellipse 90% 75% at 105% 5%, rgba(236, 72, 153, 0.14), transparent 48%),
      radial-gradient(ellipse 75% 65% at 100% 105%, rgba(6, 182, 212, 0.12), transparent 46%),
      radial-gradient(ellipse 95% 80% at -5% 90%, rgba(249, 115, 22, 0.1), transparent 48%),
      radial-gradient(ellipse 70% 55% at 48% 45%, rgba(192, 38, 211, 0.05), transparent 52%)`
    : `
      radial-gradient(ellipse 100% 85% at 0% -15%, rgba(129, 140, 248, 0.35), transparent 52%),
      radial-gradient(ellipse 90% 75% at 105% 5%, rgba(236, 72, 153, 0.22), transparent 48%),
      radial-gradient(ellipse 75% 65% at 100% 105%, rgba(6, 182, 212, 0.2), transparent 46%),
      radial-gradient(ellipse 95% 80% at -5% 90%, rgba(249, 115, 22, 0.14), transparent 48%),
      radial-gradient(ellipse 70% 55% at 48% 45%, rgba(192, 38, 211, 0.06), transparent 52%)`;

  return {
    app: {
      minHeight: "100vh",
      backgroundColor: C.bg,
      backgroundImage: appLayers,
      color: C.text,
      fontFamily: "'DM Sans', system-ui, sans-serif",
    },
    card: {
      background: C.surface,
      border: `1px solid ${C.border}`,
      borderRadius: 14,
      padding: "1.5rem",
      boxShadow: C.cardGlow,
    },
    btn: (variant = "primary", size = "md") => ({
      padding: size === "sm" ? "8px 16px" : "11px 22px",
      borderRadius: 10,
      border: variant === "ghost" ? `1px solid ${C.border}` : "none",
      cursor: "pointer",
      fontWeight: 600,
      fontSize: size === "sm" ? 13 : 14,
      background:
        variant === "primary"
          ? `linear-gradient(135deg, ${C.accent} 0%, ${C.accent2} 52%, ${C.accent3} 100%)`
          : variant === "success"
            ? `linear-gradient(135deg, #059669 0%, ${C.success} 55%, #34d399 100%)`
            : variant === "danger"
              ? `linear-gradient(135deg, #dc2626 0%, ${C.danger} 50%, #fb7185 100%)`
              : "transparent",
      color: variant === "ghost" ? C.muted : "#ffffff",
      boxShadow:
        variant === "primary"
          ? "0 6px 22px rgba(99, 102, 241, 0.38), 0 3px 12px rgba(236, 72, 153, 0.18)"
          : variant === "success"
            ? "0 6px 20px rgba(16, 185, 129, 0.35)"
            : variant === "danger"
              ? "0 6px 20px rgba(239, 68, 68, 0.35)"
              : "none",
    }),
    input: {
      background: C.surface,
      border: `1px solid ${C.border}`,
      borderRadius: 10,
      padding: "11px 14px",
      color: C.text,
      width: "100%",
      outline: "none",
      boxSizing: "border-box",
      transition: "border-color 0.15s ease, box-shadow 0.15s ease",
      boxShadow: C.inputInset,
    },
    badge: (color) => ({
      padding: "4px 11px",
      borderRadius: 999,
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: "0.03em",
      textTransform: "uppercase",
      background:
        color === "success"
          ? "linear-gradient(135deg, rgba(16, 185, 129, 0.18), rgba(52, 211, 153, 0.12))"
          : color === "warning"
            ? "linear-gradient(135deg, rgba(245, 158, 11, 0.22), rgba(251, 191, 36, 0.12))"
            : color === "danger"
              ? "linear-gradient(135deg, rgba(239, 68, 68, 0.2), rgba(251, 113, 133, 0.12))"
              : "linear-gradient(135deg, rgba(99, 102, 241, 0.18), rgba(168, 85, 247, 0.12))",
      color: color === "success" ? badgeFg.success : color === "warning" ? badgeFg.warning : color === "danger" ? badgeFg.danger : badgeFg.default,
      border: `1px solid ${color === "success"
        ? "rgba(16, 185, 129, 0.35)"
        : color === "warning"
          ? "rgba(245, 158, 11, 0.38)"
          : color === "danger"
            ? "rgba(239, 68, 68, 0.38)"
            : "rgba(99, 102, 241, 0.35)"
        }`,
    }),
  };
}

// ─── SHARED UI PRIMITIVES ─────────────────────────────────────────────────────
function Tag({ color = "warning", children }) {
  const { S } = useTheme();
  return <span style={S.badge(color)}>{children}</span>;
}

function CopyIconButton({ text, title = "Copy to clipboard" }) {
  const [state, setState] = useState("idle");
  const { C } = useTheme();

  const handle = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const ok = await copyTextToClipboard(text);
    setState(ok ? "ok" : "err");
    setTimeout(() => setState("idle"), ok ? 1200 : 2000);
  };

  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={handle}
      style={{
        flexShrink: 0,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 36,
        height: 36,
        padding: 0,
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        background: C.surface,
        color: state === "ok" ? C.success : state === "err" ? C.danger : C.muted,
        cursor: "pointer",
      }}
    >
      {state === "ok" ? (
        <span style={{ fontSize: 16, fontWeight: 700 }}>✓</span>
      ) : state === "err" ? (
        <span style={{ fontSize: 14, fontWeight: 700 }}>!</span>
      ) : (
        <svg
          width={18}
          height={18}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}

function Stat({ label, value, color }) {
  const { C, S } = useTheme();
  const fg = color ?? C.accent;
  const tintBg =
    typeof fg === "string" && /^#[0-9a-fA-F]{6}$/.test(fg) ? `${fg}18` : `${C.accent}18`;
  return (
    <div
      style={{
        ...S.card,
        minWidth: 170,
        flex: "1 1 160px",
        overflow: "hidden",
        position: "relative",
        background: `linear-gradient(155deg, ${tintBg} 0%, ${C.surface} 42%, ${C.surface} 100%)`,
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 4,
          background: `linear-gradient(90deg, ${fg}, ${C.accent2}, ${C.cyan})`,
          opacity: 0.95,
        }}
      />
      <div style={{ fontSize: 13, color: C.muted, marginBottom: 6, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 30, fontWeight: 700, color: fg, fontFamily: "'Outfit', sans-serif", letterSpacing: "-0.03em" }}>
        {value}
      </div>
    </div>
  );
}

function Modal({ open, onClose, title, children }) {
  const { C, S } = useTheme();
  if (!open) return null;
  return (
    <div
      className="ha-modal-backdrop"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: C.modalBackdrop,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
        zIndex: 100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ ...S.card, width: "100%", maxWidth: "min(620px, calc(100vw - 2rem))", maxHeight: "85vh", overflowY: "auto" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <h3 style={{ margin: 0, fontSize: 19 }}>{title}</h3>
          <button onClick={onClose} style={{ ...S.btn("ghost", "sm"), padding: "6px 12px", color: C.muted }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Spinner() {
  const { C } = useTheme();
  return (
    <div
      style={{
        width: 30,
        height: 30,
        borderRadius: "50%",
        border: `3px solid ${C.border}`,
        borderTopColor: C.accent,
        animation: "spin 1s linear infinite",
      }}
    >
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ─── AUTH HOOK ────────────────────────────────────────────────────────────────
function useAuth() {
  const [user, setUser] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem("rp_user")); }
    catch { return null; }
  });

  const signIn = async (id, pass, role = "admin") => {
    console.log(`Attempting login for: ${id} as ${role}`);
    await firebaseSignOut(auth).catch(() => { });

    if (role === "admin") {
      const loginId = id.trim();
      // Try both patterns:
      // 1) admins/{loginId} doc id matches typed username/email
      // 2) any admins doc where email == typed username/email
      const [byDocId, byEmail] = await Promise.all([
        dbGet("admins", loginId),
        dbQuery("admins", "email", loginId),
      ]);
      const adminDoc = byDocId || byEmail?.[0] || null;
      console.log("Resolved admin document:", adminDoc);

      if (!adminDoc) {
        return { ok: false, error: "Admin not found. Create an `admins` document with email/password." };
      }

      const correctPass = adminDoc.admin || adminDoc.password || adminDoc.pass;
      if (correctPass !== pass) {
        return { ok: false, error: "Invalid admin credentials. Password does not match." };
      }

      const uid = adminDoc.id || loginId;
      const u = { uid, name: adminDoc.email || adminDoc.name || "Admin", role: "admin" };
      sessionStorage.setItem("rp_user", JSON.stringify(u));
      setUser(u);
      return { ok: true };
    } else {
      // Logic for Candidate login
      const cands = await dbQuery("candidates", "candidateId", id.trim());
      const cand = cands.find((c) => c.password === pass);
      if (cand) {
        if (PROCTORING_USE_FIREBASE_STORAGE) {
          try {
            await signInAnonymously(auth);
          } catch (e) {
            console.error(
              "Enable Anonymous sign-in: Firebase Console → Authentication → Sign-in method → Anonymous → Enable.",
              e,
            );
          }
        }
        const u = { uid: cand.id, name: cand.name, role: "candidate", testId: cand.testId, ...cand };
        sessionStorage.setItem("rp_user", JSON.stringify(u));
        setUser(u);
        return { ok: true, user: u };
      }
      return { ok: false, error: "Invalid Candidate ID or Password" };
    }
  };

  const signOut = () => {
    sessionStorage.removeItem("rp_user");
    firebaseSignOut(auth).catch(() => { });
    setUser(null);
  };

  return { user, signIn, signOut };
}

// ─── LOGIN SCREEN ─────────────────────────────────────────────────────────────
function LoginScreen({ onLogin, defaultRole = "admin" }) {
  const { C, S, isDark } = useTheme();
  const [id, setId] = useState("");
  const [pass, setPass] = useState("");
  const [role, setRole] = useState(defaultRole);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const { signIn } = useAuth();

  const handleSubmit = async () => {
    if (!id || !pass) return setError("Please fill all fields");
    setLoading(true);
    setError("");
    try {
      const res = await signIn(id, pass, role);
      if (res.ok) onLogin(res);
      else setError(res.error);
    } catch (err) {
      const code = err?.code;
      const msg = err?.message || String(err);
      console.error("Login / Firestore error:", code, err);
      if (code === "permission-denied") {
        setError("Firestore blocked this read. Deploy rules: firebase deploy --only firestore:rules");
      } else if (code === "unavailable" || code === "failed-precondition") {
        setError("Cannot reach Firestore. Enable Firestore (Native) in Firebase Console for this project.");
      } else if (code === "invalid-api-key" || /api[- ]?key/i.test(msg)) {
        setError("Invalid Firebase API key. Check .env matches your new Firebase web app, then restart npm run dev.");
      } else {
        setError(msg ? `Database error: ${msg}` : "Database connection error");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="ha-shell" style={{ ...S.app, display: "flex", alignItems: "center", justifyContent: "center", padding: "clamp(1rem, 4vw, 1.75rem)" }}>
      <LoginThemeToolbar />
      <div style={{ width: "100%", maxWidth: 420 }}>
        <div style={{ textAlign: "center", marginBottom: "2rem" }}>
          <div
            style={{
              width: 92,
              height: 92,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 auto 1.25rem",
              padding: 0,
              boxSizing: "border-box",
            }}
          >
            <img
              src="/team-rsaa-circle-logo-transparent.png"
              alt=""
              role="presentation"
              width={92}
              height={92}
              decoding="async"
              fetchPriority="high"
              style={{
                display: "block",
                width: 92,
                height: "auto",
                objectFit: "contain",
                filter: "drop-shadow(0 10px 24px rgba(99, 102, 241, 0.22))",
              }}
            />
          </div>
          <h1
            style={{
              margin: 0,
              fontSize: 30,
              fontWeight: 800,
              letterSpacing: "-0.03em",
              color: isDark ? "#c4b5fd" : "#7c3aed",
              textShadow: isDark ? "0 2px 14px rgba(129, 140, 248, 0.35)" : "0 1px 8px rgba(124, 58, 237, 0.22)",
            }}
          >
            TEAM-RSAA
          </h1>
          <p style={{ margin: "8px 0 0", color: C.muted, fontSize: 15, lineHeight: 1.45 }}>
            Technical Evaluation And Management for Role Specific Adaptive Assessments
          </p>
        </div>

        <div style={S.card}>
          <div
            style={{
              display: "flex",
              gap: 4,
              background: `linear-gradient(135deg, ${C.accent}12, ${C.cyan}10, ${C.accent3}10)`,
              borderRadius: 11,
              padding: 5,
              marginBottom: "1.35rem",
              border: `1px solid ${C.border}`,
            }}
          >
            {["admin", "candidate"].map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => {
                  setRole(r);
                  setError("");
                }}
                style={{
                  flex: 1,
                  padding: "10px 0",
                  border: "none",
                  cursor: "pointer",
                  borderRadius: 8,
                  fontWeight: 600,
                  fontSize: 13,
                  background: role === r ? C.surface : "transparent",
                  color: role === r ? C.text : C.muted,
                  boxShadow: role === r ? C.loginToggleShadow : "none",
                }}
              >
                {r === "admin" ? "Admin" : "Candidate"}
              </button>
            ))}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <input
              style={S.input}
              placeholder={role === "admin" ? "Username (admin@gmail.com)" : "Candidate ID"}
              value={id}
              onChange={(e) => setId(e.target.value)}
              autoComplete={role === "admin" ? "username" : "off"}
            />
            <input
              style={S.input}
              type="password"
              placeholder="Password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
              autoComplete="current-password"
            />
            {error && (
              <div
                style={{
                  color: C.danger,
                  fontSize: 13,
                  textAlign: "center",
                  padding: "10px 12px",
                  borderRadius: 10,
                  background: "rgba(220, 38, 38, 0.06)",
                  border: `1px solid rgba(220, 38, 38, 0.2)`,
                }}
              >
                {error}
              </div>
            )}
            <button type="button" onClick={handleSubmit} disabled={loading} style={{ ...S.btn("primary"), width: "100%", opacity: loading ? 0.7 : 1 }}>
              {loading ? "Verifying…" : "Sign in"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function LoginThemeToolbar() {
  const { pref, setPref, C, S, isDark } = useTheme();
  return (
    <div
      style={{
        position: "fixed",
        top: 12,
        right: 12,
        zIndex: 50,
        display: "flex",
        gap: 4,
        padding: 4,
        borderRadius: 12,
        background: isDark ? "rgba(21, 24, 34, 0.92)" : "rgba(255,255,255,0.88)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
        border: `1px solid ${C.border}`,
        boxShadow: isDark ? "0 8px 32px rgba(0,0,0,0.5)" : "0 8px 28px rgba(15, 23, 42, 0.12)",
      }}
    >
      {[
        { id: "light", label: "Light theme", glyph: "☀" },
        { id: "dark", label: "Dark theme", glyph: "☽" },
        { id: "system", label: "Match device", glyph: "A" },
      ].map(({ id, label, glyph }) => (
        <button
          key={id}
          type="button"
          aria-label={label}
          title={label}
          onClick={() => setPref(id)}
          style={
            pref === id
              ? { ...S.btn("primary", "sm"), padding: "6px 11px", minWidth: 40 }
              : { ...S.btn("ghost", "sm"), padding: "6px 11px", minWidth: 40, border: "1px solid transparent", color: C.muted }
          }
        >
          {glyph}
        </button>
      ))}
    </div>
  );
}

function SettingsView() {
  const { C, S, pref, setPref, effective } = useTheme();
  const modes = [
    { id: "light", label: "Light", hint: "Always use bright theme", glyph: "☀" },
    { id: "dark", label: "Dark", hint: "Easier at night", glyph: "☽" },
    { id: "system", label: "Match device", hint: "Follow OS setting", glyph: "A" },
  ];
  return (
    <div style={{ maxWidth: 560 }}>
      <h1 style={{ margin: "0 0 0.5rem", fontSize: 26, fontWeight: 700 }}>Settings</h1>
      <p style={{ margin: "0 0 2rem", color: C.muted }}>
        Active appearance: <strong style={{ color: C.text }}>{effective}</strong>
        {pref === "system" ? " · follows device" : ""}
      </p>
      <div style={S.card}>
        <h3 style={{ margin: "0 0 0.75rem", fontSize: 16 }}>Appearance</h3>
        <p style={{ margin: "0 0 1.25rem", fontSize: 14, color: C.muted, lineHeight: 1.55 }}>
          Choose light, dark, or match what your system uses (saved on this browser).
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {modes.map((m) => {
            const on = pref === m.id;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => setPref(m.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  textAlign: "left",
                  width: "100%",
                  padding: "14px 16px",
                  borderRadius: 12,
                  border: `2px solid ${on ? C.accent : C.border}`,
                  background: on ? C.accentDim : C.surface,
                  cursor: "pointer",
                  color: C.text,
                }}
              >
                <span style={{ fontSize: 22, width: 32, textAlign: "center", flexShrink: 0 }}>{m.glyph}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontWeight: 700 }}>{m.label}</span>
                  <span style={{ display: "block", fontSize: 13, color: C.muted, marginTop: 2 }}>{m.hint}</span>
                </span>
                {on ? (
                  <span style={{ fontSize: 13, fontWeight: 700, color: C.accent }}>✓</span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}


// Note: Ensure the rest of your sub-components (AdminPanel, etc.) 
// are pasted below this if they were in the same file.
// ─── ADMIN PANEL SHELL ────────────────────────────────────────────────────────
function AdminPanel({ user, onSignOut }) {
  const { C, S, isDark } = useTheme();
  const compact = useResponsive(900);
  const [navOpen, setNavOpen] = useState(false);
  const [view, setView] = useState("dashboard");
  const [tests, setTests] = useState([]);
  const [results, setResults] = useState([]);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    const unsubTests = onSnapshot(
      collection(db, "tests"),
      (snap) => {
        setTests(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setLoadError("");
      },
      (err) => {
        console.error("Failed to load tests:", err);
        setLoadError("Unable to load tests/results from Firestore. Check rules/auth configuration.");
      }
    );

    const unsubResults = onSnapshot(
      collection(db, "results"),
      (snap) => {
        setResults(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      },
      (err) => {
        console.error("Failed to load results:", err);
        setLoadError("Unable to load tests/results from Firestore. Check rules/auth configuration.");
      }
    );

    return () => {
      unsubTests();
      unsubResults();
    };
  }, []);

  const go = (id) => {
    setView(id);
    if (compact) setNavOpen(false);
  };

  const navItems = [
    { id: "dashboard", label: "Dashboard", icon: "📊", hue: C.accent },
    { id: "create", label: "Create Test", icon: "➕", hue: C.accent3 },
    { id: "tests", label: "Manage Tests", icon: "📋", hue: C.cyan },
    { id: "monitor", label: "Live Monitor", icon: "👁️", hue: C.warning },
    { id: "results", label: "Results", icon: "📑", hue: C.success },
    { id: "settings", label: "Settings", icon: "⚙️", hue: C.coral },
  ];

  const sidebarWidth = 232;

  return (
    <div style={{ ...S.app, display: "flex", position: "relative" }}>
      {compact && navOpen ? (
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => setNavOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 35,
            border: "none",
            padding: 0,
            margin: 0,
            cursor: "pointer",
            background: C.modalBackdrop,
          }}
        />
      ) : null}

      {compact ? (
        <header
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            height: 52,
            padding: "0 10px 0 6px",
            display: "flex",
            alignItems: "center",
            gap: 8,
            zIndex: 25,
            background: C.surface,
            borderBottom: `1px solid ${C.border}`,
            boxShadow: isDark ? "0 2px 14px rgba(0,0,0,0.4)" : "0 2px 14px rgba(15,23,42,0.08)",
          }}
        >
          <button
            type="button"
            onClick={() => setNavOpen(true)}
            aria-label="Open navigation"
            style={{ ...S.btn("ghost", "sm"), padding: "8px 12px" }}
          >
            ☰
          </button>
          <img
            src="/team-rsaa-circle-logo-transparent.png"
            alt="TEAM-RSAA logo"
            width={34}
            height={34}
            decoding="async"
            style={{ display: "block", width: 34, height: 34, objectFit: "contain", borderRadius: 999, boxShadow: "0 4px 12px rgba(99, 102, 241, 0.2)" }}
          />
          <span style={{ fontWeight: 800, fontFamily: "'Outfit', sans-serif", letterSpacing: "-0.03em" }}>TEAM-RSAA</span>
          <span style={{ marginLeft: "auto", fontSize: 12, color: C.muted, fontWeight: 600, maxWidth: "45vw", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            Admin
          </span>
        </header>
      ) : null}

      <aside
        style={{
          width: sidebarWidth,
          background: C.sidebarGradient,
          borderRight: `1px solid ${C.border}`,
          boxShadow: compact
            ? `8px 0 40px rgba(0,0,0,${isDark ? 0.55 : 0.15})`
            : "4px 0 36px rgba(99, 102, 241, 0.12)",
          display: "flex",
          flexDirection: "column",
          padding: "1.5rem 0",
          position: "fixed",
          top: 0,
          left: 0,
          bottom: 0,
          zIndex: compact ? 40 : 10,
          transform: compact && !navOpen ? "translateX(-100%)" : "translateX(0)",
          transition: "transform 0.22s ease, box-shadow 0.2s ease",
        }}
      >
        <div style={{ padding: "0 1.25rem 1.35rem", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
            <div
              style={{
                width: 40,
                height: 40,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                overflow: "hidden",
              }}
            >
              <img
                src="/team-rsaa-circle-logo-transparent.png"
                alt="TEAM-RSAA logo"
                width={40}
                height={40}
                decoding="async"
                style={{ display: "block", width: 40, height: 40, objectFit: "contain", borderRadius: 999, boxShadow: "0 6px 16px rgba(99, 102, 241, 0.2)" }}
              />
            </div>
            <div>
              <div style={{ fontSize: 17, fontWeight: 700, fontFamily: "'Outfit', sans-serif", letterSpacing: "-0.02em" }}>
                TEAM-RSAA
              </div>
              <div style={{ fontSize: 11, color: C.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Admin
              </div>
            </div>
          </div>
        </div>
        <nav style={{ flex: 1, padding: "1rem 0.65rem", overflowY: "auto" }}>
          {navItems.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => go(n.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 11,
                width: "100%",
                padding: "11px 14px",
                marginBottom: 4,
                border: "none",
                cursor: "pointer",
                borderRadius: 10,
                background: view === n.id ? `${n.hue}22` : "transparent",
                color: view === n.id ? n.hue : C.muted,
                fontSize: 14,
                fontWeight: view === n.id ? 700 : 500,
                textAlign: "left",
                borderLeft: view === n.id ? `3px solid ${n.hue}` : "3px solid transparent",
                transition: "background 0.15s ease, color 0.15s ease",
              }}
            >
              <span style={{ fontSize: 16, opacity: 0.95 }}>{n.icon}</span>
              {n.label}
            </button>
          ))}
        </nav>
        <div style={{ padding: "1rem 1.25rem", borderTop: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{user.name}</div>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 12 }}>Administrator</div>
          <button type="button" onClick={onSignOut} style={{ ...S.btn("ghost", "sm"), width: "100%", color: C.muted }}>
            Sign out
          </button>
        </div>
      </aside>

      <div
        style={{
          marginLeft: compact ? 0 : sidebarWidth,
          flex: 1,
          padding: compact ? "4.5rem clamp(0.75rem, 3vw, 1.5rem) 1.5rem" : "2rem clamp(1rem, 3vw, 2.25rem)",
          overflowY: "auto",
          width: compact ? "100%" : `calc(100% - ${sidebarWidth}px)`,
          maxWidth: compact ? "100%" : `calc(100vw - ${sidebarWidth}px)`,
        }}
      >
        {loadError && (
          <div style={{ ...S.card, border: `1px solid ${C.warning}`, marginBottom: "1rem" }}>
            <div style={{ color: C.warning, fontSize: 13 }}>{loadError}</div>
          </div>
        )}
        {view === "dashboard" && <AdminDashboard tests={tests} results={results} setView={go} />}
        {view === "create" && <CreateTest onCreated={() => go("tests")} />}
        {view === "tests" && <ManageTests tests={tests} setTests={setTests} />}
        {view === "monitor" && <LiveMonitor />}
        {view === "results" && <ResultsView results={results} />}
        {view === "settings" && <SettingsView />}
      </div>
    </div>
  );
}

// ─── ADMIN DASHBOARD ──────────────────────────────────────────────────────────
function AdminDashboard({ tests, results, setView }) {
  const { C, S } = useTheme();
  const compact = useResponsive(900);
  const activeTests = tests.filter((t) => t.status === "active").length;
  const avgScore = results.length
    ? Math.round(results.reduce((a, r) => a + (r.score || 0), 0) / results.length) + "%"
    : "—";

  return (
    <div>
      <div style={{ marginBottom: "2.25rem" }}>
        <h1
          style={{
            margin: 0,
            fontSize: 28,
            fontWeight: 800,
            letterSpacing: "-0.03em",
            background: `linear-gradient(135deg, ${C.accent}, ${C.accent2}, ${C.cyan})`,
            WebkitBackgroundClip: "text",
            backgroundClip: "text",
            color: "transparent",
          }}
        >
          Dashboard
        </h1>
        <p style={{ margin: "6px 0 0", color: C.muted, fontSize: 15, lineHeight: 1.5 }}>
          Overview of recruitment assessments
        </p>
      </div>

      <div style={{ display: "flex", gap: 16, marginBottom: "2rem", flexWrap: "wrap" }}>
        <Stat label="Total Tests" value={tests.length} color={C.accent} />
        <Stat label="Active Tests" value={activeTests} color={C.success} />
        <Stat label="Completed" value={results.length} color={C.purple} />
        <Stat label="Avg Score" value={avgScore} color={C.coral} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: compact ? "1fr" : "1fr 1fr", gap: 16 }}>
        <div style={S.card}>
          <h3 style={{ margin: "0 0 1rem", fontSize: 16, fontWeight: 600 }}>Recent Tests</h3>
          {tests.length === 0 ? (
            <div style={{ color: C.muted, fontSize: 14 }}>No tests created yet.</div>
          ) : (
            tests.slice(-5).reverse().map((t) => (
              <div key={t.id} style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "10px 0", borderBottom: `1px solid ${C.border}`,
              }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{t.position}</div>
                  <div style={{ fontSize: 12, color: C.muted }}>{t.numQuestions} questions · {t.duration} min</div>
                </div>
                <Tag color={t.status === "active" ? "success" : "warning"}>{t.status || "draft"}</Tag>
              </div>
            ))
          )}
          <button onClick={() => setView("create")} style={{ ...S.btn("primary", "sm"), marginTop: "1rem" }}>
            + Create New Test
          </button>
        </div>

        <div style={S.card}>
          <h3 style={{ margin: "0 0 1rem", fontSize: 16, fontWeight: 600 }}>Quick Actions</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {[
              { label: "Create New Assessment", icon: "➕", hue: C.accent3, action: () => setView("create") },
              { label: "View Live Monitor", icon: "👁️", hue: C.cyan, action: () => setView("monitor") },
              { label: "Browse Results", icon: "📈", hue: C.purple, action: () => setView("results") },
              { label: "Manage Tests", icon: "⚙️", hue: C.warning, action: () => setView("tests") },
            ].map((a) => (
              <button key={a.label} onClick={a.action} style={{
                ...S.btn("ghost"),
                display: "flex", alignItems: "center", gap: 10, textAlign: "left", width: "100%",
                border: `1px solid ${a.hue}40`,
                background: `linear-gradient(100deg, ${a.hue}16 0%, ${C.surface} 52%)`,
                color: C.text,
                fontWeight: 600,
              }}>
                <span style={{ fontSize: 17 }}>{a.icon}</span> {a.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function LabelInput({ label, value, onChange, placeholder, type = "text", autoComplete }) {
  const { C, S } = useTheme();
  return (
    <div>
      <label style={{ display: "block", fontSize: 13, color: C.muted, marginBottom: 6 }}>{label}</label>
      <input
        style={S.input}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
      />
    </div>
  );
}

/** Direct send via EmailJS, or open mail app as fallback. */
function InviteEmailBlock({ email, onEmailChange, opts }) {
  const { C, S } = useTheme();
  const [sending, setSending] = useState(false);
  const [sentOk, setSentOk] = useState(false);
  const directOk = isEmailJsConfigured();

  const mailtoOpts = {
    position: opts.position,
    candidateName: opts.candidateName,
    testId: opts.testId,
    candidateId: opts.candidateId,
    password: opts.password,
    link: opts.link,
  };

  const resolvedLink = resolveCandidateInviteLink(opts.testId, opts.candidateId, opts.link);
  const shareBlocked = getInviteBlockedReason(resolvedLink);

  const trySend = async () => {
    const to = email.trim();
    if (!isProbablyValidEmail(to)) {
      alert("Please enter a valid email address.");
      return;
    }
    if (shareBlocked) {
      alert(shareBlocked);
      return;
    }
    if (!directOk) {
      alert(
        "To send without opening your mail app, set up EmailJS (free):\n\n" +
        "1) Create an account at emailjs.com\n" +
        "2) Add an email service + template. Use variables: to_email, subject, message (and optionally message_html)\n" +
        "3) Set the template recipient (To) to: {{to_email}}\n" +
        "4) Copy PUBLIC_KEY, SERVICE_ID, TEMPLATE_ID into .env as VITE_EMAILJS_* (see .env.example)\n" +
        "5) Restart npm run dev\n\n" +
        "For now you can use “Open in email app” below.",
      );
      return;
    }
    setSending(true);
    setSentOk(false);
    const result = await sendAssessmentInviteEmail(to, mailtoOpts);
    setSending(false);
    if (result.ok) {
      setSentOk(true);
      setTimeout(() => setSentOk(false), 2500);
    } else {
      alert(result.message || "Could not send email.");
    }
  };

  const openMailto = () => {
    const to = email.trim();
    if (!isProbablyValidEmail(to)) {
      alert("Please enter a valid email address.");
      return;
    }
    if (shareBlocked) {
      alert(shareBlocked);
      return;
    }
    const out = buildAssessmentInviteMailto(to, mailtoOpts);
    if (out.error) {
      alert(out.error);
      return;
    }
    window.location.href = out.href;
  };

  return (
    <div
      style={{
        background: C.bgMuted,
        padding: "12px",
        borderRadius: 8,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600 }}>Email credentials to candidate</div>
      {shareBlocked ? (
        <p style={{ margin: 0, fontSize: 12, color: C.warning, whiteSpace: "pre-wrap" }}>{shareBlocked}</p>
      ) : null}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "stretch" }}>
        <input
          type="email"
          value={email}
          onChange={(e) => onEmailChange(e.target.value)}
          placeholder="Type recipient email…"
          autoComplete="email"
          style={{ ...S.input, flex: "1 1 200px", minWidth: 0 }}
        />
        <button
          type="button"
          disabled={sending || !!shareBlocked}
          onClick={trySend}
          style={{
            ...S.btn("primary", "sm"),
            flex: "0 0 auto",
            whiteSpace: "nowrap",
            opacity: sending ? 0.7 : 1,
          }}
        >
          {sending ? "Sending…" : sentOk ? "✓ Sent" : "Send email"}
        </button>
        <button
          type="button"
          disabled={!!shareBlocked}
          onClick={openMailto}
          style={{ ...S.btn("ghost", "sm"), flex: "0 0 auto", whiteSpace: "nowrap" }}
        >
          Open in email app
        </button>
      </div>
      <p style={{ margin: 0, fontSize: 12, color: C.muted }}>
        {directOk ? (
          <>
            Sends directly from this page via EmailJS.{" "}
            <a href={EMAILJS_DOCS_URL} target="_blank" rel="noreferrer" style={{ color: C.accent }}>
              Docs
            </a>
          </>
        ) : (
          <>
            Add <code style={{ fontSize: 11 }}>VITE_EMAILJS_*</code> keys in <code style={{ fontSize: 11 }}>.env</code> for direct
            send — see <code style={{ fontSize: 11 }}>.env.example</code>. Until then, use <strong>Open in email app</strong>.
          </>
        )}
      </p>
    </div>
  );
}

// ─── CREATE TEST ──────────────────────────────────────────────────────────────
function CreateTest({ onCreated }) {
  const { C, S } = useTheme();
  const compact = useResponsive(900);
  const [form, setForm] = useState({
    position: "", numQuestions: 10, duration: 30,
    skills: "", candidateName: "", candidateEmail: "", expiryHours: 24,
    proctoringIntervalSec: 30,
  });
  const [generated, setGenerated] = useState(null);
  const [loading, setLoading] = useState(false);
  const [copyAllDone, setCopyAllDone] = useState(false);
  const [inviteEmailDraft, setInviteEmailDraft] = useState("");

  const setF = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const handleCreate = async () => {
    if (!form.position) return alert("Please enter a position name");
    setLoading(true);
    try {
      const testId = "T" + uid();
      const candidateId = "C" + uid();
      const password = uid().toLowerCase();
      const link = `${getPublicAppOrigin()}?test=${testId}&cid=${candidateId}`;

      const testData = {
        ...form,
        candidateEmail: form.candidateEmail.trim(),
        skills: form.skills.split(",").map((s) => s.trim()).filter(Boolean),
        testId,
        candidateId,
        password,
        link,
        status: "active",
        createdAt: nowISO(),
        expiresAt: new Date(Date.now() + form.expiryHours * 3600000).toISOString(),
      };

      await dbSet("tests", testId, testData);
      await dbSet("candidates", candidateId, {
        candidateId,
        password,
        testId,
        name: form.candidateName || "Candidate",
        email: form.candidateEmail.trim() || null,
        status: "pending",
        createdAt: nowISO(),
      });

      setGenerated({
        testId,
        candidateId,
        password,
        link,
        candidateEmail: form.candidateEmail.trim(),
        position: form.position,
        candidateName: form.candidateName,
      });
      setInviteEmailDraft(form.candidateEmail.trim());
    } catch (err) {
      console.error("Failed to create test:", err);
      alert("Could not create test in Firestore. Please check Firestore rules/auth.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <h1 style={{ margin: "0 0 0.5rem", fontSize: 26, fontWeight: 700 }}>Create Assessment</h1>
      <p style={{ margin: "0 0 2rem", color: C.muted }}>Configure a new recruitment test</p>

      <div style={{ display: "grid", gridTemplateColumns: compact ? "1fr" : "1fr 1fr", gap: 24 }}>
        {/* Left column */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={S.card}>
            <h3 style={{ margin: "0 0 1.25rem", fontSize: 16 }}>Test Details</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <LabelInput label="Position / Role *" value={form.position} onChange={(v) => setF("position", v)} placeholder="e.g. Senior Frontend Developer" />
              <LabelInput label="Candidate Name (Optional)" value={form.candidateName} onChange={(v) => setF("candidateName", v)} placeholder="e.g. John Smith" />
              <LabelInput
                label="Candidate Email (Optional — pre-fills send box below)"
                value={form.candidateEmail}
                onChange={(v) => setF("candidateEmail", v)}
                placeholder="candidate@company.com"
                type="email"
                autoComplete="email"
              />
              <LabelInput label="Skills / Topics (comma-separated)" value={form.skills} onChange={(v) => setF("skills", v)} placeholder="React, TypeScript, CSS" />
            </div>
          </div>

          <div style={S.card}>
            <h3 style={{ margin: "0 0 1.25rem", fontSize: 16 }}>Test Configuration</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {[
                { label: "Number of Questions", key: "numQuestions", min: 5, max: 60, step: 1, suffix: "" },
                { label: "Duration (minutes)", key: "duration", min: 10, max: 120, step: 5, suffix: " min" },
                { label: "Link Expiry (hours)", key: "expiryHours", min: 1, max: 168, step: 1, suffix: "h" },
              ].map(({ label, key, min, max, step, suffix }) => (
                <div key={key}>
                  <label style={{ display: "block", fontSize: 13, color: C.muted, marginBottom: 6 }}>
                    {label}: <strong style={{ color: C.text }}>{form[key]}{suffix}</strong>
                  </label>
                  <input
                    type="range" min={min} max={max} step={step} value={form[key]}
                    onChange={(e) => setF(key, +e.target.value)}
                    style={{ width: "100%", accentColor: C.accent }}
                  />
                </div>
              ))}
              <div>
                <label style={{ display: "block", fontSize: 13, color: C.muted, marginBottom: 6 }}>
                  Proctoring screenshots
                </label>
                <select
                  value={form.proctoringIntervalSec}
                  onChange={(e) => setF("proctoringIntervalSec", Number(e.target.value))}
                  style={{ ...S.input, width: "100%", cursor: "pointer" }}
                >
                  <option value={30}>Every 30 seconds</option>
                  <option value={120}>Every 2 minutes</option>
                </select>
              </div>
            </div>
          </div>
        </div>

        {/* Right column */}
        <div>
          <div style={S.card}>
            <h3 style={{ margin: "0 0 1rem", fontSize: 16 }}>Adaptive Difficulty System</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {[
                { label: "Questions 1–3", level: "Easy", color: "success", desc: "All candidates start here" },
                { label: "Correct streak (×3)", level: "Medium", color: "warning", desc: "Unlocked after 3 correct answers" },
                { label: "Perfect performance", level: "Hard", color: "danger", desc: "Unlocked after passing Medium" },
                { label: "Wrong answers", level: "Drops", color: "purple", desc: "Difficulty decreases on failure" },
              ].map((r) => (
                <div key={r.label} style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "10px 12px", background: C.bg, borderRadius: 8,
                }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{r.label}</div>
                    <div style={{ fontSize: 12, color: C.muted }}>{r.desc}</div>
                  </div>
                  <Tag color={r.color}>{r.level}</Tag>
                </div>
              ))}
            </div>
          </div>

          {generated ? (
            <div style={{ ...S.card, marginTop: 16, border: `1px solid ${C.success}` }}>
              <h3 style={{ margin: "0 0 1rem", fontSize: 16, color: C.success }}>✅ Test Created!</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {[
                  { label: "Test ID", value: generated.testId },
                  { label: "Candidate ID", value: generated.candidateId },
                  { label: "Password", value: generated.password },
                  { label: "Test Link", value: generated.link },
                ].map((f) => (
                  <div
                    key={f.label}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 10,
                      background: C.bgMuted,
                      padding: "10px 12px",
                      borderRadius: 8,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 11, color: C.muted, marginBottom: 3 }}>{f.label}</div>
                      <div style={{ fontSize: 13, fontFamily: "monospace", color: C.accent, wordBreak: "break-all" }}>
                        {f.value}
                      </div>
                    </div>
                    <CopyIconButton text={f.value} title={`Copy ${f.label}`} />
                  </div>
                ))}
                <button
                  onClick={async () => {
                    const block =
                      `Test ID: ${generated.testId}\n` +
                      `Candidate ID: ${generated.candidateId}\n` +
                      `Password: ${generated.password}\n` +
                      `Link: ${generated.link}`;
                    const ok = await copyTextToClipboard(block);
                    if (ok) {
                      setCopyAllDone(true);
                      setTimeout(() => setCopyAllDone(false), 1600);
                    } else {
                      alert("Could not copy. Allow clipboard access for this site or copy each field with the icon.");
                    }
                  }}
                  style={S.btn("ghost", "sm")}
                >
                  {copyAllDone ? "✓ Copied all" : "📋 Copy all (ID, password, link)"}
                </button>
                <InviteEmailBlock
                  email={inviteEmailDraft}
                  onEmailChange={setInviteEmailDraft}
                  opts={{
                    position: generated.position,
                    candidateName: generated.candidateName,
                    testId: generated.testId,
                    candidateId: generated.candidateId,
                    password: generated.password,
                    link: generated.link,
                  }}
                />
                <button onClick={onCreated} style={S.btn("ghost", "sm")}>View All Tests →</button>
              </div>
            </div>
          ) : (
            <button
              onClick={handleCreate}
              disabled={loading}
              style={{ ...S.btn("primary"), width: "100%", marginTop: 16, padding: "14px", fontSize: 15, fontWeight: 700 }}
            >
              {loading ? "Generating..." : "🚀 Generate Test + Credentials"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── MANAGE TESTS ─────────────────────────────────────────────────────────────
function ManageTests({ tests, setTests }) {
  const { C, S } = useTheme();
  const compact = useResponsive(700);
  const [selected, setSelected] = useState(null);
  const [inviteToEmail, setInviteToEmail] = useState("");

  const deleteTest = async (id) => {
    if (!window.confirm("Delete this test? This cannot be undone.")) return;
    await deleteDoc(doc(db, "tests", id));
    setTests((t) => t.filter((x) => x.id !== id));
  };

  return (
    <div>
      <h1 style={{ margin: "0 0 0.5rem", fontSize: 26, fontWeight: 700 }}>Manage Tests</h1>
      <p style={{ margin: "0 0 2rem", color: C.muted }}>{tests.length} tests total</p>

      {tests.length === 0 ? (
        <div style={{ ...S.card, textAlign: "center", padding: "3rem" }}>
          <div style={{ fontSize: 48, marginBottom: "1rem" }}>📋</div>
          <p style={{ color: C.muted }}>No tests yet. Create your first assessment.</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {tests.map((t) => {
            const normalizedSkills = Array.isArray(t.skills)
              ? t.skills
              : typeof t.skills === "string"
                ? t.skills.split(",").map((s) => s.trim()).filter(Boolean)
                : [];
            const createdAtDate =
              typeof t.createdAt === "string" || typeof t.createdAt === "number"
                ? new Date(t.createdAt)
                : t.createdAt?.toDate?.() || null;

            return (
              <div
                key={t.id}
                style={{
                  ...S.card,
                  display: "flex",
                  flexDirection: compact ? "column" : "row",
                  alignItems: compact ? "stretch" : "center",
                  justifyContent: "space-between",
                  gap: compact ? 12 : 0,
                }}
              >
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                    <span style={{ fontSize: 16, fontWeight: 700 }}>{t.position}</span>
                    <Tag color={t.status === "active" ? "success" : "warning"}>{t.status || "draft"}</Tag>
                  </div>
                  <div style={{ fontSize: 13, color: C.muted, display: "flex", gap: 16, flexWrap: "wrap" }}>
                    <span>🎯 {t.numQuestions} questions</span>
                    <span>⏱ {t.duration} min</span>
                    <span>🆔 {t.candidateId}</span>
                    <span>📅 {createdAtDate && !Number.isNaN(createdAtDate.getTime()) ? createdAtDate.toLocaleDateString() : "—"}</span>
                  </div>
                  {normalizedSkills.length > 0 && (
                    <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {normalizedSkills.map((s) => (
                        <span key={s} style={{ fontSize: 11, padding: "2px 8px", background: C.accentDim, borderRadius: 10, color: C.accent }}>{s}</span>
                      ))}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 8, flexShrink: 0, flexWrap: "wrap", ...(compact ? { width: "100%" } : {}) }}>
                  <button
                    onClick={() => {
                      setInviteToEmail((t.candidateEmail && String(t.candidateEmail)) || "");
                      setSelected(t);
                    }}
                    style={S.btn("ghost", "sm")}
                  >
                    View
                  </button>
                  <button onClick={() => deleteTest(t.id)} style={{ ...S.btn("ghost", "sm"), color: C.danger }}>Delete</button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <Modal open={!!selected} onClose={() => setSelected(null)} title="Test Details">
        {selected && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {Object.entries({
              Position: selected.position,
              "Test ID": selected.testId,
              "Candidate ID": selected.candidateId,
              "Candidate email": selected.candidateEmail || "—",
              Password: selected.password,
              Questions: selected.numQuestions,
              "Duration (min)": selected.duration,
              Status: selected.status,
              Created: selected.createdAt ? new Date(selected.createdAt).toLocaleString() : "—",
              Expires: selected.expiresAt ? new Date(selected.expiresAt).toLocaleString() : "N/A",
            }).map(([k, v]) => {
              const copyable =
                ["Test ID", "Candidate ID", "Password"].includes(k) ||
                (k === "Candidate email" && selected.candidateEmail);
              return (
                <div
                  key={k}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 10,
                    padding: "8px 0",
                    borderBottom: `1px solid ${C.border}`,
                    fontSize: 14,
                  }}
                >
                  <span style={{ color: C.muted, flexShrink: 0 }}>{k}</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, justifyContent: "flex-end" }}>
                    <span style={{ fontWeight: 500, textAlign: "right", wordBreak: "break-all" }}>{String(v)}</span>
                    {copyable ? <CopyIconButton text={String(v)} title={`Copy ${k}`} /> : null}
                  </div>
                </div>
              );
            })}
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                padding: "12px",
                background: C.bgMuted,
                borderRadius: 8,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>Test Link</div>
                <div style={{ fontSize: 12, fontFamily: "monospace", color: C.accent, wordBreak: "break-all" }}>
                  {selected.link}
                </div>
              </div>
              {selected.link ? <CopyIconButton text={selected.link} title="Copy test link" /> : null}
            </div>
            {selected.link && selected.password ? (
              <InviteEmailBlock
                email={inviteToEmail}
                onEmailChange={setInviteToEmail}
                opts={{
                  position: selected.position,
                  candidateName: selected.candidateName,
                  testId: selected.testId,
                  candidateId: selected.candidateId,
                  password: selected.password,
                  link: selected.link,
                }}
              />
            ) : null}
          </div>
        )}
      </Modal>
    </div>
  );
}

// ─── LIVE MONITOR ─────────────────────────────────────────────────────────────
function LiveMonitor() {
  const { C, S } = useTheme();
  const compact = useResponsive(640);
  const [sessions, setSessions] = useState([]);
  const [warningsByCandidate, setWarningsByCandidate] = useState({});
  const [monitorError, setMonitorError] = useState("");

  // Real-time Firestore listener on liveSessions collection
  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, "liveSessions"),
      (snap) => {
        const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        const completedMs = (s) => {
          const t = s.completedAt;
          if (!t) return 0;
          if (typeof t.toMillis === "function") return t.toMillis();
          if (typeof t.seconds === "number") return t.seconds * 1000;
          return 0;
        };
        list.sort((a, b) => {
          const aLive = a.status !== "completed";
          const bLive = b.status !== "completed";
          if (aLive && !bLive) return -1;
          if (!aLive && bLive) return 1;
          if (!aLive && !bLive) return completedMs(b) - completedMs(a);
          return 0;
        });
        setSessions(list);
        setMonitorError("");
      },
      (err) => {
        console.error("Live monitor load error:", err);
        setMonitorError("Unable to read live sessions. Check Firestore rules/auth.");
      }
    );
    return unsub; // unsubscribe on unmount
  }, []);

  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, "warnings"),
      (snap) => {
        const by = {};
        snap.docs.forEach((docSnap) => {
          const data = docSnap.data();
          const cid = data.candidateId;
          if (!cid) return;
          const ts = data.timestamp;
          const ms =
            ts && typeof ts.toMillis === "function"
              ? ts.toMillis()
              : typeof ts?.seconds === "number"
                ? ts.seconds * 1000
                : 0;
          if (!by[cid]) by[cid] = [];
          by[cid].push({
            message: String(data.message || ""),
            ms,
          });
        });
        Object.keys(by).forEach((k) => {
          by[k].sort((a, b) => b.ms - a.ms);
        });
        setWarningsByCandidate(by);
      },
      (err) => console.error("Warnings listener error:", err),
    );
    return unsub;
  }, []);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "2rem", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 26, fontWeight: 700 }}>Live Monitor</h1>
          <p style={{ margin: "4px 0 0", color: C.muted }}>Active candidates first; finished attempts stay visible with a Finished badge</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: C.success, animation: "pulse 1.5s infinite" }} />
          <span style={{ fontSize: 13, color: C.success }}>Live</span>
          <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}`}</style>
        </div>
      </div>

      {sessions.length === 0 ? (
        <div style={{ ...S.card, textAlign: "center", padding: "4rem" }}>
          <div style={{ fontSize: 48, marginBottom: "1rem" }}>👁️</div>
          <h3 style={{ color: C.muted, fontWeight: 400 }}>{monitorError || "No active sessions"}</h3>
          <p style={{ color: C.muted, fontSize: 14 }}>
            {monitorError || "Active candidate sessions will appear here in real-time"}
          </p>
          {/* Demo preview card */}
          <DemoMonitorCard />
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: compact ? "1fr" : "repeat(auto-fill, minmax(300px, 1fr))", gap: 16 }}>
          {sessions.map((s) => (
            <LiveSessionCard
              key={s.id}
              session={s}
              warningEntries={warningsByCandidate[s.candidateId || s.id] || []}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function formatFirestoreMs(ms) {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "—";
  }
}

function WarningMessageList({ entries, emptyHint, showHeading = true }) {
  const { C } = useTheme();
  if (!entries?.length) {
    return emptyHint ? (
      <div style={{ fontSize: 12, color: C.muted, marginTop: 10 }}>{emptyHint}</div>
    ) : null;
  }
  return (
    <div style={{ marginTop: showHeading ? 12 : 0 }}>
      {showHeading ? (
        <div style={{ fontSize: 12, fontWeight: 700, color: C.danger, marginBottom: 8 }}>Warning details</div>
      ) : null}
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: C.text, lineHeight: 1.45 }}>
        {entries.map((w, i) => (
          <li key={i} style={{ marginBottom: 8 }}>
            <span style={{ color: C.muted }}>{w.timeLabel || formatFirestoreMs(w.ms)}</span>
            {" — "}
            {w.message || w.msg || "—"}
          </li>
        ))}
      </ul>
    </div>
  );
}

function LiveSessionCard({ session, warningEntries = [] }) {
  const { C, S } = useTheme();
  const [deleting, setDeleting] = useState(false);
  const isCompleted = session.status === "completed";
  const pctLive = session.numQuestions
    ? Math.round(((session.currentQuestion || 0) / session.numQuestions) * 100)
    : 0;
  const pctCapped = isCompleted ? 100 : Math.min(100, pctLive);

  const handleRemoveFromMonitor = async () => {
    const label = session.name || session.candidateId || "this session";
    const hint = isCompleted
      ? "This only removes the card from Live Monitor. Saved results are not deleted."
      : "The candidate may still be testing; this card can reappear on the next live update.";
    if (!window.confirm(`Remove "${label}" from Live Monitor?\n\n${hint}`)) return;
    setDeleting(true);
    try {
      await deleteDoc(doc(db, "liveSessions", session.id));
    } catch (err) {
      console.error("Remove live session failed:", err);
      alert(err?.message || "Could not remove this session. Check Firestore rules and your connection.");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div style={{ ...S.card, opacity: isCompleted ? 0.92 : 1 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{session.name || session.candidateId}</div>
          <div style={{ fontSize: 12, color: C.muted }}>{session.position}</div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {isCompleted ? (
            <Tag color="success">
              Finished{typeof session.score === "number" ? ` · ${session.score}%` : ""}
            </Tag>
          ) : (
            <Tag color="success">Live</Tag>
          )}
          {session.warningCount > 0 && <Tag color="danger">⚠ {session.warningCount}</Tag>}
        </div>
      </div>
      <div style={{ width: "100%", height: 140, background: C.bgMuted, borderRadius: 8, overflow: "hidden", marginBottom: "0.9rem", border: `1px solid ${C.border}` }}>
        {session.previewImage ? (
          <img
            src={session.previewImage}
            alt="Candidate preview"
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : (
          <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontSize: 12 }}>
            Camera preview unavailable
          </div>
        )}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(88px, 1fr))", gap: 8, marginBottom: "0.75rem" }}>
        {[
          {
            label: "Question",
            value: isCompleted
              ? `${session.numQuestions}/${session.numQuestions}`
              : `${(session.currentQuestion || 0) + 1}`,
          },
          {
            label: isCompleted ? "Status" : "Time Left",
            value: isCompleted ? "Submitted" : session.timeLeft ? `${Math.floor(session.timeLeft / 60)}m` : "—",
          },
          { label: "Warnings", value: session.warningCount || 0 },
        ].map((s) => (
          <div key={s.label} style={{ background: C.bg, padding: "8px 10px", borderRadius: 8, textAlign: "center" }}>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{s.value}</div>
            <div style={{ fontSize: 11, color: C.muted }}>{s.label}</div>
          </div>
        ))}
      </div>
      <div style={{ background: C.bg, borderRadius: 4, height: 6 }}>
        <div style={{ width: `${pctCapped}%`, height: "100%", background: isCompleted ? C.success : C.accent, borderRadius: 4 }} />
      </div>
      <WarningMessageList
        entries={warningEntries.slice(0, 20).map((w) => ({
          ms: w.ms,
          timeLabel: formatFirestoreMs(w.ms),
          message: w.message,
        }))}
      />
      <button
        type="button"
        onClick={handleRemoveFromMonitor}
        disabled={deleting}
        style={{
          ...S.btn("ghost", "sm"),
          marginTop: 12,
          width: "100%",
          color: C.danger,
          borderColor: `${C.danger}55`,
          opacity: deleting ? 0.6 : 1,
        }}
      >
        {deleting ? "Removing…" : "Remove from monitor"}
      </button>
    </div>
  );
}

function DemoMonitorCard() {
  const { C, S } = useTheme();
  return (
    <div style={{ ...S.card, border: `1px solid ${C.accentDim}`, marginTop: "2rem", textAlign: "left" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>Demo Preview</div>
          <div style={{ fontSize: 12, color: C.muted }}>Senior Developer · Question 4/10</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Tag color="success">Active</Tag>
          <Tag color="danger">⚠ 1 warning</Tag>
        </div>
      </div>
      <div style={{
        width: "100%", height: 140, background: C.bgMuted, borderRadius: 8,
        display: "flex", alignItems: "center", justifyContent: "center",
        marginBottom: "1rem", position: "relative",
        border: `1px solid ${C.border}`,
      }}>
        <div style={{ textAlign: "center", color: C.muted }}>
          <div style={{ fontSize: 28, marginBottom: 6 }}>📹</div>
          <div style={{ fontSize: 12 }}>Camera Feed</div>
        </div>
        <div style={{ position: "absolute", top: 8, right: 8, width: 8, height: 8, borderRadius: "50%", background: C.success }} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(88px, 1fr))", gap: 8, marginBottom: "0.75rem" }}>
        {[{ label: "Progress", value: "40%" }, { label: "Time Left", value: "18:24" }, { label: "Warnings", value: 1 }].map((s) => (
          <div key={s.label} style={{ background: C.bg, padding: "8px 10px", borderRadius: 8, textAlign: "center" }}>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{s.value}</div>
            <div style={{ fontSize: 11, color: C.muted }}>{s.label}</div>
          </div>
        ))}
      </div>
      <div style={{ background: C.bg, borderRadius: 4, height: 6, marginBottom: "0.75rem" }}>
        <div style={{ width: "40%", height: "100%", background: C.accent, borderRadius: 4 }} />
      </div>
      <div style={{ fontSize: 12, color: C.muted }}>⚠ Tab switch detected at 14:32</div>
    </div>
  );
}

// ─── RESULTS VIEW ─────────────────────────────────────────────────────────────
function ResultsView({ results }) {
  const { C, S } = useTheme();
  const compact = useResponsive(780);
  const [selected, setSelected] = useState(null);
  const selectedAnswers =
    selected?.answers ||
    selected?.questionAnswers ||
    selected?.responses ||
    [];
  const selectedShots =
    selected?.proctoringScreenshots ||
    selected?.screenshots ||
    selected?.proctoringShots ||
    [];

  return (
    <div>
      <h1 style={{ margin: "0 0 0.5rem", fontSize: 26, fontWeight: 700 }}>Results</h1>
      <p style={{ margin: "0 0 2rem", color: C.muted }}>{results.length} assessments completed</p>

      {results.length === 0 ? (
        <div style={{ ...S.card, textAlign: "center", padding: "3rem" }}>
          <div style={{ fontSize: 48, marginBottom: "1rem" }}>📑</div>
          <p style={{ color: C.muted }}>Results will appear here after candidates complete their assessments</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {results.map((r) => (
            <div
              key={r.id}
              style={{
                ...S.card,
                display: "flex",
                flexDirection: compact ? "column" : "row",
                alignItems: compact ? "stretch" : "center",
                justifyContent: "space-between",
                gap: compact ? 14 : 12,
              }}
            >
              <div>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>{r.candidateName || r.candidateId}</div>
                <div style={{ fontSize: 13, color: C.muted }}>
                  {r.position} · {r.submittedAt ? new Date(r.submittedAt).toLocaleString() : "—"}
                </div>
              </div>
              <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", ...(compact ? { width: "100%", justifyContent: "space-between" } : {}) }}>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: r.score >= 70 ? C.success : r.score >= 40 ? C.warning : C.danger }}>
                    {r.score}%
                  </div>
                  <div style={{ fontSize: 11, color: C.muted }}>Score</div>
                </div>
                <button onClick={() => setSelected(r)} style={S.btn("ghost", "sm")}>Details</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={!!selected} onClose={() => setSelected(null)} title="Assessment Result">
        {selected && (
          <div>
            <div style={{ display: "grid", gridTemplateColumns: compact ? "1fr" : "repeat(3, minmax(0, 1fr))", gap: 12, marginBottom: "1.5rem" }}>
              <Stat label="Score" value={`${selected.score}%`} color={selected.score >= 70 ? C.success : C.warning} />
              <Stat label="Correct" value={`${selected.correct}/${selected.total}`} color={C.accent} />
              <Stat label="Warnings" value={selected.warnings || 0} color={C.danger} />
            </div>
            <div style={{ fontSize: 13, color: C.muted }}>
              Time taken: {selected.timeTaken || "—"} &nbsp;·&nbsp;
              Submitted: {selected.submittedAt ? new Date(selected.submittedAt).toLocaleString() : "—"}
            </div>

            <div style={{ ...S.card, marginTop: "1rem" }}>
              <h3 style={{ margin: "0 0 0.75rem", fontSize: 15 }}>Proctoring warnings</h3>
              {Array.isArray(selected.warningLog) && selected.warningLog.length > 0 ? (
                <WarningMessageList
                  showHeading={false}
                  entries={selected.warningLog.map((w) => ({
                    timeLabel: w.time,
                    message: w.msg,
                  }))}
                />
              ) : (selected.warnings || 0) > 0 ? (
                <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.5 }}>
                  This attempt has <strong>{selected.warnings}</strong> warning(s) on file, but the message list was not saved (older submissions).
                  Check <strong>Firestore → warnings</strong> filtered by this candidate, or use Live Monitor during the next attempt.
                </div>
              ) : (
                <div style={{ fontSize: 13, color: C.muted }}>No warnings recorded for this attempt.</div>
              )}
            </div>

            <div style={{ ...S.card, marginTop: "1rem" }}>
              <h3 style={{ margin: "0 0 0.75rem", fontSize: 15 }}>Question-wise Answers</h3>
              {!Array.isArray(selectedAnswers) || selectedAnswers.length === 0 ? (
                <div style={{ fontSize: 13, color: C.muted }}>
                  No answer details available for this record. This usually means this result was submitted before detailed Q/A logging was enabled.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {selectedAnswers.map((a, idx) => (
                    <div key={`${selected.id}_${idx}`} style={{ background: C.bg, borderRadius: 8, padding: "10px 12px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 6 }}>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>
                          Q{(a.questionIndex ?? idx) + 1}: {a.question || "Question text unavailable"}
                        </div>
                        <Tag color={a.correct ? "success" : "danger"}>{a.correct ? "Correct" : "Wrong"}</Tag>
                      </div>
                      <div style={{ fontSize: 12, color: C.muted }}>
                        Selected: {a.selectedOption || a.options?.[a.selected] || "Not answered"}
                      </div>
                      <div style={{ fontSize: 12, color: C.muted }}>
                        Correct: {a.correctOption || a.options?.[a.correctOptionIndex] || "N/A"}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={{ ...S.card, marginTop: "1rem" }}>
              <h3 style={{ margin: "0 0 0.75rem", fontSize: 15 }}>Proctoring Screenshots</h3>
              {!Array.isArray(selectedShots) || selectedShots.length === 0 ? (
                <div style={{ fontSize: 13, color: C.muted }}>
                  No screenshots on this result. Common causes: test finished before the first capture interval, camera unavailable,
                  or (only if using Storage mode) rules/Anonymous auth. With default inline mode, ensure camera works and check &quot;Proctoring Status&quot; during a run.
                </div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 10 }}>
                  {selectedShots.map((shot, idx) => (
                    <a
                      key={`${selected.id}_shot_${idx}`}
                      href={shot.url}
                      target="_blank"
                      rel="noreferrer"
                      style={{ textDecoration: "none", color: "inherit" }}
                    >
                      <div style={{ background: C.bg, borderRadius: 8, padding: 8 }}>
                        <div style={{ width: "100%", aspectRatio: "16/9", background: C.bgMuted, borderRadius: 6, overflow: "hidden", marginBottom: 6, border: `1px solid ${C.border}` }}>
                          <img src={shot.url} alt={`Proctoring capture ${idx + 1}`} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                        </div>
                        <div style={{ fontSize: 11, color: C.muted }}>
                          {shot.capturedAt ? new Date(shot.capturedAt).toLocaleString() : "Timestamp unavailable"}
                        </div>
                      </div>
                    </a>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

// ─── CANDIDATE PANEL ──────────────────────────────────────────────────────────
function CandidatePanel({ user, onSignOut }) {
  const { S } = useTheme();
  const [phase, setPhase] = useState("disclaimer");
  const [testData, setTestData] = useState(null);
  const [result, setResult] = useState(null);

  useEffect(() => {
    dbGet("tests", user.testId).then((t) => {
      if (t) setTestData(t);
      else alert("Test not found. Please contact your recruiter.");
    });
  }, [user.testId]);

  if (!testData) return <div style={S.app}><Spinner /></div>;

  return (
    <div style={S.app}>
      {phase === "disclaimer" && (
        <DisclaimerScreen testData={testData} user={user} onStart={() => setPhase("test")} />
      )}
      {phase === "test" && (
        <TestInterface
          testData={testData}
          user={user}
          onComplete={(r) => { setResult(r); setPhase("completed"); }}
        />
      )}
      {phase === "completed" && (
        <CompletionScreen result={result} testData={testData} />
      )}
    </div>
  );
}

// ─── DISCLAIMER SCREEN ────────────────────────────────────────────────────────
function DisclaimerScreen({ testData, user, onStart }) {
  const { C, S } = useTheme();
  const compact = useResponsive(560);
  const [cameraOk, setCameraOk] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const videoRef = useRef(null);
  const cameraStreamRef = useRef(null);

  useEffect(() => {
    return () => {
      cameraStreamRef.current?.getTracks?.().forEach((t) => t.stop());
      cameraStreamRef.current = null;
    };
  }, []);

  const requestCamera = async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        alert("Camera is not supported in this browser. Use a modern browser over HTTPS (or localhost).");
        return;
      }
      cameraStreamRef.current?.getTracks?.().forEach((t) => t.stop());
      const stream = await getCameraStream();
      cameraStreamRef.current = stream;
      if (videoRef.current) {
        await attachCameraStreamToVideo(videoRef.current, stream);
      }
      setCameraOk(true);
    } catch (err) {
      const name = err?.name || "";
      const hint =
        name === "NotAllowedError" || name === "PermissionDeniedError"
          ? "Allow camera access in the browser address bar or site settings."
          : name === "NotFoundError"
            ? "No camera was found on this device."
            : err?.message || "Unknown error";
      alert(`Camera access is required to take this assessment.\n\n${hint}`);
      setCameraOk(false);
    }
  };

  return (
    <div className="ha-shell" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: "clamp(1rem, 4vw, 2rem)", ...S.app }}>
      <LoginThemeToolbar />
      <div style={{ maxWidth: 620, width: "100%" }}>
        <div style={{ textAlign: "center", marginBottom: "2rem" }}>
          <div
            style={{
              width: 86,
              height: 86,
              margin: "0 auto 1rem",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <img
              src="/team-rsaa-circle-logo-transparent.png"
              alt="TEAM-RSAA logo"
              width={86}
              height={86}
              decoding="async"
              style={{
                display: "block",
                width: 86,
                height: 86,
                objectFit: "contain",
                borderRadius: 999,
                boxShadow: "0 10px 28px rgba(99, 102, 241, 0.2)",
              }}
            />
          </div>
          <h1
            style={{
              margin: 0,
              fontSize: 28,
              fontWeight: 800,
              background: `linear-gradient(135deg, ${C.text} 0%, ${C.accent} 35%, ${C.accent2} 65%, ${C.cyan} 100%)`,
              WebkitBackgroundClip: "text",
              backgroundClip: "text",
              color: "transparent",
            }}
          >
            Assessment: {testData.position}
          </h1>
          <p style={{ margin: "10px 0 0", color: C.muted, fontSize: 15 }}>
            Hello — read everything below before you start.
          </p>
        </div>

        {/* Info grid */}
        <div style={{ ...S.card, marginBottom: 16 }}>
          <h3 style={{ margin: "0 0 1rem", fontSize: 16 }}>Test Information</h3>
          <div style={{ display: "grid", gridTemplateColumns: compact ? "1fr" : "1fr 1fr", gap: 12 }}>
            {[
              { label: "Questions", value: testData.numQuestions },
              { label: "Duration", value: `${testData.duration} minutes` },
              { label: "Format", value: "Multiple Choice" },
              { label: "Session", value: "Online proctored" },
            ].map((f) => (
              <div key={f.label} style={{ background: C.bgMuted, padding: "12px 14px", borderRadius: 10, border: `1px solid ${C.border}` }}>
                <div style={{ fontSize: 11, color: C.muted }}>{f.label}</div>
                <div style={{ fontSize: 15, fontWeight: 600 }}>{f.value}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Rules */}
        <div style={{ ...S.card, marginBottom: 16 }}>
          <h3 style={{ margin: "0 0 1rem", fontSize: 16 }}>⚠️ Important Rules</h3>
          {[
            "Camera must remain ON throughout the test",
            "Switching tabs or minimizing browser will trigger warnings",
            "Exiting fullscreen will be recorded",
            "You will NOT see correct/incorrect feedback during the test",
            "Test auto-submits when time expires",
            "3 or more warnings may flag your attempt for review",
          ].map((r) => (
            <div key={r} style={{ display: "flex", gap: 10, fontSize: 13, padding: "7px 0", borderBottom: `1px solid ${C.border}` }}>
              <span style={{ color: C.warning, flexShrink: 0 }}>⚠</span> {r}
            </div>
          ))}
        </div>

        {/* Camera check */}
        <div style={{ ...S.card, marginBottom: 16 }}>
          <h3 style={{ margin: "0 0 1rem", fontSize: 16 }}>📹 Camera Check</h3>
          {cameraOk ? (
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <video ref={videoRef} autoPlay muted playsInline style={{ width: 120, height: 80, borderRadius: 8, background: C.bgMuted, objectFit: "cover", border: `1px solid ${C.border}` }} />
              <div>
                <div style={{ color: C.success, fontWeight: 600 }}>✓ Camera Active</div>
                <div style={{ fontSize: 13, color: C.muted }}>Your camera is working correctly</div>
              </div>
            </div>
          ) : (
            <button onClick={requestCamera} style={{ ...S.btn("primary"), width: "100%" }}>
              📷 Enable Camera Access
            </button>
          )}
        </div>

        {/* Agreement */}
        <div style={{ ...S.card, marginBottom: 16 }}>
          <label style={{ display: "flex", gap: 12, cursor: "pointer", alignItems: "flex-start" }}>
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)}
              style={{ marginTop: 3, accentColor: C.accent }} />
            <span style={{ fontSize: 14 }}>
              I have read and understood all the rules. I agree to camera monitoring and acknowledge that any attempt to cheat will be recorded.
            </span>
          </label>
        </div>

        <button
          type="button"
          onClick={onStart}
          disabled={!agreed || !cameraOk}
          style={{
            ...S.btn("primary"),
            width: "100%",
            padding: "15px",
            fontSize: 16,
            fontWeight: 700,
            opacity: agreed && cameraOk ? 1 : 0.45,
          }}
        >
          Start assessment →
        </button>
      </div>
    </div>
  );
}

// ─── TEST INTERFACE ────────────────────────────────────────────────────────────
function TestInterface({ testData, user, onComplete }) {
  const { C, S } = useTheme();
  const compact = useResponsive(1024);
  const [questions, setQuestions] = useState([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [answers, setAnswers] = useState([]);
  const [selected, setSelected] = useState(null);
  const [difficulty, setDifficulty] = useState("easy");
  const [timeLeft, setTimeLeft] = useState(testData.duration * 60);
  const [warnings, setWarnings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [streak, setStreak] = useState(0);
  const [submitted, setSubmitted] = useState(false);
  const [questionError, setQuestionError] = useState("");
  const videoRef = useRef(null);
  const cameraStreamRef = useRef(null);
  const submitRef = useRef(false); // prevent double submit
  const answersRef = useRef([]);
  const proctoringShotsRef = useRef([]);
  const liveRef = useRef({ currentIdx: 0, timeLeft: testData.duration * 60, warningCount: 0 });
  const skills = testData.skills?.length ? testData.skills : [testData.position];
  const [proctoringShots, setProctoringShots] = useState([]);
  const [proctoringDebug, setProctoringDebug] = useState({
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: "",
    lastSource: "",
    totalCaptured: 0,
  });
  const [hideStreakForCamera, setHideStreakForCamera] = useState(false);
  const faceModelRef = useRef(null);
  const violationStreakRef = useRef(0);
  const lastWarnedViolationRef = useRef(null);

  const addWarning = useCallback((msg) => {
    const w = { msg, time: new Date().toLocaleTimeString() };
    setWarnings((prev) => [...prev, w]);
    dbSet("warnings", `${user.uid}_${Date.now()}`, {
      candidateId: user.uid,
      testId: testData.testId,
      message: msg,
      timestamp: serverTimestamp(),
    }).catch((err) => console.error("Failed to save warning:", err));
  }, [user.uid, testData.testId]);

  const waitForVideoReady = async (timeoutMs = 5000) => {
    const video = videoRef.current;
    if (!video) return false;
    if (video.videoWidth > 0 && video.videoHeight > 0) return true;

    return await new Promise((resolve) => {
      const onReady = () => {
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          cleanup();
          resolve(true);
        }
      };
      const cleanup = () => {
        clearTimeout(timeoutId);
        video.removeEventListener("loadedmetadata", onReady);
        video.removeEventListener("canplay", onReady);
      };
      const timeoutId = setTimeout(() => {
        cleanup();
        resolve(video.videoWidth > 0 && video.videoHeight > 0);
      }, timeoutMs);

      video.addEventListener("loadedmetadata", onReady);
      video.addEventListener("canplay", onReady);
    });
  };
  const withTimeout = async (promise, ms, label) => {
    let timerId;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timerId = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
        }),
      ]);
    } finally {
      if (timerId) clearTimeout(timerId);
    }
  };

  const capturePreviewImage = async () => {
    try {
      const video = videoRef.current;
      if (video && video.videoWidth > 0 && video.videoHeight > 0) {
        const canvas = document.createElement("canvas");
        canvas.width = 240;
        canvas.height = 135;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/jpeg", 0.45);
      }

      const track = cameraStreamRef.current?.getVideoTracks?.()[0];
      if (track && "ImageCapture" in window) {
        const imageCapture = new window.ImageCapture(track);
        const bitmap = await imageCapture.grabFrame();
        const canvas = document.createElement("canvas");
        canvas.width = 240;
        canvas.height = 135;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/jpeg", 0.45);
      }
    } catch (err) {
      console.error("Preview capture failed:", err);
    }
    return null;
  };

  const captureScreenshotBlob = async () => {
    try {
      const video = videoRef.current;
      const isVideoReady = await waitForVideoReady(10000);

      if (video && isVideoReady && video.videoWidth > 0 && video.videoHeight > 0) {
        const canvas = document.createElement("canvas");
        canvas.width = 960;
        canvas.height = 540;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        return await new Promise((resolve) => {
          canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.8);
        });
      }

      const track = cameraStreamRef.current?.getVideoTracks?.()[0];
      if (track && "ImageCapture" in window) {
        const imageCapture = new window.ImageCapture(track);
        const bitmap = await imageCapture.grabFrame();
        const canvas = document.createElement("canvas");
        canvas.width = 960;
        canvas.height = 540;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        return await new Promise((resolve) => {
          canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.8);
        });
      }

      return null;
    } catch (err) {
      console.error("Screenshot capture failed:", err);
      return null;
    }
  };

  const captureProctoringDataUrlForFirestore = async () => {
    try {
      const video = videoRef.current;
      const ready = await waitForVideoReady(10000);
      if (video && ready && video.videoWidth > 0) {
        return drawSourceToJpegDataUrl(video, 400, 0.38);
      }
      const track = cameraStreamRef.current?.getVideoTracks?.()[0];
      if (track && "ImageCapture" in window) {
        const imageCapture = new window.ImageCapture(track);
        const bitmap = await imageCapture.grabFrame();
        try {
          return drawSourceToJpegDataUrl(bitmap, 400, 0.38);
        } finally {
          bitmap?.close?.();
        }
      }
    } catch (err) {
      console.error("Proctoring data URL capture failed:", err);
    }
    return null;
  };

  const uploadSessionScreenshot = async (reason = "interval") => {
    setProctoringDebug((prev) => ({
      ...prev,
      lastAttemptAt: nowISO(),
      lastError: "",
    }));

    if (!PROCTORING_USE_FIREBASE_STORAGE) {
      try {
        let dataUrl = await captureProctoringDataUrlForFirestore();
        if (!dataUrl) dataUrl = await capturePreviewImage();
        if (!dataUrl) {
          setProctoringDebug((prev) => ({
            ...prev,
            lastError:
              "No camera frame for screenshot (preview black or camera still starting).",
          }));
          return null;
        }
        const capturedAt = nowISO();
        setProctoringDebug((prev) => ({
          ...prev,
          lastSuccessAt: capturedAt,
          lastSource: "firestore-url",
        }));
        return {
          url: dataUrl,
          path: null,
          capturedAt,
          reason,
          source: "firestore-url",
        };
      } catch (err) {
        console.error("Inline proctoring capture failed:", err);
        setProctoringDebug((prev) => ({
          ...prev,
          lastError: err?.message || "Could not capture proctoring image",
        }));
        return null;
      }
    }

    await auth.authStateReady();

    let storageUid = auth.currentUser?.uid;
    if (!storageUid) {
      try {
        const cred = await signInAnonymously(auth);
        storageUid = cred.user.uid;
        await auth.authStateReady();
      } catch (e) {
        console.error("Anonymous auth required for screenshot upload:", e);
        setProctoringDebug((prev) => ({
          ...prev,
          lastError: ANONYMOUS_AUTH_HELP,
        }));
      }
    }
    if (!storageUid) return null;

    try {
      await auth.currentUser?.getIdToken(true);
    } catch {
      /* non-fatal */
    }

    await waitForVideoReady(10000);

    try {
      const blob = await captureScreenshotBlob();
      if (!blob) {
        setProctoringDebug((prev) => ({
          ...prev,
          lastError:
            prev.lastError ||
            "No camera image captured (black preview or camera still starting).",
        }));
        return null;
      }
      const capturedAt = nowISO();
      const safeTestId = String(testData.testId || "test").replace(/[/\\]/g, "_");
      const filePath = `sessionScreenshots/${safeTestId}/${storageUid}/${Date.now()}.jpg`;
      const fileRef = storageRef(storage, filePath);
      await uploadBytes(fileRef, blob, { contentType: "image/jpeg" });
      const url = await getDownloadURL(fileRef);
      setProctoringDebug((prev) => ({
        ...prev,
        lastSuccessAt: capturedAt,
        lastSource: "firebase-storage",
      }));
      return { url, path: filePath, capturedAt, reason };
    } catch (err) {
      console.error("Screenshot upload failed:", err);
      const code = err?.code || "";
      const storageHint =
        code === "storage/unauthorized"
          ? " Storage blocked: run `firebase deploy --only storage` and enable Anonymous auth."
          : code === "storage/unauthenticated"
            ? " Not signed in to Firebase (Anonymous auth)."
            : "";
      const inlineUrl = await capturePreviewImage();
      if (!inlineUrl) {
        setProctoringDebug((prev) => ({
          ...prev,
          lastError: `${err?.message || "Screenshot upload failed"}${storageHint}`,
        }));
        return null;
      }
      const fallbackTime = nowISO();
      setProctoringDebug((prev) => ({
        ...prev,
        lastSuccessAt: fallbackTime,
        lastSource: "inline-fallback",
        lastError: "",
      }));
      console.warn("Proctoring: Storage upload failed, using inline image.", err?.code || err?.message);
      return { url: inlineUrl, path: null, capturedAt: nowISO(), reason, source: "inline-fallback" };
    }
  };

  const uploadScreenshotWithRetry = async (reason, attempts = 5, delayMs = 1500) => {
    for (let i = 0; i < attempts; i += 1) {
      const shot = await uploadSessionScreenshot(reason);
      if (shot) return shot;
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return null;
  };

  const proctoringIntervalMs = Math.max(10000, (testData.proctoringIntervalSec ?? 30) * 1000);

  // Camera
  useEffect(() => {
    if (!navigator.mediaDevices?.getUserMedia) {
      addWarning("Camera API unavailable (use HTTPS or localhost)");
      return undefined;
    }

    let cancelled = false;
    let stream = null;

    (async () => {
      try {
        stream = await getCameraStream();
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        cameraStreamRef.current = stream;
        const v = videoRef.current;
        if (v) {
          await attachCameraStreamToVideo(v, stream);
        } else {
          requestAnimationFrame(async () => {
            if (!cancelled && videoRef.current && cameraStreamRef.current) {
              await attachCameraStreamToVideo(videoRef.current, cameraStreamRef.current);
            }
          });
        }
      } catch (err) {
        console.error("Camera failed:", err);
        addWarning(`Camera error: ${err?.name || err?.message || "access denied"}`);
      }
    })();

    return () => {
      cancelled = true;
      cameraStreamRef.current?.getTracks?.().forEach((t) => t.stop());
      cameraStreamRef.current = null;
    };
  }, [addWarning]);

  // Face count monitoring (BlazeFace): warn + hide streak when not exactly one face (sustained).
  useEffect(() => {
    let cancelled = false;
    let intervalId = null;
    let warmUpTimer = null;

    (async () => {
      try {
        const tf = await import("@tensorflow/tfjs");
        await tf.ready();
        await tf.setBackend("webgl");
        await tf.ready();
        const blazeface = await import("@tensorflow-models/blazeface");
        if (cancelled) return;
        const model = await blazeface.load({
          maxFaces: 8,
          scoreThreshold: 0.55,
        });
        if (cancelled) {
          model.dispose();
          return;
        }
        faceModelRef.current = model;

        const runCheck = async () => {
          if (cancelled || submitRef.current) return;
          const modelInner = faceModelRef.current;
          const video = videoRef.current;
          if (!modelInner || !video || video.readyState < 2 || video.videoWidth < 48) return;

          try {
            const faces = await modelInner.estimateFaces(video, false, true, true);
            const confident = faces.filter((f) => {
              const p = f.probability;
              return typeof p !== "number" || p >= 0.72;
            });
            const n = confident.length;

            if (n === 1) {
              violationStreakRef.current = 0;
              lastWarnedViolationRef.current = null;
              setHideStreakForCamera(false);
              return;
            }

            violationStreakRef.current += 1;
            const status = n === 0 ? "no_face" : "multiple";

            if (violationStreakRef.current >= 2) {
              setHideStreakForCamera(true);
              if (lastWarnedViolationRef.current !== status) {
                addWarning(
                  status === "no_face"
                    ? "No face visible in camera — stay centered alone in frame."
                    : "Multiple faces detected — only you may be visible on camera.",
                );
                lastWarnedViolationRef.current = status;
              }
            }
          } catch (e) {
            console.warn("Face check failed:", e);
          }
        };

        warmUpTimer = window.setTimeout(() => {
          intervalId = window.setInterval(runCheck, 3200);
          runCheck();
        }, 6500);
      } catch (e) {
        console.warn("Face monitoring unavailable:", e);
      }
    })();

    return () => {
      cancelled = true;
      if (warmUpTimer != null) window.clearTimeout(warmUpTimer);
      if (intervalId != null) window.clearInterval(intervalId);
      violationStreakRef.current = 0;
      lastWarnedViolationRef.current = null;
      setHideStreakForCamera(false);
      try {
        faceModelRef.current?.dispose?.();
      } catch {
        /* noop */
      }
      faceModelRef.current = null;
    };
  }, [addWarning]);

  // Countdown timer
  useEffect(() => {
    const t = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) { clearInterval(t); doSubmit(answersRef.current); return 0; }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // Tab-switch detection
  useEffect(() => {
    const handler = () => { if (document.hidden) addWarning("Tab switch detected"); };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [addWarning]);

  // Keep latest values for stable live-session interval
  useEffect(() => {
    liveRef.current = {
      currentIdx,
      timeLeft,
      warningCount: warnings.length,
    };
  }, [currentIdx, timeLeft, warnings.length]);

  useEffect(() => {
    answersRef.current = answers;
  }, [answers]);

  useEffect(() => {
    proctoringShotsRef.current = proctoringShots;
    setProctoringDebug((prev) => ({
      ...prev,
      totalCaptured: proctoringShots.length,
    }));
  }, [proctoringShots]);

  // Live session updates to Firestore every 5 seconds
  useEffect(() => {
    const pushLiveSession = async () => {
      const { currentIdx: idx, timeLeft: remaining, warningCount } = liveRef.current;
      const previewImage = await capturePreviewImage();
      dbSet("liveSessions", user.uid, {
        candidateId: user.uid,
        name: user.name,
        position: testData.position,
        numQuestions: testData.numQuestions,
        currentQuestion: idx,
        timeLeft: remaining,
        warningCount,
        previewImage,
        status: "active",
        lastSeen: serverTimestamp(),
      }).catch((err) => console.error("Failed to update live session:", err));
    };

    // Push immediately so admin can see candidate quickly.
    pushLiveSession();

    const interval = setInterval(() => {
      pushLiveSession();
    }, 5000);
    return () => clearInterval(interval);
  }, [user.uid, user.name, testData.position, testData.numQuestions]);

  useEffect(() => {
    let intervalId;
    const captureAndStoreShot = async (reason) => {
      if (submitRef.current) return;
      const shot = await uploadScreenshotWithRetry(reason);
      if (!shot) return;
      setProctoringShots((prev) => {
        let next = [...prev, shot];
        if (!PROCTORING_USE_FIREBASE_STORAGE && next.length > MAX_INLINE_PROCTORING_SHOTS) {
          next = next.slice(-MAX_INLINE_PROCTORING_SHOTS);
        }
        proctoringShotsRef.current = next;
        return next;
      });
    };

    // First full screenshot after the configured interval (default 30s) so the camera has frames.
    const firstTimer = setTimeout(() => {
      captureAndStoreShot("interval");
      intervalId = setInterval(() => {
        if (submitRef.current) return;
        captureAndStoreShot("interval");
      }, proctoringIntervalMs);
    }, proctoringIntervalMs);

    return () => {
      clearTimeout(firstTimer);
      if (intervalId) clearInterval(intervalId);
    };
  }, [user.uid, testData.testId, proctoringIntervalMs]);

  // Load first question on mount
  useEffect(() => { loadNextQuestion("easy"); }, []);

  const loadNextQuestion = async (diff) => {
    setLoading(true);
    setSelected(null);
    setQuestionError("");
    try {
      const q = await generateQuestion(testData.position, diff, skills, questions);
      const hasValidShape =
        q &&
        typeof q.question === "string" &&
        Array.isArray(q.options) &&
        q.options.length > 1 &&
        Number.isInteger(q.correctIndex);

      if (!hasValidShape) {
        throw new Error("Invalid question payload from AI service");
      }

      setQuestions((prev) => [...prev, { ...q, difficulty: diff }]);
    } catch (err) {
      console.error("Question generation failed:", err);
      setQuestionError("Unable to generate the next question. Please check your API key/config and retry.");
    } finally {
      setLoading(false);
    }
  };

  const handleAnswer = async (optionIdx) => {
    if (selected !== null || loading) return;
    if (!questions[currentIdx]) return;
    setSelected(optionIdx);

    const q = questions[currentIdx];
    const correct = optionIdx === q.correctIndex;
    const newAns = [
      ...answers,
      {
        questionIndex: currentIdx,
        question: q.question,
        selected: optionIdx,
        selectedOption: q.options?.[optionIdx] ?? "Not answered",
        correctOptionIndex: q.correctIndex,
        correctOption: q.options?.[q.correctIndex] ?? "N/A",
        options: q.options || [],
        correct,
        difficulty: q.difficulty,
      },
    ];
    setAnswers(newAns);
    answersRef.current = newAns;

    // Adaptive difficulty
    const newStreak = correct ? streak + 1 : 0;
    setStreak(newStreak);
    let nextDiff = difficulty;
    if (correct && newStreak >= 3)
      nextDiff = difficulty === "easy" ? "medium" : difficulty === "medium" ? "hard" : "hard";
    else if (!correct)
      nextDiff = difficulty === "hard" ? "medium" : "easy";
    setDifficulty(nextDiff);

    setTimeout(async () => {
      if (currentIdx + 1 >= testData.numQuestions) {
        doSubmit(newAns);
      } else {
        setCurrentIdx((i) => i + 1);
        await loadNextQuestion(nextDiff);
      }
    }, 1500);
  };

  const doSubmit = async (finalAnswers) => {
    if (submitRef.current) return;
    submitRef.current = true;
    setSubmitted(true);
    try {
      const answersToSave = Array.isArray(finalAnswers) ? finalAnswers : answersRef.current;
      const finalShot = await withTimeout(
        uploadSessionScreenshot("submit"),
        25000,
        "Final screenshot capture"
      ).catch((err) => {
        console.error("Final screenshot skipped:", err);
        return null;
      });
      let combinedShots = [
        ...proctoringShotsRef.current,
        ...(finalShot ? [finalShot] : []),
      ];
      if (!PROCTORING_USE_FIREBASE_STORAGE && combinedShots.length > MAX_INLINE_PROCTORING_SHOTS) {
        combinedShots = combinedShots.slice(-MAX_INLINE_PROCTORING_SHOTS);
      }
      if (combinedShots.length === 0) {
        const inlineOnly = await capturePreviewImage();
        if (inlineOnly) {
          combinedShots = [
            {
              url: inlineOnly,
              path: null,
              capturedAt: nowISO(),
              reason: "submit-inline-only",
              source: "inline-only",
            },
          ];
        }
      }

      const correct = answersToSave.filter((a) => a.correct).length;
      const score = Math.round((correct / testData.numQuestions) * 100);
      const questionsAsked = questions.map((item, idx) => ({
        questionIndex: idx,
        question: item.question,
        options: item.options || [],
        correctOptionIndex: item.correctIndex,
        correctOption: item.options?.[item.correctIndex] ?? "N/A",
        difficulty: item.difficulty,
      }));
      const result = {
        candidateId: user.uid,
        candidateName: user.name,
        testId: testData.testId,
        position: testData.position,
        score,
        correct,
        total: testData.numQuestions,
        warnings: warnings.length,
        warningLog: warnings.map((w) => ({ msg: w.msg, time: w.time })),
        timeTaken: `${Math.floor((testData.duration * 60 - timeLeft) / 60)}m`,
        submittedAt: nowISO(),
        answers: answersToSave,
        questionsAsked,
        proctoringScreenshots: combinedShots,
      };
      // Unique doc per attempt. Payload omits questionsAsked (duplicate of answers) to stay under 1 MiB.
      const resultForFirestore = trimResultForFirestoreSize({
        candidateId: result.candidateId,
        candidateName: result.candidateName,
        testId: result.testId,
        position: result.position,
        score: result.score,
        correct: result.correct,
        total: result.total,
        warnings: result.warnings,
        warningLog: result.warningLog,
        timeTaken: result.timeTaken,
        submittedAt: result.submittedAt,
        answers: result.answers,
        proctoringScreenshots: result.proctoringScreenshots,
      });
      const resultDocId = `${user.uid}_r_${Date.now()}`;
      await withTimeout(dbSet("results", resultDocId, resultForFirestore), 20000, "Result save");
      // Keep session visible on Live Monitor with a "finished" state (used to delete the doc here).
      const finalPreview = await capturePreviewImage().catch(() => null);
      await withTimeout(
        dbSet("liveSessions", user.uid, {
          candidateId: user.uid,
          name: user.name,
          position: testData.position,
          numQuestions: testData.numQuestions,
          currentQuestion: testData.numQuestions - 1,
          timeLeft: 0,
          warningCount: warnings.length,
          previewImage: finalPreview,
          status: "completed",
          score: result.score,
          resultDocId,
          completedAt: serverTimestamp(),
          lastSeen: serverTimestamp(),
        }),
        10000,
        "Live session completed update",
      ).catch((err) => console.error("Failed to mark live session completed:", err));
      onComplete(result);
    } catch (err) {
      console.error("Submit failed:", err);
      const hint = err?.code || err?.message || String(err);
      alert(
        `Submission failed: ${hint}\n\n` +
        "If this says permission-denied, deploy updated Firestore rules. " +
        "If the document is too large, try fewer questions or set VITE_PROCTORING_STORAGE=storage.",
      );
      submitRef.current = false;
      setSubmitted(false);
    }
  };

  const fmt = (s) =>
    `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  const progress = (currentIdx / testData.numQuestions) * 100;
  const q = questions[currentIdx];

  if (submitted) return (
    <div style={S.app}>
      <Spinner />
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: compact ? "column" : "row", minHeight: "100vh", ...S.app }}>
      <LoginThemeToolbar />

      {/* ── Question area ── */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          padding: compact ? "1rem clamp(0.75rem, 3vw, 1.25rem)" : "2rem 2.25rem",
          maxWidth: compact ? "100%" : 760,
        }}
      >
        {/* Header row */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1.5rem", gap: 12, flexWrap: compact ? "wrap" : undefined }}>
          <div>
            <div style={{ fontSize: 13, color: C.muted, fontWeight: 600, letterSpacing: "0.02em" }}>
              Question {Math.min(currentIdx + 1, testData.numQuestions)} of {testData.numQuestions}
            </div>
            {warnings.length > 0 && (
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <Tag color="danger">⚠ {warnings.length} warning{warnings.length > 1 ? "s" : ""}</Tag>
              </div>
            )}
          </div>
          <div
            style={{
              textAlign: "center",
              padding: "12px 20px",
              borderRadius: 14,
              background: `linear-gradient(165deg, ${C.surface}, ${C.bgMuted})`,
              border: `1px solid ${C.border}`,
              boxShadow:
                "0 8px 26px rgba(99, 102, 241, 0.16), 0 0 0 1px rgba(236, 72, 153, 0.14), 0 0 24px rgba(6, 182, 212, 0.14)",
              minWidth: 112,
            }}
          >
            <div
              style={{
                fontSize: 26,
                fontWeight: 700,
                fontFamily: "ui-monospace, monospace",
                letterSpacing: "0.06em",
                color: timeLeft < 60 ? C.danger : timeLeft < 300 ? C.warning : C.text,
              }}
            >
              {fmt(timeLeft)}
            </div>
            <div style={{ fontSize: 11, color: C.muted, marginTop: 4, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>
              remaining
            </div>
          </div>
        </div>

        {/* Progress bar */}
        <div
          style={{
            background: C.bgMuted,
            borderRadius: 999,
            height: 9,
            overflow: "hidden",
            border: `1px solid ${C.border}`,
            marginBottom: "2rem",
          }}
        >
          <div
            style={{
              width: `${progress}%`,
              height: "100%",
              background: `linear-gradient(90deg, ${C.accent}, ${C.cyan}, ${C.accent3}, ${C.purple})`,
              borderRadius: 999,
              transition: "width 0.5s ease",
              boxShadow: `0 0 20px rgba(236, 72, 153, 0.35), 0 0 14px rgba(6, 182, 212, 0.25)`,
            }}
          />
        </div>

        {/* Question / options */}
        {loading || !q ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", flex: 1 }}>
            <Spinner />
            <div style={{ color: C.muted, fontSize: 14, marginTop: 8 }}>
              {questionError || "Generating next question..."}
            </div>
            {questionError && (
              <button
                onClick={() => loadNextQuestion(difficulty)}
                style={{ ...S.btn("ghost", "sm"), marginTop: 12 }}
              >
                Retry
              </button>
            )}
          </div>
        ) : (
          <div style={{ flex: 1 }}>
            <div style={{ ...S.card, marginBottom: "1.5rem" }}>
              <div style={{ fontSize: 11, color: C.muted, marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                Topic: {q.topic}
              </div>
              <div style={{ fontSize: 17, lineHeight: 1.6, fontWeight: 500 }}>{stripDifficultyFromQuestionText(q.question)}</div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {q.options.map((opt, i) => {
                const isSel = selected === i;
                return (
                  <button
                    key={i}
                    onClick={() => handleAnswer(i)}
                    disabled={selected !== null}
                    style={{
                      ...S.card,
                      padding: "14px 18px",
                      cursor: selected !== null ? "default" : "pointer",
                      textAlign: "left",
                      display: "flex", alignItems: "center", gap: 12,
                      border: `1px solid ${isSel ? C.accent : C.border}`,
                      background: isSel ? C.accentDim : C.surface,
                      transition: "all 0.2s",
                      fontSize: 14,
                    }}
                  >
                    <div style={{
                      width: 28, height: 28, borderRadius: "50%", flexShrink: 0,
                      border: `2px solid ${isSel ? C.accent : C.border}`,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 12, fontWeight: 700,
                      color: isSel ? C.accent : C.muted,
                    }}>
                      {"ABCD"[i]}
                    </div>
                    {opt}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* ── Proctor sidebar ── */}
      <div
        style={{
          width: compact ? "100%" : 268,
          maxWidth: "100%",
          background: `linear-gradient(180deg, ${C.surface} 0%, ${C.bgMuted} 100%)`,
          borderLeft: compact ? "none" : `1px solid ${C.border}`,
          borderTop: compact ? `1px solid ${C.border}` : "none",
          boxShadow: compact ? "none" : "-4px 0 28px rgba(15, 23, 42, 0.06)",
          padding: compact ? "1rem clamp(0.75rem, 3vw, 1.25rem)" : "1.5rem",
          display: "flex",
          flexDirection: "column",
          gap: 18,
          position: compact ? "relative" : "sticky",
          top: compact ? undefined : 0,
          alignSelf: compact ? "stretch" : undefined,
          height: compact ? "auto" : "100vh",
          overflowY: "auto",
          flexShrink: 0,
        }}
      >
        {/* Camera feed */}
        <div>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>📹 Camera</div>
          <div style={{ width: "100%", aspectRatio: "4/3", background: C.bgMuted, borderRadius: 12, overflow: "hidden", border: `1px solid ${C.border}` }}>
            <video ref={videoRef} autoPlay muted playsInline style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          </div>
        </div>

        {/* Stats */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {[
            { label: "Completed", value: `${currentIdx}/${testData.numQuestions}` },
            {
              label: "Streak",
              value: hideStreakForCamera ? "—" : `${streak} correct`,
              sub: hideStreakForCamera ? "Hidden when camera rules aren’t met" : null,
            },
          ].map((s) => (
            <div key={s.label} style={{
              background: C.bgMuted, padding: "8px 10px", borderRadius: 8,
              display: "flex", flexDirection: "column", gap: 2, fontSize: 13,
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ color: C.muted }}>{s.label}</span>
                <span style={{ fontWeight: 600, color: s.color || C.text }}>{s.value}</span>
              </div>
              {s.sub ? (
                <span style={{ fontSize: 11, color: C.muted, lineHeight: 1.35 }}>{s.sub}</span>
              ) : null}
            </div>
          ))}
        </div>

        {/* Warnings */}
        {warnings.length > 0 && (
          <div>
            <div style={{ fontSize: 12, color: C.danger, marginBottom: 8 }}>⚠ Warnings ({warnings.length})</div>
            <div style={{ maxHeight: 220, overflowY: "auto" }}>
              {warnings.slice(-12).map((w, i) => (
                <div key={i} style={{ background: "rgba(220, 38, 38, 0.06)", padding: "8px 10px", borderRadius: 8, fontSize: 11, marginBottom: 6, border: "1px solid rgba(220, 38, 38, 0.18)" }}>
                  <div style={{ color: C.danger }}>{w.msg}</div>
                  <div style={{ color: C.muted }}>{w.time}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Proctoring debug */}
        <div style={{ background: C.bg, borderRadius: 8, padding: "10px 12px" }}>
          <div style={{ fontSize: 12, color: C.accent, marginBottom: 8 }}>🛠 Proctoring Status</div>
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>
            Captures: {proctoringDebug.totalCaptured}
          </div>
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>
            Last Attempt: {proctoringDebug.lastAttemptAt ? new Date(proctoringDebug.lastAttemptAt).toLocaleTimeString() : "—"}
          </div>
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>
            Last Success: {proctoringDebug.lastSuccessAt ? new Date(proctoringDebug.lastSuccessAt).toLocaleTimeString() : "—"}
          </div>
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>
            Source: {proctoringDebug.lastSource || "—"}
          </div>
          {proctoringDebug.lastError && (
            <div style={{ fontSize: 11, color: C.danger, whiteSpace: "pre-line", lineHeight: 1.5, marginTop: 8 }}>
              {proctoringDebug.lastError}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => {
            if (window.confirm("Submit the test now?")) doSubmit(answersRef.current);
          }}
          style={{ ...S.btn("danger", "sm"), marginTop: "auto", width: "100%" }}
        >
          Submit early
        </button>
      </div>
    </div>
  );
}

// ─── COMPLETION SCREEN ────────────────────────────────────────────────────────
function CompletionScreen({ result }) {
  const { C, S } = useTheme();
  return (
    <div className="ha-shell" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: "clamp(1rem, 4vw, 2rem)", ...S.app }}>
      <LoginThemeToolbar />
      <div style={{ maxWidth: 560, width: "100%", textAlign: "center" }}>
        <div
          style={{
            width: 88,
            height: 88,
            margin: "0 auto 1.25rem",
            borderRadius: "50%",
            background: "rgba(5, 150, 105, 0.1)",
            border: `2px solid rgba(5, 150, 105, 0.28)`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 42,
          }}
        >
          ✓
        </div>
        <h1 style={{ fontSize: 30, fontWeight: 700, marginBottom: "0.5rem" }}>Test submitted</h1>
        <p style={{ color: C.muted, marginBottom: "2rem", fontSize: 15, lineHeight: 1.55 }}>
          Thank you, {result.candidateName}. Your responses are recorded.
        </p>

        <div style={{ ...S.card, marginBottom: 16, textAlign: "left" }}>
          <div style={{ fontSize: 15, color: C.text, marginBottom: 10, lineHeight: 1.55 }}>
            Your recruiter will review your assessment and follow up with next steps.
          </div>
          <div style={{ fontSize: 12, color: C.muted }}>
            Submitted: {result.submittedAt ? new Date(result.submittedAt).toLocaleString() : "—"}
          </div>
        </div>

        <div style={{ ...S.card, background: "rgba(5, 150, 105, 0.06)", border: `1px solid rgba(5, 150, 105, 0.22)`, textAlign: "left" }}>
          <div style={{ fontSize: 14, color: C.success, lineHeight: 1.55 }}>
            Thanks for your time — best of luck with your application.
          </div>
        </div>

        <p style={{ color: C.muted, fontSize: 13, marginTop: "1.75rem" }}>
          You can close this window.
        </p>
      </div>
    </div>
  );
}

// ─── ROOT ─────────────────────────────────────────────────────────────────────
export default function App() {
  return (
    <ThemeProvider>
      <AppShell />
    </ThemeProvider>
  );
}

function AppShell() {
  const { user, signOut } = useAuth();

  // Detect candidate link params
  const params = new URLSearchParams(window.location.search);
  const defaultRole = params.get("test") ? "candidate" : "admin";

  if (!user) {
    return <LoginScreen onLogin={() => window.location.reload()} defaultRole={defaultRole} />;
  }

  if (user.role === "admin") return <AdminPanel user={user} onSignOut={signOut} />;
  if (user.role === "candidate") return <CandidatePanel user={user} onSignOut={signOut} />;

  return <LoginScreen onLogin={() => window.location.reload()} />;
}
