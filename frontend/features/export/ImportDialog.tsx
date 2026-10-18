"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { UploadSimple } from "@phosphor-icons/react";
import type { ImportFormat } from "@/types/api";
import { Modal } from "@/components/ui/overlay";
import { Button } from "@/components/ui/button";
import { Chip, Label, Textarea } from "@/components/ui/primitives";
import { useImportWorkspace } from "@/features/workspaces/hooks";

const FORMATS: { value: ImportFormat; label: string; hint: string; accept: string }[] = [
  { value: "json", label: "JSON", hint: "A workspace exported from this app", accept: ".json" },
  { value: "bookmarks", label: "Bookmarks HTML", hint: "Exported from any browser", accept: ".html,.htm" },
  { value: "onetab", label: "OneTab list", hint: "One “url | title” per line", accept: ".txt" },
];

export function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [format, setFormat] = useState<ImportFormat>("onetab");
  const [content, setContent] = useState("");
  const imp = useImportWorkspace();
  const router = useRouter();
  const f = FORMATS.find((x) => x.value === format)!;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Import research"
      description="Creates a new workspace from your links. They are analyzed when opened."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            loading={imp.isPending}
            disabled={!content.trim()}
            onClick={async () => {
              const r = await imp.mutateAsync({ format, content }).catch(() => null);
              if (r) {
                onOpenChange(false);
                setContent("");
                router.push(`/w/${r.workspace_id}`);
              }
            }}
          >
            <UploadSimple size={16} weight="bold" /> Import
          </Button>
        </>
      }
    >
      <div className="flex flex-wrap gap-2">
        {FORMATS.map((x) => (
          <Chip key={x.value} selected={format === x.value} onClick={() => setFormat(x.value)}>
            {x.label}
          </Chip>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted">{f.hint}</p>
      <div className="mt-4">
        <Label htmlFor="imp-file">Choose a file</Label>
        <input
          id="imp-file"
          type="file"
          accept={f.accept}
          className="block w-full text-sm file:mr-3 file:rounded-full file:border-2 file:border-ink file:bg-white file:px-4 file:py-2 file:text-sm file:font-bold"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (file) setContent(await file.text());
          }}
        />
      </div>
      <div className="mt-4">
        <Label htmlFor="imp-text" hint="or paste">Content</Label>
        <Textarea
          id="imp-text"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className="min-h-36 font-mono text-xs"
          placeholder={format === "onetab" ? "https://arxiv.org/abs/2005.11401 | RAG paper\nhttps://github.com/pgvector/pgvector | pgvector" : "Paste file content…"}
        />
      </div>
    </Modal>
  );
}
