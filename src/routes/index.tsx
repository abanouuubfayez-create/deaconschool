import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "مدرسة البابا شنودة — نظام الإدارة" },
      {
        name: "description",
        content:
          "نظام إدارة مدرسة البابا شنودة للألحان والطقس والقبطي، مع استخراج الدرجات والغياب من الصور بالذكاء الاصطناعي بدون مفاتيح API.",
      },
      { property: "og:title", content: "مدرسة البابا شنودة — نظام الإدارة" },
      {
        property: "og:description",
        content: "إدارة الطلاب والدرجات والغياب، وقراءة كشوف OCR بالذكاء الاصطناعي.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <main
      dir="rtl"
      className="flex min-h-screen items-center justify-center bg-background px-6 py-16"
    >
      <div className="w-full max-w-xl rounded-2xl border border-border bg-card p-8 text-center shadow-sm">
        <h1 className="text-2xl font-bold text-card-foreground">مدرسة البابا شنودة</h1>
        <p className="mt-3 text-sm leading-7 text-muted-foreground">
          نظام الإدارة يعمل الآن بالذكاء الاصطناعي المدمج — لا حاجة لمفتاح Google أو Anthropic،
          ولن تظهر رسالة تجاوز الحصة المجانية بعد اليوم.
        </p>
        <a
          href="/school.html"
          className="mt-7 inline-flex items-center justify-center rounded-lg bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
        >
          فتح البرنامج
        </a>
        <p className="mt-4 text-xs text-muted-foreground">
          اختر «Lovable AI» في قائمة مزود الذكاء الاصطناعي عند رفع صور الكشوف.
        </p>
      </div>
    </main>
  );
}
