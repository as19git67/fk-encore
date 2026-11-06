import SwiftUI

/// One stored message: the user's question on the right, the answer with
/// its result blocks on the left.
struct MessageView: View {
    let message: ConversationMessage
    let store: ConversationStore
    let opener: RowOpener

    var body: some View {
        if message.isUser {
            HStack {
                Spacer(minLength: 40)
                Text(message.content)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Color.accentColor.opacity(0.15), in: RoundedRectangle(cornerRadius: 18))
                    .textSelection(.enabled)
            }
        } else {
            VStack(alignment: .leading, spacing: 12) {
                MarkdownText(message.content)
                ForEach(Array(message.blocks.enumerated()), id: \.offset) { _, block in
                    BlockOrCards(block: block, store: store, opener: opener)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// The turn being answered: the steps so far, the text as it streams, and
/// the blocks the tools brought.
struct LiveTurnView: View {
    let turn: LiveTurn
    let store: ConversationStore
    let opener: RowOpener
    let cancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(turn.drafts, id: \.self) { draft in
                MarkdownText(draft.text)
                    .foregroundStyle(.secondary)
                    .overlay(alignment: .bottomLeading) {
                        if draft.withdrawn {
                            Text("Zurückgenommen und erneut geprüft")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                                .offset(y: 14)
                        }
                    }
                    .padding(.bottom, draft.withdrawn ? 14 : 0)
            }
            if !turn.steps.isEmpty {
                TurnStepsView(steps: turn.steps)
            }
            if !turn.text.isEmpty {
                MarkdownText(turn.text)
            } else if !turn.finished, turn.steps.allSatisfy(\.done) {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Der Assistent denkt nach …")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            ForEach(Array(turn.blocks.enumerated()), id: \.offset) { _, block in
                BlockOrCards(block: block, store: store, opener: opener)
            }
            if !turn.finished {
                Button("Abbrechen", systemImage: "stop.circle", action: cancel)
                    .font(.footnote)
                    .buttonStyle(.bordered)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A `proposal` block is one card per row (stage 4); every other block is
/// the generic list.
struct BlockOrCards: View {
    let block: ResultBlock
    let store: ConversationStore
    let opener: RowOpener

    var body: some View {
        if block.kind == "proposal" {
            ForEach(block.proposals) { proposal in
                ProposalCardView(proposal: proposal, store: store, opener: opener, conversationId: store.summary?.id)
            }
        } else {
            BlockView(block: block, opener: opener)
        }
    }
}

/// The tool calls of a turn, as the web shows them: a check for each that is done.
struct TurnStepsView: View {
    let steps: [TurnStep]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(steps) { step in
                HStack(spacing: 8) {
                    if step.done {
                        Image(systemName: step.error == nil ? "checkmark.circle" : "exclamationmark.circle")
                            .foregroundStyle(step.error == nil ? Color.secondary : Color.orange)
                    } else {
                        ProgressView().controlSize(.small)
                    }
                    Text(step.label)
                    if let count = step.rowCount, step.done, step.error == nil {
                        Text("\(count)")
                            .foregroundStyle(.tertiary)
                    }
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
        }
        .padding(10)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 10))
    }
}

/// The answer's Markdown, the way `Text` can read it: paragraph by
/// paragraph, headings as headlines, list items with a bullet. Tables and
/// code stay as text; the model rarely writes them, and a table in a chat
/// bubble has no room on a phone anyway.
struct MarkdownText: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(Self.paragraphs(of: text).enumerated()), id: \.offset) { _, paragraph in
                switch paragraph {
                case .heading(let line):
                    Text(Self.inline(line)).font(.headline)
                case .items(let lines):
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                Text("•")
                                Text(Self.inline(line))
                            }
                        }
                    }
                case .text(let body):
                    Text(Self.inline(body))
                }
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    enum Paragraph: Equatable {
        case heading(String)
        case items([String])
        case text(String)
    }

    /// Blank lines separate paragraphs; a run of `- ` or `1. ` lines is one list.
    static func paragraphs(of text: String) -> [Paragraph] {
        var out: [Paragraph] = []
        for raw in text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n\n") {
            let block = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if block.isEmpty { continue }
            let lines = block.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
            if lines.count == 1, let heading = headingText(lines[0]) {
                out.append(.heading(heading))
            } else if lines.allSatisfy({ listItem($0) != nil }) {
                out.append(.items(lines.compactMap(listItem)))
            } else {
                // A paragraph that mixes a sentence with a list below it: the
                // list items keep their bullet, the rest flows as text.
                var textLines: [String] = []
                var items: [String] = []
                func flush() {
                    if !textLines.isEmpty { out.append(.text(textLines.joined(separator: "\n"))); textLines = [] }
                    if !items.isEmpty { out.append(.items(items)); items = [] }
                }
                for line in lines {
                    if let item = listItem(line) {
                        if !textLines.isEmpty { flush() }
                        items.append(item)
                    } else {
                        if !items.isEmpty { flush() }
                        textLines.append(line)
                    }
                }
                flush()
            }
        }
        return out
    }

    static func headingText(_ line: String) -> String? {
        guard line.hasPrefix("#") else { return nil }
        let stripped = line.drop(while: { $0 == "#" })
        guard stripped.first == " " else { return nil }
        return stripped.trimmingCharacters(in: .whitespaces)
    }

    static func listItem(_ line: String) -> String? {
        for marker in ["- ", "* ", "• "] where line.hasPrefix(marker) {
            return String(line.dropFirst(marker.count))
        }
        // `1. ` … `99. `
        if let dot = line.firstIndex(of: "."), dot != line.startIndex,
           line[..<dot].allSatisfy(\.isNumber), line.index(after: dot) < line.endIndex,
           line[line.index(after: dot)] == " " {
            return String(line[line.index(dot, offsetBy: 2)...])
        }
        return nil
    }

    /// Bold, italics and links; whitespace kept as written.
    static func inline(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(text)
    }
}
