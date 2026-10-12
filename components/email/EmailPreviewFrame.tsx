"use client";

import { useCallback, useRef, useState } from "react";

// Vista previa fiel de un email: renderiza el documento HTML completo (doctype,
// fondo, tablas) en un iframe aislado, como lo vería un cliente de correo. El
// sandbox sin allow-scripts impide ejecutar código del HTML (las plantillas del
// sistema son editables por staff); allow-same-origin solo sirve para medir el
// alto del contenido y ajustar el iframe.
export function EmailPreviewFrame({
  html,
  title = "Vista previa del email",
  minHeight = 480,
}: {
  html: string;
  title?: string;
  minHeight?: number;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(minHeight);

  const fit = useCallback(() => {
    const doc = ref.current?.contentDocument;
    if (!doc?.body) return;
    setHeight(Math.max(minHeight, doc.documentElement.scrollHeight));
  }, [minHeight]);

  return (
    <iframe
      ref={ref}
      title={title}
      srcDoc={html}
      sandbox="allow-same-origin"
      onLoad={fit}
      className="block w-full rounded-lg border-0 bg-white"
      style={{ height }}
    />
  );
}
