// Helper de impresión web (H22). Aislado del helper PURO (profiles.ts) porque
// toca el DOM (window.print).
//
// Copias: window.print() no acepta una cantidad de copias, así que para imprimir
// N veces se dispara el diálogo/funcion de impresión N veces en secuencia. En la
// mayoría de impresoras térmicas con auto-print (sin diálogo) esto produce N
// tickets. Con diálogo visible, el usuario confirma cada uno — es la limitación
// del web print (documentada en la UI; la cola/impresión directa llega en F4).
//
// Se mantiene chico y secuencial: un pequeño delay entre llamadas para que el
// navegador alcance a procesar cada trabajo antes de abrir el siguiente.
export function webPrintCopies(copies = 1, gapMs = 350): void {
  if (typeof window === "undefined") return;
  const n = Math.max(1, Math.min(20, Math.trunc(copies) || 1));
  // Primera copia inmediata; las siguientes espaciadas.
  window.print();
  for (let i = 1; i < n; i++) {
    setTimeout(() => window.print(), gapMs * i);
  }
}
