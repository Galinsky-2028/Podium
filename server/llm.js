import Anthropic from '@anthropic-ai/sdk';
import { LOOKS } from '../shared/luts.js';

function client(s) {
  return new Anthropic({ apiKey: s.anthropicKey });
}

// One structured-output call to Claude. Streams (long documents in, long speech out),
// with server-side refusal fallbacks enabled.
async function callJSON(s, { system, content, schema, effort = 'high', maxTokens = 32000 }) {
  const stream = client(s).beta.messages.stream({
    model: s.claudeModel || 'claude-opus-5-5',
    max_tokens: maxTokens,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system,
    messages: [{ role: 'user', content }],
    output_config: { effort, format: { type: 'json_schema', schema } },
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') {
    throw new Error(`Claude declined this request${msg.stop_details?.explanation ? `: ${msg.stop_details.explanation}` : ''}`);
  }
  if (msg.stop_reason === 'max_tokens') throw new Error('Claude ran out of output tokens; try a shorter target length.');
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Could not parse Claude output: ${text.slice(0, 200)}`);
  }
}

const candidateLine = (s) =>
  s.candidateName
    ? `The candidate is ${s.candidateName}${s.candidateTitle ? `, ${s.candidateTitle}` : ''}.`
    : 'You are writing for the candidate (Galinsky 2028 campaign).';

function filesBlock(files) {
  if (!files?.length) return '';
  return files
    .map((f) => `<source_document name="${f.name.replace(/"/g, '')}">\n${f.text || '(no extractable text)'}\n</source_document>`)
    .join('\n\n');
}

// ---------------- Speech ----------------
const SPEECH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'speech', 'notes'],
  properties: {
    title: { type: 'string', description: 'Short working title for the video' },
    speech: { type: 'string', description: 'Full speech text exactly as it will be spoken. Paragraphs separated by blank lines. No stage directions.' },
    notes: { type: 'string', description: 'One or two sentences on the approach taken' },
  },
};

export async function writeSpeech(s, { brief, files, lengthMinutes, tone, audience, revision, previous }) {
  if (!s.anthropicKey) return mockSpeech({ brief, files, lengthMinutes });
  const words = Math.round((lengthMinutes || 2) * 150);
  const system = `You are the lead speechwriter for a US presidential campaign, writing speeches the candidate delivers straight to camera for campaign videos. ${candidateLine(s)}
Voice and style: ${s.voiceNotes}
Rules:
- Write words meant to be spoken by the candidate on camera, in first person. No stage directions, headings, bracketed notes, or emoji.
- Target about ${words} words (~${lengthMinutes || 2} minutes at 150 wpm).
- When source documents (bills, policy papers) are provided, be accurate to them: cite specifics (what the bill does, who it helps, numbers) and never invent provisions. If something is unclear, stay general rather than fabricate.
- Open with a hook in the first two sentences, build to the substance, end with a clear call to action.`;
  const parts = [`<brief>\n${brief || '(none)'}\n</brief>`];
  if (tone) parts.push(`Tone: ${tone}`);
  if (audience) parts.push(`Audience: ${audience}`);
  const fb = filesBlock(files);
  if (fb) parts.push(fb);
  if (previous && revision) parts.push(`<previous_draft>\n${previous}\n</previous_draft>\n<revision_request>\n${revision}\n</revision_request>\nRevise the previous draft according to the request.`);
  else parts.push('Write the speech.');
  return callJSON(s, { system, content: parts.join('\n\n'), schema: SPEECH_SCHEMA, effort: 'high' });
}

