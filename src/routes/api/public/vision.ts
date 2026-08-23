import { createFileRoute } from "@tanstack/react-router";
import { APICallError, generateText } from "ai";
import { z } from "zod";

import { createLovableAiGatewayProvider, getLovableAiGatewayRunId } from "@/lib/ai-gateway.server";

const MODEL = "google/gemini-2.5-flash";
const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const BodySchema = z.object({
  prompt: z.string().min(1).max(20000),
  images: z
    .array(
      z.object({
        b64: z.string().min(1),
        mtype: z.string().min(1).default("image/jpeg"),
      }),
    )
    .min(1)
    .max(MAX_IMAGES),
});

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders },
  });
}

export const Route = createFileRoute("/api/public/vision")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders }),
      POST: async ({ request }) => {
        let parsed;
        try {
          parsed = BodySchema.parse(await request.json());
        } catch {
          return json({ error: "طلب غير صالح: تأكد من إرسال prompt وصور بصيغة صحيحة." }, 400);
        }

        for (const image of parsed.images) {
          if (image.b64.length * 0.75 > MAX_IMAGE_BYTES) {
            return json({ error: "حجم إحدى الصور كبير جدًا — قلّل الدقة وحاول مرة أخرى." }, 400);
          }
          if (!image.mtype.startsWith("image/")) {
            return json({ error: "نوع ملف غير مدعوم — استخدم JPG أو PNG أو WEBP." }, 400);
          }
        }

        console.log(`[Vision API] Received request with ${parsed.images.length} images. Prompt length: ${parsed.prompt.length}`);

        const apiKey = process.env["LOVABLE_API_KEY"];
        if (!apiKey) {
          console.error("[Vision API] LOVABLE_API_KEY is missing!");
          return json({ error: "خدمة الذكاء الاصطناعي غير مهيأة على الخادم (LOVABLE_API_KEY مفقود)." }, 500);
        }

        const gateway = createLovableAiGatewayProvider(apiKey, getLovableAiGatewayRunId(request));

        try {
          console.log(`[Vision API] Calling Lovable AI Gateway with model ${MODEL}...`);
          const result = await generateText({
            model: gateway(MODEL),
            temperature: 0,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text" as const, text: parsed.prompt },
                  ...parsed.images.map((image) => ({
                    type: "image" as const,
                    image: `data:${image.mtype};base64,${image.b64}`,
                  })),
                ],
              },
            ],
          });

          const text = result.text || "";
          console.log(`[Vision API] Success! Text length: ${text.length}, FinishReason: ${result.finishReason}, Warnings: ${JSON.stringify(result.warnings || [])}`);
          if (text.length < 50) {
            console.log(`[Vision API] Response snippet: "${text}"`);
          }

          return json({
            text,
            finishReason: result.finishReason,
            usage: result.usage,
            warnings: result.warnings,
          });
        } catch (error) {
          console.error("[Vision API Error]:", error);
          const status = APICallError.isInstance(error) ? error.statusCode : undefined;
          const errMsg = error instanceof Error ? error.message : String(error);
          if (status === 429) {
            return json({ error: "الخدمة مشغولة حاليًا (429) — انتظر قليلًا ثم أعد المحاولة.", details: errMsg }, 429);
          }
          if (status === 402) {
            return json({ error: "انتهى رصيد الذكاء الاصطناعي (402) — يلزم شحن الرصيد من Lovable.", details: errMsg }, 402);
          }
          if (status === 403) {
            return json({ error: "الذكاء الاصطناعي معطّل لهذا المشروع (403).", details: errMsg }, 403);
          }
          return json({ error: "تعذّر تحليل الصور: " + errMsg, details: errMsg }, 502);
        }
      },
    },
  },
});
