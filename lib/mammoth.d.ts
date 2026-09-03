/**
 * mammoth ships no type declarations. Declare only the slice we use — raw text
 * extraction from a .docx buffer — rather than pulling in a broad community
 * typing for one function.
 */
declare module "mammoth" {
  export interface ExtractRawTextResult {
    value: string;
    messages: { type: string; message: string }[];
  }
  export function extractRawText(input: {
    buffer: Buffer;
  }): Promise<ExtractRawTextResult>;

  const mammoth: { extractRawText: typeof extractRawText };
  export default mammoth;
}
