import Image from "next/image";

/** A real screenshot of the app: a goal, pages in a tree that follows where the user went, and a page that is not related to the goal. */
export function AppScreenshot() {
  return (
    <div className="overflow-hidden rounded-[22px] border border-ink/10 bg-white shadow-[0_30px_80px_-30px_rgba(18,21,28,0.35)]">
      <Image
        src="/landing/app-canvas.webp"
        width={2200}
        height={1380}
        priority
        alt="The Research Map canvas. Pages sit in a tree that shows where you went. One page is marked as not related to your goal."
        className="block h-auto w-full"
      />
    </div>
  );
}
