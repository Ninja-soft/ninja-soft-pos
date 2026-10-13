"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancel as cancelJob,
  enqueue,
  nextJob,
  parseQueue,
  recover,
  reprint as reprintJob,
  retry as retryJob,
  runQueueStep,
  type PrintDriver,
  type PrintJob,
} from "./queue";

// Cola de impresión del equipo (F10 · ADR-101): estado en localStorage (la
// impresora es de esta PC) y un ciclo que procesa de a un trabajo mientras
// haya pendientes. Todo en try/catch: sin storage la cola vive en memoria.

const STORAGE_KEY = "ninja-print-queue";

function load(): PrintJob[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? parseQueue(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

function persist(q: PrintJob[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(q));
  } catch {
    /* sin storage */
  }
}

/**
 * Encola un trabajo en la cola de ESTE equipo sin montar el hook (por ejemplo
 * la etiqueta ZPL de un envío, ADR-103). La procesa la pantalla que tenga la
 * cola abierta con su driver (Mostrador simulado o el puente local).
 */
export function addToDeviceQueue(
  job: Pick<PrintJob, "doc" | "label" | "printerId" | "payload"> & {
    maxAttempts?: number;
  },
): PrintJob[] {
  const next = enqueue(load(), { ...job, id: newId() }, Date.now());
  persist(next);
  return next;
}

const newId = () =>
  `j_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export function usePrintQueue(
  driver: PrintDriver,
  onDone?: (job: PrintJob) => void,
) {
  const [queue, setQueue] = useState<PrintJob[]>([]);
  const ref = useRef<PrintJob[]>([]);
  const running = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const set = useCallback((q: PrintJob[]) => {
    ref.current = q;
    setQueue(q);
    persist(q);
  }, []);

  useEffect(() => {
    set(recover(load(), Date.now()));
  }, [set]);

  const tick = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      const done = await runQueueStep(() => ref.current, set, driver);
      if (done && done.status !== "printing") onDoneRef.current?.(done);
    } finally {
      running.current = false;
    }
  }, [driver, set]);

  const hasWork = queue.some(
    (j) => j.status === "pending" || j.status === "printing",
  );
  useEffect(() => {
    if (!hasWork) return;
    const t = setInterval(() => {
      if (nextJob(ref.current, Date.now())) void tick();
    }, 400);
    return () => clearInterval(t);
  }, [hasWork, tick]);

  return {
    queue,
    add: (
      job: Pick<PrintJob, "doc" | "label" | "printerId" | "payload"> & {
        maxAttempts?: number;
      },
    ) => set(enqueue(ref.current, { ...job, id: newId() }, Date.now())),
    retry: (id: string) => set(retryJob(ref.current, id, Date.now())),
    reprint: (id: string) =>
      set(reprintJob(ref.current, id, newId(), Date.now())),
    cancel: (id: string) => set(cancelJob(ref.current, id, Date.now())),
    clearFinished: () =>
      set(
        ref.current.filter(
          (j) => j.status !== "printed" && j.status !== "cancelled",
        ),
      ),
  };
}
