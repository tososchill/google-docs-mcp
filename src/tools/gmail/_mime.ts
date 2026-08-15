// Shared MIME-building helpers for Gmail tools (sendEmail, createDraft, forwardEmail).
// Extracted from forwardEmail.ts during the Phase 1a refactor (handover 2026-05-29).

import { gmail_v1 } from 'googleapis';

export interface MimeAttachment {
  filename: string;
  mimeType: string;
  /** base64url-encoded payload (Gmail API attachment format). */
  dataBase64Url: string;
}

export interface BuildMimeOptions {
  to: string;
  subject: string;
  bodyText: string;
  from?: string;
  cc?: string;
  bcc?: string;
  inReplyTo?: string;
  references?: string;
  isHtml?: boolean;
  attachments?: MimeAttachment[];
}

const isAscii = (s: string): boolean => !/[^\x00-\x7F]/.test(s);

/**
 * Kodiert einen Header-Wert nach RFC 2047, falls noetig.
 *
 * RFC 5322 laesst in Headern nur US-ASCII zu. Ein roh geschriebener Umlaut
 * kommt beim Empfaenger als Mojibake an ("UnterlassungserklÃ¤rung") — der
 * Body bleibt dabei korrekt, weshalb es beim Schreiben nicht auffaellt.
 * Vorfall 2026-08-15: 19 gesendete Mails, u.a. an Hetzner und an unsere Kanzlei.
 *
 * Reines ASCII bleibt unangetastet, damit Betreffzeilen lesbar bleiben.
 */
export function encodeHeaderValue(value: string): string {
  if (isAscii(value)) return value;

  // Ein Encoded-Word darf laut RFC 2047 hoechstens 75 Zeichen lang sein.
  // "=?UTF-8?B?" + "?=" sind 12 davon, bleiben 63 fuer Base64. 45 Rohbytes
  // ergeben genau 60 Base64-Zeichen und damit 72 insgesamt.
  const MAX_BYTES = 45;
  const words: string[] = [];
  let chunk: Buffer[] = [];
  let size = 0;

  // Ueber Codepoints laufen, nicht ueber Bytes: ein naiver Byte-Split zerlegt
  // Mehrbyte-Zeichen und erzeugt beim Empfaenger U+FFFD.
  for (const ch of value) {
    const bytes = Buffer.from(ch, 'utf-8');
    if (size + bytes.length > MAX_BYTES && chunk.length > 0) {
      words.push(`=?UTF-8?B?${Buffer.concat(chunk).toString('base64')}?=`);
      chunk = [];
      size = 0;
    }
    chunk.push(bytes);
    size += bytes.length;
  }
  if (chunk.length > 0) {
    words.push(`=?UTF-8?B?${Buffer.concat(chunk).toString('base64')}?=`);
  }

  // Folge-Zeilen werden nach RFC 5322 mit Whitespace eingerueckt (Folding).
  return words.join('\r\n ');
}

/**
 * Kodiert die Anzeigenamen einer Adressliste, laesst die Adressen selbst in Ruhe.
 * Eine kodierte Adresse waere unzustellbar — nur der Name vor den spitzen
 * Klammern darf durch die RFC-2047-Kodierung.
 */
export function encodeAddressList(list: string): string {
  if (isAscii(list)) return list;
  return list
    .split(',')
    .map((raw) => {
      const part = raw.trim();
      const m = part.match(/^(.*?)\s*<([^>]+)>$/);
      if (!m) return part; // nackte Adresse oder unerwartete Form: unangetastet
      const name = m[1].replace(/^"(.*)"$/, '$1').trim();
      if (!name) return `<${m[2]}>`;
      return `${encodeHeaderValue(name)} <${m[2]}>`;
    })
    .join(', ');
}

/** Prozent-Kodierung fuer RFC-2231-Parameter (Dateinamen mit Umlauten). */
function encodeRfc2231(value: string): string {
  return encodeURIComponent(value).replace(
    /['()!*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

/** Bricht Base64 auf die von RFC 2045 geforderten 76 Zeichen je Zeile um. */
function wrapBase64(b64: string): string {
  return b64.match(/.{1,76}/g)?.join('\r\n') || b64;
}

export function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  const padding = base64.length % 4;
  const padded = padding ? base64 + '='.repeat(4 - padding) : base64;
  return Buffer.from(padded, 'base64').toString('utf-8');
}

export function extractPlainText(payload: gmail_v1.Schema$MessagePart | null | undefined): string {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
    }
    for (const part of payload.parts) {
      const text = extractPlainText(part);
      if (text) return text;
    }
  }
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    const html = decodeBase64Url(payload.body.data);
    return html
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return '';
}

