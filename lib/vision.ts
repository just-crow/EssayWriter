import OpenAI from "openai";
import { NIM_BASE_URL, nimClient, withRetry, NIM_TIMEOUT_MS } from "./nim";

/**
 * Vision model used to transcribe attached pictures into context text.
 * The main essay model (nemotron-3-super) rejects multimodal input, so
 * images are converted to text once at upload time and the pipeline
 * continues to work with text only.
 */
export const NIM_VISION_MODEL = "meta/llama-3.2-11b-vision-instruct";

const OCR_PROMPT = `OCR and describe task. This image was attached as context for an academic essay.
Do two things in order:
1. TRANSCRIPTION: output every word of visible text exactly as written, preserving line breaks. If no text is visible, write "No visible text."
2. VISUAL NOTES: one or two sentences describing non-text visuals that matter (charts, diagrams, photos, handwriting quality, layout). If nothing relevant, write "None."
Format exactly:
TRANSCRIPTION:
<text>
VISUAL NOTES:
<notes>`;

export async function transcribeImage(
  buffer: Buffer,
  mime: string,
  filename: string
): Promise<string> {
  const client: OpenAI = nimClient();
  const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
  const completion = await withRetry(() =>
    client.chat.completions.create(
      {
        model: NIM_VISION_MODEL,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: OCR_PROMPT },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
        temperature: 0.1,
        max_tokens: 1500,
      },
      { timeout: NIM_TIMEOUT_MS }
    )
  );
  const text = completion.choices?.[0]?.message?.content?.trim() ?? "";
  if (!text) throw new Error(`Could not read ${filename}: the vision model returned nothing.`);
  return `[Attached image: ${filename}]\n${text}`;
}
