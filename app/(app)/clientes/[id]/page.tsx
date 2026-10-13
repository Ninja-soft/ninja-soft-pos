"use client";

import { useParams } from "next/navigation";
import { Customer360 } from "@/components/customers/c360/Customer360";

// Ficha del cliente 360 (H31b · ADR-067).
export default function Cliente360Page() {
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === "string" ? params.id : null;
  return <Customer360 customerId={id} />;
}
