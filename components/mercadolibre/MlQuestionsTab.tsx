"use client";

import { useMemo, useState } from "react";
import { ExternalLink, MessageCircleQuestion, Send } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Segmented } from "@/components/ui/Segmented";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { ANSWER_STATE_LABELS, QUESTION_STATUS_LABELS, mlErrorMessage } from "@/lib/mercadolibre/labels";
import { useMlMutations, useMlQuestions, type MlQuestion } from "@/modules/mercadolibre/hooks";
import { MlTemplatePicker } from "./gestor/MlTemplatePicker";

function when(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });
}

function QuestionRow({ q }: { q: MlQuestion }) {
  const { toast } = useToast();
  const { answer } = useMlMutations();
  const [text, setText] = useState("");
  const open = q.status === "UNANSWERED" && q.answer_state !== "sending" && q.answer_state !== "sent";
  const valid = text.trim().length >= 2 && text.trim().length <= 2000;

  return (
    <div className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={q.status === "UNANSWERED" ? "warning" : "neutral"}>{QUESTION_STATUS_LABELS[q.status] ?? q.status}</Badge>
        {q.answer_state !== "none" && ANSWER_STATE_LABELS[q.answer_state] && (
          <Badge tone={q.answer_state === "error" ? "danger" : q.answer_state === "sent" ? "success" : "info"}>
            {ANSWER_STATE_LABELS[q.answer_state]}
          </Badge>
        )}
        <span className="text-xs text-muted-foreground">{when(q.date_created)}</span>
      </div>
      <p className="flex items-center gap-1 text-xs text-muted-foreground">
        {q.ml_items?.title ?? q.ml_item_id}
        {q.ml_items?.permalink && (
          <a href={q.ml_items.permalink} target="_blank" rel="noreferrer" aria-label="Ver publicación">
            <ExternalLink size={12} />
          </a>
        )}
      </p>
      <p className="text-sm">{q.text}</p>
      {q.answer_text && <p className="rounded-lg bg-muted px-3 py-2 text-sm">{q.answer_text}</p>}
      {q.answer_state === "error" && q.last_error && <p className="text-xs text-danger">{q.last_error}</p>}
      {open && (
        <div className="space-y-2">
          <MlTemplatePicker scope="question" onPick={setText} />
          <textarea
            className="min-h-[80px] w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-ninja-flameSoft"
            placeholder="Escribí la respuesta (sin datos de contacto: Mercado Libre los modera)"
            maxLength={2000}
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="Respuesta"
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={!valid}
              loading={answer.isPending}
              onClick={() =>
                answer.mutate(
                  { questionId: q.id, text: text.trim() },
                  {
                    onSuccess: () => {
                      toast({ title: "Respuesta enviada a la cola", variant: "success" });
                      setText("");
                    },
                    onError: (e) => toast({ title: "No se pudo responder", description: mlErrorMessage(e), variant: "error" }),
                  },
                )
              }
            >
              <Send size={15} /> Responder
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function MlQuestionsTab({ accountId }: { accountId: string }) {
  const { data: questions = [], isLoading } = useMlQuestions(accountId);
  const [view, setView] = useState<"open" | "all">("open");
  const list = useMemo(() => {
    const base = view === "open" ? questions.filter((q) => q.status === "UNANSWERED") : questions;
    return [...base].sort((a, b) => Number(b.status === "UNANSWERED") - Number(a.status === "UNANSWERED"));
  }, [questions, view]);

  if (isLoading) return <SpinnerBlock className="py-16" />;

  return (
    <div className="space-y-4">
      <Segmented
        value={view}
        onChange={setView}
        size="sm"
        aria-label="Preguntas"
        options={[
          { value: "open", label: `Sin responder (${questions.filter((q) => q.status === "UNANSWERED").length})` },
          { value: "all", label: "Todas" },
        ]}
      />
      {list.length === 0 ? (
        <EmptyState icon={MessageCircleQuestion} title={view === "open" ? "No hay preguntas sin responder" : "Todavía no hay preguntas"} />
      ) : (
        <div className="divide-y divide-border rounded-xl bg-card">
          {list.map((q) => (
            <QuestionRow key={q.id} q={q} />
          ))}
        </div>
      )}
    </div>
  );
}