// ---------------- Shot list ----------------
const SHOT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['segments', 'broll', 'grade'],
  properties: {
    segments: {
      type: 'array',
      description: 'A-roll: the candidate on camera. Together the segment texts must reproduce the whole speech verbatim, in order.',
      items: {
        type: 'object', additionalProperties: false,
        required: ['text', 'look', 'transition', 'description'],
        properties: {
          text: { type: 'string' },
          look: { type: 'string', description: 'Key of the avatar look/framing to use' },
          transition: { type: 'string', enum: ['cut', 'dip'], description: 'How this segment starts. dip = brief dip to black, use for major section changes only' },
          description: { type: 'string', description: 'Short shot description, e.g. "Medium close-up, direct to camera"' },
        },
      },
    },
    broll: {
      type: 'array',
      description: 'Cutaways that play over the narration (candidate audio continues underneath).',
      items: {
        type: 'object', additionalProperties: false,
        required: ['segment', 'offset', 'duration', 'description', 'prompt'],
        properties: {
          segment: { type: 'integer', description: 'Index of the A-roll segment this cutaway plays over (0-based)' },
          offset: { type: 'number', description: 'Seconds after that segment starts' },
          duration: { type: 'number', description: 'Seconds on screen, 3-8' },
          description: { type: 'string', description: 'What the viewer sees, one line' },
          prompt: { type: 'string', description: 'Detailed text-to-video prompt: subject, action, setting, camera movement, lighting. No text/logos, no real identifiable people.' },
        },
      },
    },
    grade: {
      type: 'object', additionalProperties: false, required: ['look', 'reason'],
      properties: { look: { type: 'string', enum: LOOKS.map((l) => l.id) }, reason: { type: 'string' } },
    },
  },
};

export async function planShots(s, { speech, brief, brollShare = 35 }) {
  const looks = (s.heygen.looks || []).filter((l) => l.key);
  const lookList = looks.length
    ? looks.map((l) => `- ${l.key}: ${l.label}${l.description ? ` (${l.description})` : ''}`).join('\n')
    : '- main: the candidate, medium shot, direct to camera';
  if (!s.anthropicKey) return mockShots({ speech, looks: looks.length ? looks : [{ key: 'main' }] });
  const system = `You are a campaign video director and editor. You turn a finished speech into a shot list for an automated pipeline:
- A-roll segments of the candidate speaking to camera are generated with an AI avatar (HeyGen). Each segment is rendered separately, so split the speech at natural sentence boundaries into segments of roughly 1-3 sentences (about 6-20 seconds each). The concatenated segment texts must equal the speech word for word.
- Vary the framing between consecutive segments using the available looks, like a real multi-camera edit, but don't change look every segment for no reason.
- B-roll cutaways are generated by a text-to-video model (Grok Imagine) and overlaid on top of the candidate while the candidate's voice continues. They should illustrate what is being said at that moment (people, places, situations the speech describes). Aim for about ${brollShare}% of runtime covered by b-roll. Never cover the first 4 seconds of the video or the final call to action. Keep each within its segment: offset + duration must be less than the segment's spoken length (estimate 2.5 words per second).
- Video prompts must be concrete and visual, avoid on-screen text, logos, flags with text, and real identifiable public figures.
- Choose one overall color grade (LUT) that fits the tone.
Available A-roll looks:
${lookList}
Available grades: ${LOOKS.map((l) => `${l.id} (${l.name})`).join(', ')}`;
  const content = `${brief ? `<brief>\n${brief}\n</brief>\n\n` : ''}<speech>\n${speech}\n</speech>\n\nProduce the shot list.`;
  const out = await callJSON(s, { system, content, schema: SHOT_SCHEMA, effort: 'high' });
  const keys = new Set(looks.map((l) => l.key));
  for (const seg of out.segments) if (!keys.has(seg.look)) seg.look = looks[0]?.key || 'main';
  return out;
}

// ---------------- Revise a single shot from feedback ----------------
const REVISE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['prompt', 'text', 'look', 'description', 'duration', 'explanation'],
  properties: {
    prompt: { type: 'string', description: 'B-roll: the new text-to-video prompt. A-roll: empty string.' },
    text: { type: 'string', description: 'A-roll: the words to speak (unchanged unless the feedback asks to change wording). B-roll: empty string.' },
    look: { type: 'string', description: 'A-roll: look key to use. B-roll: empty string.' },
    description: { type: 'string' },
    duration: { type: 'number', description: 'B-roll: desired seconds on screen. A-roll: 0.' },
    explanation: { type: 'string', description: 'One sentence describing what changed' },
  },
};

