/** A simple explanation page: a title, one introduction, and sections of plain text or lists. */
import { SiteShell } from "./SiteShell";

export interface InfoSection {
  heading: string;
  text?: string;
  items?: string[];
}

export function InfoPage({ title, intro, sections }: { title: string; intro: string; sections: InfoSection[] }) {
  return (
    <SiteShell>
      <article className="mx-auto max-w-3xl px-6 pb-24 pt-10 sm:px-8">
        <h1 className="font-display text-4xl font-black leading-tight sm:text-5xl">{title}</h1>
        <p className="mt-5 text-lg leading-relaxed text-ink-soft">{intro}</p>

        <div className="mt-12 space-y-10">
          {sections.map((s) => (
            <section key={s.heading} className="border-t border-line pt-8">
              <h2 className="font-display text-2xl font-black">{s.heading}</h2>
              {s.text && <p className="mt-3 text-base leading-relaxed text-ink-soft">{s.text}</p>}
              {s.items && (
                <ul className="mt-3 list-disc space-y-2 pl-5 text-base leading-relaxed text-ink-soft">
                  {s.items.map((item) => <li key={item}>{item}</li>)}
                </ul>
              )}
            </section>
          ))}
        </div>
      </article>
    </SiteShell>
  );
}
