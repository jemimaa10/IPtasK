import { GEMINI_API_KEY, GEMINI_MODELS } from './config.js';

export const aiEnabled = () => Boolean(GEMINI_API_KEY);

// Overloaded (503), rate-limited (429), retired (404) or slow models are skipped for the next one in the list.
const RETRYABLE = new Set([404, 429, 500, 503]);

async function callModel(model, parts, { json, temperature, timeoutMs }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature,
        ...(json ? { responseMimeType: 'application/json' } : {}),
      },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(`Gemini ${model} failed (${res.status}): ${detail.slice(0, 200)}`);
    err.retryable = RETRYABLE.has(res.status);
    throw err;
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  if (!text) throw Object.assign(new Error(`Gemini ${model} returned an empty response.`), { retryable: true });
  return json ? JSON.parse(text) : text.trim();
}

async function generate(parts, { json = false, temperature = 0.7, timeoutMs = 30_000 } = {}) {
  if (!aiEnabled()) throw new Error('Gemini API key is not configured.');
  let lastError;
  for (const model of GEMINI_MODELS) {
    try {
      return await callModel(model, parts, { json, temperature, timeoutMs });
    } catch (err) {
      lastError = err;
      const retryable = err.retryable || err.name === 'TimeoutError' || err instanceof SyntaxError;
      console.warn(`[gemini] ${model}: ${err.name === 'TimeoutError' ? 'timed out' : err.message}`);
      if (!retryable) break;
    }
  }
  throw lastError;
}

/**
 * Suggest a fair split of a group project into one or more missions per member.
 * Returns [{ assigneeId, title, description, deadline (ISO) }].
 */
export async function splitJobdesk({ groupName, brief, members, startDate, endDate }) {
  const memberList = members.map((m) => `- id ${m.id}: ${m.displayName} (@${m.username})`).join('\n');
  const prompt = `You are the planning assistant of IPtasK, a group study planner for university students.
Split the following group project into concrete, verifiable jobdesks (missions) and distribute them FAIRLY
so every member (including the leader) gets a comparable workload.

Group: ${groupName}
Project brief:
"""${brief}"""

Members:
${memberList}

Work window: from ${startDate} to ${endDate} (ISO dates, local time).

Rules:
- Every member must receive at least one mission.
- Each mission must produce something that can be proven with a screenshot or file (so teammates can verify it).
- Stagger deadlines sensibly inside the work window; dependent tasks come later.
- Write titles under 70 characters, descriptions under 220 characters, in the same language as the brief.
- Deadlines are ISO 8601 local datetimes like 2026-11-03T21:00.

Respond with JSON only, shaped as:
{"missions":[{"assigneeId":number,"title":string,"description":string,"deadline":string}],"note":string}
"note" is one short sentence explaining why the split is fair.`;

  const result = await generate([{ text: prompt }], { json: true, temperature: 0.5 });
  const validIds = new Set(members.map((m) => m.id));
  const missions = (result.missions || [])
    .filter((m) => validIds.has(Number(m.assigneeId)) && m.title && m.deadline)
    .map((m) => ({
      assigneeId: Number(m.assigneeId),
      title: String(m.title).slice(0, 120),
      description: String(m.description || '').slice(0, 500),
      deadline: String(m.deadline),
    }));
  return { missions, note: String(result.note || '') };
}

const FALLBACK_ROASTS = {
  missed_deadline: [
    'The deadline came. The work did not.',
    'Plot twist: the task is still waiting.',
    'Group chat remembers. Group chat always remembers.',
    'Somewhere, a jobdesk is crying.',
  ],
  unchecked: [
    'Being a teammate is more than just being in the group.',
    'One click. That was all it took.',
    'The "Checked" button was right there.',
  ],
  unverified: [
    'Work in progress, verification in absence.',
    'Almost there is not there.',
    'So close, yet so unverified.',
  ],
};

/** One short, playful (never cruel) line for the confession card. */
export async function roastLine({ kind, displayName, missionTitle }) {
  const fallback = () => {
    const list = FALLBACK_ROASTS[kind] || FALLBACK_ROASTS.missed_deadline;
    return list[Math.floor(Math.random() * list.length)];
  };
  if (!aiEnabled()) return fallback();
  const situation = {
    missed_deadline: `${displayName} did not upload proof for the task "${missionTitle}" before the deadline.`,
    unchecked: `${displayName} did not check a teammate's work on "${missionTitle}" before the verification window closed.`,
    unverified: `${displayName}'s work on "${missionTitle}" was not fully verified (revision not fixed or not reviewed) in time.`,
  }[kind];
  try {
    const text = await generate(
      [{ text: `Write ONE short, witty, light-hearted caption (max 14 words) for a friendly "wall of shame" post in a student study group app. Situation: ${situation} It must be playful peer pressure, never insulting, no hashtags, no emojis, no quotation marks. Reply with the caption only.` }],
      { temperature: 1, timeoutMs: 15_000 }
    );
    return text.replace(/^["'“]+|["'”]+$/g, '').slice(0, 140) || fallback();
  } catch {
    return fallback();
  }
}

/**
 * Give verifiers a quick, non-binding hint about whether uploaded screenshots relate to the mission.
 */
export async function precheckProof({ missionTitle, missionDescription, caption, images }) {
  if (!aiEnabled() || images.length === 0) return null;
  const parts = [
    {
      text: `You help students verify each other's work in a study group app. The task is:
Title: ${missionTitle}
Description: ${missionDescription || '-'}
Uploader caption: ${caption || '-'}

Look at the attached proof image(s). In at most 2 short sentences, say whether they look like genuine progress on this task and what they show.
Start with exactly one of: "Looks relevant:", "Partly relevant:", "Doubtful:". This is only a hint for human reviewers.`,
    },
    ...images.map((img) => ({ inline_data: { mime_type: img.mime, data: img.base64 } })),
  ];
  try {
    return (await generate(parts, { temperature: 0.2 })).slice(0, 400);
  } catch {
    return null;
  }
}