export async function reviseShot(s, { shot, feedback, context }) {
  const looks = (s.heygen.looks || []).filter((l) => l.key);
  if (!s.anthropicKey) {
    return shot.type === 'broll'
      ? { prompt: `${shot.prompt} — revised: ${feedback}`, text: '', look: '', description: feedback.slice(0, 80), duration: shot.duration, explanation: 'Demo mode: appended your feedback to the prompt.' }
      : { prompt: '', text: shot.text, look: shot.look, description: shot.description, duration: 0, explanation: 'Demo mode: regenerating the same line.' };
  }
  const system = `You are the editor of a campaign video. The user is reviewing one clip and says what's wrong with it. Rewrite that shot's generation inputs so the regenerated clip fixes the problem.
- B-roll: write a new, concrete text-to-video prompt (Grok Imagine). If the user asks for something different altogether, replace it. Keep it illustrating the narration at that point. No on-screen text, logos, or real identifiable people.
- A-roll (candidate speaking via HeyGen avatar): keep the spoken text exactly the same unless the user explicitly asks to change the wording. You may switch look/framing if the feedback is about framing. Available looks: ${looks.map((l) => `${l.key} (${l.label})`).join(', ') || 'main'}.`;
  const content = `<shot type="${shot.type}">
${shot.type === 'broll' ? `<prompt>${shot.prompt}</prompt>\n<on_screen_seconds>${shot.duration}</on_screen_seconds>` : `<spoken_text>${shot.text}</spoken_text>\n<look>${shot.look}</look>`}
<description>${shot.description || ''}</description>
</shot>
<narration_at_this_point>${context || ''}</narration_at_this_point>
<user_feedback>${feedback}</user_feedback>`;
  return callJSON(s, { system, content, schema: REVISE_SCHEMA, effort: 'medium', maxTokens: 8000 });
}

// ---------------- Demo-mode fallbacks (no Anthropic key yet) ----------------
function mockSpeech({ brief, files, lengthMinutes }) {
  const topic = (brief || 'the future of our country').split(/[.\n]/)[0].slice(0, 120);
  const fileLine = files?.length ? ` I've read ${files.map((f) => f.name).join(', ')}, and here is what it means for you.` : '';
  const paras = [
    `My fellow Americans, let's talk about ${topic}.${fileLine}`,
    `For too long, Washington has treated this as someone else's problem. Families feel it at the kitchen table, workers feel it on the job, and young people feel it when they look at their future.`,
    `Here is what I will do. First, we will make the rules simple and fair, so that everyone plays by the same ones. Second, we will put real accountability in place, with results you can see. Third, we will measure success by whether your life gets better, not by press releases.`,
    `This isn't about left or right. It's about whether our government works for the people it serves.`,
    `So I'm asking for your help. Share this video, join the campaign, and let's get this done together. Thank you.`,
  ];
  const n = Math.max(3, Math.min(paras.length, Math.round((lengthMinutes || 2) * 2.5)));
  return { title: `Speech: ${topic}`.slice(0, 70), speech: paras.slice(0, n - 1).concat(paras[paras.length - 1]).join('\n\n'), notes: 'Demo draft (add an Anthropic API key in Settings for real speechwriting).' };
}

function mockShots({ speech, looks }) {
  const sentences = speech.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+["”']?\s*/g) || [speech];
  const segments = [];
  let buf = '';
  for (const sent of sentences) {
    buf += sent;
    if (buf.split(/\s+/).length > 22) { segments.push(buf.trim()); buf = ''; }
  }
  if (buf.trim()) segments.push(buf.trim());
  const ideas = [
    'Wide shot of a busy American main street at golden hour, people walking, slow dolly forward',
    'Close-up of hands at a kitchen table reviewing household bills, soft window light',
    'Factory workers on an assembly line, steady tracking shot, warm practical lights',
    'Aerial drone shot over suburban neighborhood at sunrise',
    'Diverse group of volunteers knocking on doors, handheld documentary style',
    'Capitol-style neoclassical building exterior, low angle, clouds moving',
  ];
  const broll = [];
  segments.forEach((t, i) => {
    if (i === 0 || i === segments.length - 1 || i % 2 === 0) return;
    broll.push({ segment: i, offset: 1.5, duration: 4, description: ideas[i % ideas.length].split(',')[0], prompt: ideas[i % ideas.length] });
  });
  return {
    segments: segments.map((text, i) => ({
      text,
      look: looks[i % looks.length].key,
      transition: 'cut',
      description: looks[i % looks.length].label || 'Candidate to camera',
    })),
    broll,
    grade: { look: 'presidential-warm', reason: 'Warm, trustworthy default.' },
  };
}
