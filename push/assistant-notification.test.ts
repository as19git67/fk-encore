import { describe, expect, it } from "vitest";
import { answerExcerpt, buildAssistantAnswerNotification } from "./push.service";

describe("the assistant's answer as a notification", () => {
  it("opens the conversation and collapses per conversation", () => {
    const n = buildAssistantAnswerNotification({ conversationId: 12, title: "Zähler im Haus", answer: "Du hast **drei** Zähler." });
    expect(n).toEqual({
      title: "Zähler im Haus",
      body: "Du hast drei Zähler.",
      url: "/app/assistent?c=12",
      tag: "assistant-answer:12",
      data: { kind: "assistant_answer", conversationId: 12 },
    });
  });

  it("falls back to a title and a body when the answer has none", () => {
    const n = buildAssistantAnswerNotification({ conversationId: 3, title: "  ", answer: "" });
    expect(n.title).toBe("Assistent");
    expect(n.body).toBe("Die Antwort ist fertig.");
  });

  it("strips Markdown and cuts at a word", () => {
    expect(answerExcerpt("## Ergebnis\n\n- *Erstens* ein `Wert`\n- Zweitens [ein Link](https://example.test)\n\n```\ncode\n```"))
      .toBe("Ergebnis Erstens ein Wert Zweitens ein Link");
    const long = Array.from({ length: 60 }, (_, i) => `Wort${i}`).join(" ");
    const cut = answerExcerpt(long, 50);
    expect(cut.length).toBeLessThanOrEqual(50);
    expect(cut.endsWith("…")).toBe(true);
    // Cut between words, not inside one.
    expect(cut).toMatch(/^(Wort\d+ )*Wort\d+…$/);
  });
});
