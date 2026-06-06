"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ticketTemplatesApi, type TemplateInput, type TemplateKind } from "./api";

const KEY = ["ticket-templates"];

export function useTicketTemplates() {
  return useQuery({ queryKey: KEY, queryFn: ticketTemplatesApi.list });
}

export function useDefaultTemplate(kind: TemplateKind, enabled = true) {
  return useQuery({
    queryKey: [...KEY, "default", kind],
    enabled,
    queryFn: () => ticketTemplatesApi.getDefault(kind),
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: KEY });
}

export function useCreateTemplate() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ tenantId, input }: { tenantId: string; input: TemplateInput }) =>
      ticketTemplatesApi.create(tenantId, input),
    onSuccess: inv,
  });
}

export function useUpdateTemplate() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Partial<TemplateInput> }) =>
      ticketTemplatesApi.update(id, input),
    onSuccess: inv,
  });
}

export function useSetDefaultTemplate() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ id, kind }: { id: string; kind: TemplateKind }) =>
      ticketTemplatesApi.setDefault(id, kind),
    onSuccess: inv,
  });
}

export function useRemoveTemplate() {
  const inv = useInvalidate();
  return useMutation({ mutationFn: ticketTemplatesApi.remove, onSuccess: inv });
}
