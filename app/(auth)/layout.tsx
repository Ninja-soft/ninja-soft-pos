import Link from "next/link";
import { WordmarkPos } from "@/components/brand/Logo";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="ninja-dark-bg relative flex min-h-screen items-center justify-center px-4 py-12 text-ninja-softWhite">
      <div className="ninja-grid pointer-events-none absolute inset-0 opacity-20" />
      <div className="relative z-10 w-full max-w-md">
        <Link href="/" className="mb-8 flex justify-center">
          <WordmarkPos className="h-16 w-auto sm:h-20" priority />
        </Link>
        {children}
      </div>
    </div>
  );
}
