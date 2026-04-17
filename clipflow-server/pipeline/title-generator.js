require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Generates 3 Spanish TikTok titles for a given clip moment.
 * Title 1: direct translation of the original video title (faithful, natural Spanish).
 * Titles 2 & 3: two creative viral alternatives inspired by the content.
 * @param {{ start, end, reason, score }} moment
 * @param {number} clipIndex - 0-based index
 * @param {string} [videoTitle] - original YouTube video title
 * @returns {string[]} array of 3 title strings
 */
async function generateTitles(moment, clipIndex, videoTitle = '') {
  console.log(`📝 Generating Spanish titles for clip ${clipIndex + 1}...`);

  const duration = Math.round(moment.end - moment.start);

  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: `Eres un experto en contenido viral de TikTok en español latino.

Título original del video (en inglés): "${videoTitle}"
Contexto del clip:
- Tema/hook: ${moment.reason}
- Duración: ${duration} segundos
- Puntuación viral: ${moment.score}/10

Genera EXACTAMENTE 3 títulos para TikTok en ESPAÑOL siguiendo estas reglas:

TÍTULO 1 — Traducción fiel del título original:
✓ Traduce "${videoTitle}" al español de forma natural y fluida
✓ Mantén el significado original, solo cambia el idioma
✓ Agrega 1 emoji relevante al inicio o final
✓ Máximo 100 caracteres

TÍTULO 2 — Alternativa viral con pregunta o curiosidad:
✓ Basado en el contenido del clip
✓ Usa una pregunta, dato sorprendente o hook de curiosidad
✓ 1–2 emojis estratégicos
✓ Máximo 100 caracteres

TÍTULO 3 — Alternativa viral con urgencia o revelación:
✓ Basado en el contenido del clip
✓ Usa palabras de impacto: secreto, nadie sabe, error, descubre, etc.
✓ 1–2 emojis estratégicos
✓ Máximo 100 caracteres

Responde ÚNICAMENTE con un array JSON de 3 strings. Sin markdown, sin explicaciones:
["título 1", "título 2", "título 3"]`,
      },
    ],
  });

  const raw = response.content[0].text.trim();

  // Extract JSON array
  const jsonMatch = raw.match(/\[[\s\S]*?\]/);
  if (!jsonMatch) {
    console.warn(`  ⚠️  Could not parse titles JSON for clip ${clipIndex + 1}, using fallback`);
    return generateFallbackTitles(moment, videoTitle);
  }

  let titles;
  try {
    titles = JSON.parse(jsonMatch[0]);
  } catch {
    console.warn(`  ⚠️  JSON parse error for clip ${clipIndex + 1}, using fallback`);
    return generateFallbackTitles(moment, videoTitle);
  }

  // Ensure we have exactly 3 strings
  const result = titles
    .filter((t) => typeof t === 'string' && t.trim().length > 0)
    .slice(0, 3);

  while (result.length < 3) {
    result.push(...generateFallbackTitles(moment, videoTitle).slice(result.length));
  }

  console.log(`  ✅ Titles for clip ${clipIndex + 1}:`);
  result.forEach((t, i) => console.log(`     ${i + 1}. ${t}`));

  return result;
}

function generateFallbackTitles(moment, videoTitle = '') {
  return [
    videoTitle ? `🎬 ${videoTitle.slice(0, 90)}` : `😱 No vas a creer lo que pasó...`,
    `🔥 ¿Sabías esto? La verdad que nadie te cuenta`,
    `👀 Esto cambió todo | ${Math.round(moment.score * 10)}% de la gente lo ignora`,
  ];
}

module.exports = { generateTitles };
