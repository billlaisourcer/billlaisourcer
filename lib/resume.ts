import mammoth from "mammoth";

/**
 * Turning an uploaded resume into something the model can read.
 *
 * Two paths, because Claude reads one of these formats natively and not the
 * other. A PDF goes straight through as a document block — no parsing library,
 * no layout heuristics, and the model sees the actual page. A .docx has to be
 * converted here, and it is converted with mammoth rather than by stripping
 * tags out of the XML, because resumes lean on tables for their date/role
 * columns and a naive stripper drops exactly that content without saying so.
 */

/**
 * Vercel caps a function request body at 4.5 MB and base64 inflates by ~4/3,
 * so the real ceiling is a shade over 3 MB. Stop short of it and say why,
 * rather than letting the platform answer with a bare 413.
 */
export const MAX_RESUME_BYTES = 2_500_000;

export type Resume =
  | { kind: "pdf"; base64: string; filename: string }
  | { kind: "text"; text: string; filename: string };

export type ReadResult =
  | { ok: true; resume: Resume }
  | { ok: false; status: number; error: string };

export interface UploadedFile {
  name: string;
  /** The browser's MIME type. Unreliable, so the extension gets a vote too. */
  type: string;
  /** base64, no data: prefix. */
  data: string;
}

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

/**
 * base64 is 4 characters per 3 bytes, less whatever the trailing "=" pads out.
 * Ignoring the padding overstates the size by up to two bytes — immaterial
 * against a 2.5 MB ceiling, but the number reaches the user in the error
 * message, so it may as well be the real one.
 */
export function base64Bytes(b64: string): number {
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return (b64.length * 3) / 4 - padding;
}

export async function readResumeFile(file: UploadedFile): Promise<ReadResult> {
  const name = file.name || "resume";
  const ext = extensionOf(name);
  const mime = (file.type || "").toLowerCase();

  if (!file.data) {
    return { ok: false, status: 400, error: "That file arrived empty." };
  }

  const bytes = Math.round(base64Bytes(file.data));
  if (bytes > MAX_RESUME_BYTES) {
    return {
      ok: false,
      status: 413,
      error:
        `${name} is ${(bytes / 1_000_000).toFixed(1)} MB and the limit is ` +
        `${MAX_RESUME_BYTES / 1_000_000} MB. Paste the resume text instead, or ` +
        `re-export it smaller.`,
    };
  }

  if (mime === "application/pdf" || ext === ".pdf") {
    return { ok: true, resume: { kind: "pdf", base64: file.data, filename: name } };
  }

  if (mime === DOCX_MIME || ext === ".docx") {
    try {
      const { value } = await mammoth.extractRawText({
        buffer: Buffer.from(file.data, "base64"),
      });
      const text = value.trim();
      if (!text) {
        return {
          ok: false,
          status: 422,
          error:
            `${name} opened but held no readable text. If the resume is an image ` +
            `pasted into Word, export it as a PDF instead.`,
        };
      }
      return { ok: true, resume: { kind: "text", text, filename: name } };
    } catch (err) {
      console.error("resume: docx extract failed", err);
      return {
        ok: false,
        status: 422,
        error:
          `Could not read ${name} as a Word document. If it is really a .doc or a ` +
          `renamed PDF, save it as .docx or PDF and try again.`,
      };
    }
  }

  // Legacy binary Word. Genuinely not readable here, and worth its own message
  // because "unsupported file type" would leave someone guessing.
  if (mime === "application/msword" || ext === ".doc") {
    return {
      ok: false,
      status: 415,
      error:
        `${name} is the old binary Word format. Open it and Save As .docx or PDF — ` +
        `both work here.`,
    };
  }

  if (mime.startsWith("text/") || ext === ".txt" || ext === ".md" || ext === ".markdown") {
    const text = Buffer.from(file.data, "base64").toString("utf8").trim();
    if (!text) {
      return { ok: false, status: 422, error: `${name} held no text.` };
    }
    return { ok: true, resume: { kind: "text", text, filename: name } };
  }

  return {
    ok: false,
    status: 415,
    error:
      `${name} is not a format this reads. Drop a PDF, a .docx, or a .txt — or ` +
      `paste the resume text.`,
  };
}
