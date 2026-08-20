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

const isAscii = (s: string): boolean => !/[^\x00-\x7F]/.test(s);

/**
 * Kodiert einen Header-Wert nach RFC 2047, falls er Zeichen über US-ASCII trägt.
 *
 * Ein MIME-Header ist per RFC 5322 auf US-ASCII begrenzt. Rohe UTF-8-Bytes
 * kommen beim Empfänger als Buchstabensalat an — genau das passierte am
 * 2026-08-20 mit dem Betreff "eine halbe Stunde später", der als
 * "eine halbe Stunde spÃ¤ter" zurückkam und beinahe an einen Kunden ging.
 *
 * Reines ASCII bleibt bewusst unverändert: eine unnötige Kodierung macht
 * Betreffzeilen in Log- und Suchansichten unlesbar.
 */
export function encodeHeaderValue(value: string): string {
  if (isAscii(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/**
 * Wie encodeHeaderValue, aber für Adress-Header (From, To, Cc, Bcc).
 *
 * Nur der Anzeigename darf kodiert werden. Die Adresse in den spitzen Klammern
 * muss ASCII bleiben, sonst kann kein Mailserver sie mehr zustellen.
 * Aus `Björn Müller <bjoern@example.com>` wird also
 * `=?UTF-8?B?...?= <bjoern@example.com>`.
 */
export function encodeAddressHeader(value: string): string {
  if (isAscii(value)) return value;
  return value
    .split(',')
    .map((part) => {
      const m = part.trim().match(/^(.*?)\s*<([^>]+)>$/);
      if (!m) return encodeHeaderValue(part.trim());
      const [, display, addr] = m;
      const name = display.replace(/^"(.*)"$/, '$1').trim();
      return name ? `${encodeHeaderValue(name)} <${addr}>` : `<${addr}>`;
    })
    .join(', ');
}

/**
 * Liefert Transfer-Encoding und Nutzlast für einen Text-Part.
 *
 * UTF-8-Umlaute sind 8-Bit. Sie als `7bit` zu deklarieren ist formal falsch:
 * bei Gmail zu Gmail fällt es nicht auf, ein strengerer Empfänger oder ein
 * Gateway darf den Text dann aber verstümmeln. Deshalb base64, sobald der
 * Inhalt ASCII verlässt — reiner ASCII-Text bleibt im Klartext lesbar.
 */
export function encodeTextPart(body: string): { encoding: string; payload: string } {
  if (isAscii(body)) return { encoding: '7bit', payload: body };
  const b64 = Buffer.from(body, 'utf8').toString('base64');
  return { encoding: 'base64', payload: b64.match(/.{1,76}/g)?.join('\r\n') ?? b64 };
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
  if (from) mime += `From: ${encodeAddressHeader(from)}\r\n`;
  mime += `To: ${encodeAddressHeader(to)}\r\n`;
  if (cc) mime += `Cc: ${encodeAddressHeader(cc)}\r\n`;
  if (bcc) mime += `Bcc: ${encodeAddressHeader(bcc)}\r\n`;
  mime += `Subject: ${encodeHeaderValue(subject)}\r\n`;
  if (inReplyTo) mime += `In-Reply-To: ${inReplyTo}\r\n`;
  const refsHeader = references || inReplyTo;
  if (refsHeader) mime += `References: ${refsHeader}\r\n`;
  mime += `MIME-Version: 1.0\r\n`;

  const bodyContentType = isHtml ? 'text/html; charset=UTF-8' : 'text/plain; charset=UTF-8';

  const textPart = encodeTextPart(bodyText);

  if (attachments.length === 0) {
    mime += `Content-Type: ${bodyContentType}\r\n`;
    mime += `Content-Transfer-Encoding: ${textPart.encoding}\r\n\r\n`;
    mime += textPart.payload;
    return mime;
  }

  const boundary = `bnd_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  mime += `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n`;
  mime += `--${boundary}\r\n`;
  mime += `Content-Type: ${bodyContentType}\r\n`;
  mime += `Content-Transfer-Encoding: ${textPart.encoding}\r\n\r\n`;
  mime += textPart.payload + '\r\n';

  for (const att of attachments) {
    mime += `--${boundary}\r\n`;
    mime += `Content-Type: ${att.mimeType}; name="${att.filename}"\r\n`;
    mime += `Content-Disposition: attachment; filename="${att.filename}"\r\n`;
    mime += `Content-Transfer-Encoding: base64\r\n\r\n`;
    const stdBase64 = att.dataBase64Url.replace(/-/g, '+').replace(/_/g, '/');
    const wrapped = stdBase64.match(/.{1,76}/g)?.join('\r\n') || stdBase64;
    mime += wrapped + '\r\n';
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
