import fsp from 'node:fs/promises';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';

const MAX_CHARS = 400_000; // ~100k tokens per file; Claude's context is far larger

export async function extractText(filePath, name, mime = '') {
  const lower = name.toLowerCase();
  let text = '';
  if (lower.endsWith('.pdf') || mime === 'application/pdf') {
    const parser = new PDFParse({ data: await fsp.readFile(filePath) });
    try {
      text = (await parser.getText()).text;
    } finally {
      await parser.destroy?.();
    }
  } else if (lower.endsWith('.docx')) {
    text = (await mammoth.extractRawText({ path: filePath })).value;
  } else if (/\.(txt|md|markdown|csv|json|xml|html?|rtf)$/.test(lower) || mime.startsWith('text/')) {
    text = await fsp.readFile(filePath, 'utf8');
    if (/\.html?$/.test(lower)) text = text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ');
  } else {
    throw Object.assign(new Error(`Unsupported file type: ${name} (use PDF, DOCX, TXT, MD or HTML)`), { status: 400 });
  }
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS)}\n\n[Document truncated at ${MAX_CHARS} characters]`;
  return text;
}
