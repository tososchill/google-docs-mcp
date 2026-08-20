import { describe, it, expect } from 'vitest';
import { buildMimeMessage } from './_mime.js';

/**
 * Vorfall 2026-08-20.
 *
 * Ein Draft mit dem Betreff "Weekly am 1. September eine halbe Stunde später"
 * kam beim Zurücklesen als "... eine halbe Stunde spÃ¤ter" an. Der Body war
 * sauber, nur die Betreffzeile war zerstört. Beinahe an einen Kunden gegangen.
 *
 * Ursache: `buildMimeMessage` schrieb den Betreff als rohe UTF-8-Bytes in den
 * Header. Ein MIME-Header ist per RFC 5322 auf US-ASCII begrenzt; alles darüber
 * muss nach RFC 2047 kodiert werden. Zusätzlich deklarierte der Bauer den Body
 * als `7bit`, obwohl UTF-8-Umlaute 8-Bit sind — bei Gmail zu Gmail fiel das
 * nicht auf, ein strengerer Empfänger darf den Text aber verstümmeln.
 *
 * Diese Tests halten beides fest.
 */

const UMLAUT_SUBJECT = 'Weekly am 1. September eine halbe Stunde später';

function headerBlock(mime: string): string {
  return mime.split('\r\n\r\n')[0] ?? mime;
}

function headerValue(mime: string, name: string): string {
  const line = headerBlock(mime)
    .split('\r\n')
    .find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}: `));
  return line ? line.slice(name.length + 2) : '';
}

/** Dekodiert einen RFC-2047-Base64-Wort zurück, um den Roundtrip zu prüfen. */
function decodeRfc2047(value: string): string {
  return value.replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_m, b64) =>
    Buffer.from(b64, 'base64').toString('utf8'),
  );
}

describe('buildMimeMessage — Header dürfen nur ASCII enthalten (RFC 2047)', () => {
  it('kodiert einen Betreff mit Umlaut, statt rohe Bytes zu schreiben', () => {
    const mime = buildMimeMessage({
      to: 'niclas@example.com',
      subject: UMLAUT_SUBJECT,
      bodyText: 'Hallo',
    });

    const subject = headerValue(mime, 'Subject');
    expect(subject).not.toContain('später');
    expect(subject).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    expect(decodeRfc2047(subject)).toBe(UMLAUT_SUBJECT);
  });

  it('lässt einen reinen ASCII-Betreff unverändert', () => {
    const mime = buildMimeMessage({
      to: 'a@example.com',
      subject: 'Weekly um 30 Minuten verschoben',
      bodyText: 'Hallo',
    });
    expect(headerValue(mime, 'Subject')).toBe('Weekly um 30 Minuten verschoben');
  });

  it('lässt im ganzen Header-Block kein Byte über 127 stehen', () => {
    const mime = buildMimeMessage({
      to: 'Björn Müller <bjoern@example.com>',
      from: 'Tom Soto Schiller <tom@example.com>',
      cc: 'Renée Dupré <renee@example.com>',
      subject: UMLAUT_SUBJECT,
      bodyText: 'Grüße',
    });
    const headers = headerBlock(mime);
    const offending = [...headers].filter((c) => c.charCodeAt(0) > 127);
    expect(offending).toEqual([]);
  });

  it('kodiert nur den Anzeigenamen einer Adresse, nie die Adresse selbst', () => {
    const mime = buildMimeMessage({
      to: 'Björn Müller <bjoern@example.com>',
      subject: 'Test',
      bodyText: 'Hallo',
    });
    const to = headerValue(mime, 'To');
    expect(to).toContain('<bjoern@example.com>');
    expect(decodeRfc2047(to)).toBe('Björn Müller <bjoern@example.com>');
  });
});

describe('buildMimeMessage — 8-Bit-Body darf nicht als 7bit deklariert werden', () => {
  it('kodiert einen Body mit Umlauten nach base64 und deklariert das auch so', () => {
    const body = 'Moin Niclas,\r\n\r\nViele Grüße\r\nTom';
    const mime = buildMimeMessage({
      to: 'a@example.com',
      subject: 'Test',
      bodyText: body,
    });

    expect(mime).toContain('Content-Transfer-Encoding: base64');
    expect(mime).not.toContain('Content-Transfer-Encoding: 7bit');

    const payload = mime.split('\r\n\r\n').slice(1).join('\r\n\r\n');
    expect(Buffer.from(payload.replace(/\r?\n/g, ''), 'base64').toString('utf8')).toBe(body);
  });

  it('lässt einen reinen ASCII-Body als 7bit im Klartext', () => {
    const mime = buildMimeMessage({
      to: 'a@example.com',
      subject: 'Test',
      bodyText: 'Plain ASCII body',
    });
    expect(mime).toContain('Content-Transfer-Encoding: 7bit');
    expect(mime).toContain('Plain ASCII body');
  });

  it('gilt genauso im Multipart-Fall mit Anhang', () => {
    const mime = buildMimeMessage({
      to: 'a@example.com',
      subject: UMLAUT_SUBJECT,
      bodyText: 'Anbei die Übersicht mit Grüßen',
      attachments: [
        {
          filename: 'x.pdf',
          mimeType: 'application/pdf',
          dataBase64Url: Buffer.from('x').toString('base64url'),
        },
      ],
    });

    const headers = headerBlock(mime);
    expect([...headers].filter((c) => c.charCodeAt(0) > 127)).toEqual([]);
    // Der Text-Part traegt base64, nicht 7bit.
    const textPart = mime.split('--')[1] ?? '';
    expect(textPart).toContain('Content-Transfer-Encoding: base64');
  });
});
