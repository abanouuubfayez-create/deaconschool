import { createFileRoute } from "@tanstack/react-router";
import { APICallError, generateText } from "ai";
import { z } from "zod";

import { createLovableAiGatewayProvider, getLovableAiGatewayRunId } from "@/lib/ai-gateway.server";

// ── قائمة نماذج الرؤية القوية بالترتيب حسب الأولوية والدقة ──
const VISION_MODELS = [
  "google/gemini-2.5-flash",
  "google/gemini-2.0-flash",
  "openai/gpt-4o",
  "openai/gpt-4o-mini",
] as const;

const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_RETRIES = 2;

// ── المخطط الهندسي للمدخلات ──
const BodySchema = z.object({
  prompt: z.string().min(1).max(25000),
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

// ── المخطط الهندسي لدرجات الطالب ──
const GradeFieldsSchema = z
  .object({
    behavior: z.union([z.number(), z.null()]).optional(),
    oral: z.union([z.number(), z.null()]).optional(),
    attendance: z.union([z.number(), z.null()]).optional(),
    written: z.union([z.number(), z.null()]).optional(),
  })
  .passthrough();

const StudentRowSchema = z.object({
  name: z.string().min(1),
  grades: z.record(z.string(), GradeFieldsSchema),
});

const VisionOutputSchema = z.object({
  rows: z.array(StudentRowSchema),
});

type VisionOutput = z.infer<typeof VisionOutputSchema>;

// ── البرومبت التوجيهي الصارم للنظام (System Prompt) ──
const SYSTEM_VISION_INSTRUCTIONS = `أنت خبير OCR متخصص فائق الدقة لقراءة كشوف درجات مدرسة الشمامسة المكتوبة بخط اليد.

قواعد المعالجة الصارمة:
1. 📋 ربط الأعمدة بالمواد (Subject-Indexed Columns):
   - كل عمود في الجدول يقع أسفل اسم مادة رئيسية مطبوع في رأس الصفحة (مثل: ألحان، قبطي، طقس، عقيدة، محفوظات).
   - تحت كل مادة توجد خانات فرعية (سلوك / behavior، شفوي / oral، حضور / attendance، تحريري / written).
   - يجب إرجاع الدرجات مفهرسة بكائن JSON باسم المادة الصريح ونوع الدرجة، ويُمنع منعاً باتاً إرجاع مصفوفة أرقام مجردة أو الاعتماد على الترتيب المكاني فقط.

2. 🔢 قراءة الأرقام كخانتين منفصلتين [عشرات][آحاد] وقاعدة الصفر الرمادي:
   - كل خانة درجة في التصميم تتكون من مربعين متجاورين: [المربع الأيسر = عشرات] و [المربع الأيمن = آحاد].
   - اقرأ الأرقام المكتوبة بخط اليد فقط (حبر أزرق، أسود، أو رصاص).
   - ⚠️ الصفر الرمادي الباهت المطبوع في الخلفية هو مجرد دليل طباعة (Watermark Guide) وليس درجة مكتوبة!
     * إذا كان المربع الأيسر يحتوي على صفر رمادي باهت والآحاد به رقم بخط اليد (مثل [0 رمادي][8 بخط اليد]) فالدرجة هي 8 فقط (وليس 80 أو 08).
     * إذا كانت خانة العشرات فارغة فالدرجة هي خانة الآحاد: [ ][5] = 5.
     * إذا كُتب رقم باليد في العشرات والآحاد معاً: [1][5] = 15، [2][0] = 20، [1][2] = 12.
     * الخانة الفارغة تماماً أو التي بها نقطة/دائرة صغيرة = 0.

3. 🛡️ التحقق من الحد الأقصى للدرجات (Max Limits):
   - التزم بالحد الأقصى لكل خانة كما هو موضح في دليل المواد بالبرومبت (مثال: سلوك من 10، شفوي من 40، حضور من 10، تحريري من 40).
   - ارفض أي قيمة تتجاوز الحد الأقصى للخانة (مثل قراءة 18 في خانة حدها 10 بسبب الخلط مع الصفر الرمادي) وصححها فوراً إلى الرقم المنطقي الصحيح.

4. 📦 صيغة المخرجات المطلوبة:
   - يجب إرجاع JSON صالح تماماً فقط بدون أي نص إضافي أو شروحات:
   {"rows":[{"name":"اسم الطالب","grades":{"اسم المادة":{"behavior":0,"oral":0,"attendance":0,"written":0}}}]}`;

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

// ── تنظيف واستخراج الـ JSON من رد الذكاء الاصطناعي ──
function cleanAndExtractJson(rawText: string): unknown {
  let text = rawText.trim();
  // إزالة وسوم markdown codeblock إن وُجدت
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    text = text.substring(start, end + 1);
  }
  return JSON.parse(text);
}

// ── استخراج الحدود القصوى للمواد من نص البرومبت ──
function parseMaxLimitsFromPrompt(prompt: string): Record<string, Record<string, number>> {
  const limits: Record<string, Record<string, number>> = {};
  // مطابقة أنماط مثل: مادة "ألحان": سلوك [behavior] من 10 ⬅️ شفوي [oral] من 40
  const subRegex = /مادة\s*["'«]([^"'»]+)["'»][^•\n]*/g;
  let match;
  while ((match = subRegex.exec(prompt)) !== null) {
    const subName = match[1].trim();
    const line = match[0];
    const subLimits: Record<string, number> = {};

    const bMatch = line.match(/سلوك.*?من\s*(\d+)/i);
    if (bMatch) subLimits["behavior"] = parseInt(bMatch[1], 10);

    const oMatch = line.match(/شفوي.*?من\s*(\d+)/i);
    if (oMatch) subLimits["oral"] = parseInt(oMatch[1], 10);

    const aMatch = line.match(/حضور.*?من\s*(\d+)/i);
    if (aMatch) subLimits["attendance"] = parseInt(aMatch[1], 10);

    const wMatch = line.match(/تحريري.*?من\s*(\d+)/i);
    if (wMatch) subLimits["written"] = parseInt(wMatch[1], 10);

    if (Object.keys(subLimits).length > 0) {
      limits[subName] = subLimits;
    }
  }
  return limits;
}

// ── التحقق الصارم من صحة الدرجات وضمان عدم تجاوز الحد الأقصى ──
function validateAndSanitizeRows(
  data: VisionOutput,
  limits: Record<string, Record<string, number>>,
): { isValid: boolean; errors: string[]; sanitized: VisionOutput } {
  const errors: string[] = [];
  const sanitized: VisionOutput = { rows: [] };

  for (const row of data.rows) {
    const cleanGrades: Record<string, Record<string, number | null>> = {};
    for (const [subj, compObj] of Object.entries(row.grades || {})) {
      cleanGrades[subj] = {};
      const subLimits = limits[subj] || {};

      for (const field of ["behavior", "oral", "attendance", "written"] as const) {
        const val = (compObj as Record<string, unknown>)[field];
        if (val === undefined || val === null) {
          cleanGrades[subj][field] = null;
          continue;
        }

        const num = typeof val === "number" ? val : Number(val);
        if (!Number.isFinite(num) || num < 0) {
          cleanGrades[subj][field] = null;
          continue;
        }

        const max = subLimits[field];
        if (typeof max === "number" && max > 0 && num > max) {
          errors.push(
            `الطالب "${row.name}" في مادة "${subj}" خانة "${field}": القيمة ${num} تتجاوز الحد الأقصى (${max}).`,
          );
          // تصحيح فوري إذا كانت نتيجة قراءة خاطئة لخانة الآحاد فقط
          if (num > max && num % 10 <= max) {
            cleanGrades[subj][field] = num % 10;
          } else {
            cleanGrades[subj][field] = null;
          }
        } else {
          cleanGrades[subj][field] = num;
        }
      }
    }
    sanitized.rows.push({
      name: row.name.trim(),
      grades: cleanGrades,
    });
  }

  return {
    isValid: errors.length === 0,
    errors,
    sanitized,
  };
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

        console.log(`[Vision API] Received request with ${parsed.images.length} image(s). Prompt length: ${parsed.prompt.length}`);

        const apiKey = process.env["LOVABLE_API_KEY"];
        if (!apiKey) {
          console.error("[Vision API] LOVABLE_API_KEY is missing!");
          return json({ error: "خدمة الذكاء الاصطناعي غير مهيأة على الخادم (LOVABLE_API_KEY مفقود)." }, 500);
        }

        const gateway = createLovableAiGatewayProvider(apiKey, getLovableAiGatewayRunId(request));
        const maxLimits = parseMaxLimitsFromPrompt(parsed.prompt);

        // دمج تعليمات النظام الدقيقة مع برومبت المستخدم
        const fullPromptText = `${SYSTEM_VISION_INSTRUCTIONS}\n\n--- تفاصيل الكشف والبيانات المرجعية ---\n${parsed.prompt}`;

        const imageContents = parsed.images.map((image) => ({
          type: "image" as const,
          image: `data:${image.mtype || "image/jpeg"};base64,${image.b64}`,
        }));

        let lastError: unknown = null;

        // ── تجربة النماذج المتسلسلة مع إعادة المحاولة والتحقق من المخطط والحدود ──
        for (const modelName of VISION_MODELS) {
          console.log(`[Vision API] Trying model: ${modelName} (temperature: 0)...`);

          for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
              const currentPrompt =
                attempt === 0
                  ? fullPromptText
                  : `${fullPromptText}\n\n⚠️ تنبيه إعادة المحاولة: المخرجات السابقة فشلت في التحقق. يرجى التأكد من إرجاع كائن JSON صالح تماماً بصيغة {"rows": [...]} وتطبيق قاعدة خانة العشرات/الآحاد والصفر الرمادي بدقة وعدم تجاوز الحدود القصوى.`;

              const result = await generateText({
                model: gateway(modelName),
                temperature: 0, // دقة قصوى وإلغاء العشوائية
                maxTokens: 8192,
                messages: [
                  {
                    role: "user",
                    content: [
                      { type: "text" as const, text: currentPrompt },
                      ...imageContents,
                    ],
                  },
                ],
              });

              const rawText = result.text || "";
              if (!rawText.trim()) {
                throw new Error("استجاب النموذج بنص فارغ");
              }

              // تنظيف وتحليل الـ JSON
              const parsedJson = cleanAndExtractJson(rawText);
              const validatedOutput = VisionOutputSchema.parse(parsedJson);

              // التحقق من الحدود القصوى وتطهير القيم
              const { errors: valErrors, sanitized } = validateAndSanitizeRows(validatedOutput, maxLimits);

              if (valErrors.length > 0) {
                console.warn(`[Vision API] Model ${modelName} attempt ${attempt + 1} had validation warnings:`, valErrors);
              }

              const cleanJsonString = JSON.stringify(sanitized);
              console.log(`[Vision API] Succeeded with model ${modelName}! Extracted ${sanitized.rows.length} students.`);

              return json({
                text: cleanJsonString,
                data: sanitized,
                finishReason: result.finishReason,
                usage: result.usage,
                warnings: result.warnings,
              });
            } catch (err) {
              lastError = err;
              console.warn(`[Vision API] Model ${modelName} attempt ${attempt + 1} failed:`, err instanceof Error ? err.message : err);
              if (attempt < MAX_RETRIES) {
                await new Promise((r) => setTimeout(r, 600));
              }
            }
          }
        }

        // إذا فشلت جميع المحاولات والنماذج
        console.error("[Vision API] All vision models and retries failed. Last error:", lastError);
        const status = APICallError.isInstance(lastError) ? lastError.statusCode : undefined;
        const errMsg = lastError instanceof Error ? lastError.message : String(lastError);

        if (status === 429) {
          return json({ error: "الخدمة مشغولة حاليًا (429) — انتظر قليلًا ثم أعد المحاولة.", details: errMsg }, 429);
        }
        if (status === 402) {
          return json({ error: "انتهى رصيد الذكاء الاصطناعي (402) — يلزم شحن الرصيد من Lovable.", details: errMsg }, 402);
        }
        if (status === 403) {
          return json({ error: "الذكاء الاصطناعي معطّل لهذا المشروع (403).", details: errMsg }, 403);
        }

        return json({ error: "تعذّر استخراج الدرجات من الصور بدقة: " + errMsg, details: errMsg }, 502);
      },
    },
  },
});