export async function collectAttachments(
  payload: gmail_v1.Schema$MessagePart | null | undefined,
  messageId: string,
  gmail: gmail_v1.Gmail,
  out: MimeAttachment[]
): Promise<void> {
  if (!payload) return;
  if (payload.body?.attachmentId) {
    const attResp = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId,
      id: payload.body.attachmentId,
    });
    if (attResp.data.data) {
      out.push({
        filename: payload.filename || `attachment-${payload.body.attachmentId}.bin`,
        mimeType: payload.mimeType || 'application/octet-stream',
        dataBase64Url: attResp.data.data,
      });
    }
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      await collectAttachments(part, messageId, gmail, out);
    }
  }
}

export function buildMimeMessage(opts: BuildMimeOptions): string {
  const {
    to,
    subject,
    bodyText,
    from,
    cc,
    bcc,
    inReplyTo,
    references,
    isHtml,
    attachments = [],
  } = opts;

  let mime = '';
  if (from) mime += `From: ${encodeAddressList(from)}\r\n`;
  mime += `To: ${encodeAddressList(to)}\r\n`;
  if (cc) mime += `Cc: ${encodeAddressList(cc)}\r\n`;
  if (bcc) mime += `Bcc: ${encodeAddressList(bcc)}\r\n`;
  mime += `Subject: ${encodeHeaderValue(subject)}\r\n`;
  if (inReplyTo) mime += `In-Reply-To: ${inReplyTo}\r\n`;
  const refsHeader = references || inReplyTo;
  if (refsHeader) mime += `References: ${refsHeader}\r\n`;
  mime += `MIME-Version: 1.0\r\n`;

  const bodyContentType = isHtml ? 'text/html; charset=UTF-8' : 'text/plain; charset=UTF-8';

  // 7bit bei Nicht-ASCII-Body ist eine Falschangabe: der Body IST dann 8-bit.
  // Gmail toleriert das heute, aber verlassen sollte man sich darauf nicht.
  const bodyIsAscii = isAscii(bodyText);
  const bodyEncoding = bodyIsAscii ? '7bit' : 'base64';
  const bodyPayload = bodyIsAscii
    ? bodyText
    : wrapBase64(Buffer.from(bodyText, 'utf-8').toString('base64'));

  if (attachments.length === 0) {
    mime += `Content-Type: ${bodyContentType}\r\n`;
    mime += `Content-Transfer-Encoding: ${bodyEncoding}\r\n\r\n`;
    mime += bodyPayload;
    return mime;
  }

  const boundary = `bnd_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  mime += `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n`;
  mime += `--${boundary}\r\n`;
  mime += `Content-Type: ${bodyContentType}\r\n`;
  mime += `Content-Transfer-Encoding: ${bodyEncoding}\r\n\r\n`;
  mime += bodyPayload + '\r\n';

  for (const att of attachments) {
    const nameIsAscii = isAscii(att.filename);
    // Nicht-ASCII-Dateinamen: RFC 2231 fuer Content-Disposition (das lesen alle
    // gaengigen Clients), RFC 2047 fuer den aelteren name=-Parameter.
    const nameParam = nameIsAscii
      ? `name="${att.filename}"`
      : `name="${encodeHeaderValue(att.filename)}"`;
    const filenameParam = nameIsAscii
      ? `filename="${att.filename}"`
      : `filename*=UTF-8''${encodeRfc2231(att.filename)}`;

    mime += `--${boundary}\r\n`;
    mime += `Content-Type: ${att.mimeType}; ${nameParam}\r\n`;
    mime += `Content-Disposition: attachment; ${filenameParam}\r\n`;
    mime += `Content-Transfer-Encoding: base64\r\n\r\n`;
    const stdBase64 = att.dataBase64Url.replace(/-/g, '+').replace(/_/g, '/');
    mime += wrapBase64(stdBase64) + '\r\n';
  }
  mime += `--${boundary}--\r\n`;
  return mime;
}

export function encodeMimeForGmail(mime: string): string {
  return Buffer.from(mime, 'utf-8')
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}
