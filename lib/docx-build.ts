import {
  AlignmentType,
  Document,
  ExternalHyperlink,
  FootnoteReferenceRun,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import type { EssayDraft } from "./essay-types";
import { expandFootnoteUses } from "./validate";

const FONT = "Times New Roman";
const BLACK = "000000";
const BODY_SIZE = 24; // 12pt in half-points
const TITLE_SIZE = 32; // 16pt
const HEADING_SIZE = 26; // 13pt

function bodyRun(text: string) {
  return new TextRun({ text, font: FONT, color: BLACK, size: BODY_SIZE });
}

function splitMarkers(text: string): Array<{ text: string; fn?: number }> {
  const parts: Array<{ text: string; fn?: number }> = [];
  const re = /\[\^(\d+)\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ text: "", fn: Number(m[1]) });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  if (parts.length === 0) parts.push({ text });
  return parts;
}

function bodyParagraph(text: string): Paragraph {
  const children = [];
  for (const part of splitMarkers(text)) {
    if (part.fn) {
      children.push(new FootnoteReferenceRun(part.fn));
    } else if (part.text) {
      children.push(bodyRun(part.text));
    }
  }
  return new Paragraph({
    children,
    spacing: { line: 480, after: 0 },
    alignment: AlignmentType.JUSTIFIED,
  });
}

function mlaFootnoteText(fn: {
  author?: string;
  title?: string;
  publisher?: string;
  year?: string;
  url?: string;
  accessed?: string;
}): string {
  // MLA: author-first when known, title-first when not. Never "Unknown".
  const bits = fn.author
    ? [
        fn.author,
        fn.title ? `${fn.title}` : "",
        fn.publisher || fn.year
          ? `(${[fn.publisher, fn.year].filter(Boolean).join(", ")})`
          : "",
      ]
    : [
        fn.title ? `${fn.title}` : "",
        fn.publisher || fn.year
          ? `(${[fn.publisher, fn.year].filter(Boolean).join(", ")})`
          : "",
      ];
  return `${bits.join(", ")}${fn.url ? `, ${fn.url}` : ""}${fn.accessed ? `. Accessed ${fn.accessed}` : ""}.`;
}

export function countWords(draft: EssayDraft): number {
  const all = [
    ...draft.introduction,
    ...draft.sections.flatMap((s) => [s.heading, ...s.paragraphs]),
    ...draft.conclusion,
  ].join(" ");
  return all.split(/\s+/).filter(Boolean).length;
}

export async function buildDocx(draft: EssayDraft): Promise<Buffer> {
  // Word needs one unique footnote definition per in-text reference.
  // Expand here too so every caller gets a valid file (idempotent: routes
  // already expand for JSON consistency, this is the safety net).
  expandFootnoteUses(draft);
  const footnotes: Record<string, { children: Paragraph[] }> = {};
  for (const fn of draft.footnotes) {
    const line = mlaFootnoteText(fn);
    const children: Array<TextRun | ExternalHyperlink> = [];
    // author/title part as plain text, URL as hyperlink when present
    if (fn.url && line.includes(fn.url)) {
      const idx = line.indexOf(fn.url);
      const before = line.slice(0, idx);
      const after = line.slice(idx + fn.url.length);
      if (before)
        children.push(
          new TextRun({ text: before, font: FONT, color: BLACK, size: 20 })
        );
      children.push(
        new ExternalHyperlink({
          link: fn.url,
          children: [
            new TextRun({
              text: fn.url,
              font: FONT,
              color: BLACK,
              size: 20,
              underline: {},
            }),
          ],
        })
      );
      if (after)
        children.push(
          new TextRun({ text: after, font: FONT, color: BLACK, size: 20 })
        );
    } else {
      children.push(
        new TextRun({ text: line, font: FONT, color: BLACK, size: 20 })
      );
    }
    footnotes[String(fn.id)] = {
      children: [new Paragraph({ children })],
    };
  }

  const children: Paragraph[] = [];
  children.push(
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 240 },
      children: [
        new TextRun({
          text: draft.title,
          font: FONT,
          color: BLACK,
          size: TITLE_SIZE,
          bold: true,
        }),
      ],
    })
  );

  for (const p of draft.introduction) children.push(bodyParagraph(p));

  for (const sec of draft.sections) {
    if (sec.heading) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 240, after: 120 },
          children: [
            new TextRun({
              text: sec.heading,
              font: FONT,
              color: BLACK,
              size: HEADING_SIZE,
              bold: true,
            }),
          ],
        })
      );
    }
    for (const p of sec.paragraphs) children.push(bodyParagraph(p));
  }

  for (const p of draft.conclusion) children.push(bodyParagraph(p));

  if (draft.worksCited.length > 0) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 360, after: 120 },
        children: [
          new TextRun({
            text: "Works Cited",
            font: FONT,
            color: BLACK,
            size: HEADING_SIZE,
            bold: true,
          }),
        ],
      })
    );
    const sorted = [...draft.worksCited].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" })
    );
    for (const entry of sorted) {
      children.push(
        new Paragraph({
          children: [bodyRun(entry)],
          spacing: { line: 480, after: 0 },
          indent: { hanging: 720 },
        })
      );
    }
  }

  const doc = new Document({
    creator: "EssayWriter",
    title: draft.title,
    footnotes,
    sections: [
      {
        properties: {
          page: {
            size: { width: 12240, height: 15840 },
            margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
          },
        },
        children,
      },
    ],
  });

  return Buffer.from(await Packer.toBuffer(doc));
}
