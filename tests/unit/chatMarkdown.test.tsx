import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatMarkdown, parseBlocks } from "@/components/ai/ChatMarkdown";

describe("parseBlocks", () => {
  it("separa párrafos, listas y títulos", () => {
    const blocks = parseBlocks(
      "# Resumen\nHoy vendiste bien.\nSigue igual.\n\n- uno\n- dos\n\n1. primero\n2. segundo",
    );
    expect(blocks.map((b) => b.kind)).toEqual(["h", "p", "ul", "ol"]);
    expect(blocks[1]).toEqual({
      kind: "p",
      lines: ["Hoy vendiste bien.", "Sigue igual."],
    });
    expect(blocks[3]).toEqual({
      kind: "ol",
      items: ["primero", "segundo"],
      start: 1,
    });
  });
});

describe("ChatMarkdown", () => {
  it("renderiza negrita, código e itálica como nodos", () => {
    const { container } = render(
      <ChatMarkdown text="Vendiste **$100** con `Coca` y *hoy*" />,
    );
    expect(container.querySelector("strong")?.textContent).toBe("$100");
    expect(container.querySelector("code")?.textContent).toBe("Coca");
    expect(container.querySelector("em")?.textContent).toBe("hoy");
  });

  it("no interpreta HTML del modelo", () => {
    const { container } = render(
      <ChatMarkdown text={"<img src=x onerror=alert(1)>"} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img");
  });
});
