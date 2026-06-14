"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { couponsApi, type CouponInput } from "./api";

export function useCoupons() {
  return useQuery({
    queryKey: ["coupons"],
    queryFn: () => couponsApi.list(),
  });
}

export function useCouponMutations() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ["coupons"] });
  return {
    create: useMutation({ mutationFn: (input: CouponInput) => couponsApi.create(input), onSuccess: inv }),
    update: useMutation({
      mutationFn: (v: { id: string; input: CouponInput }) => couponsApi.update(v.id, v.input),
      onSuccess: inv,
    }),
    remove: useMutation({ mutationFn: (id: string) => couponsApi.remove(id), onSuccess: inv }),
  };
}
