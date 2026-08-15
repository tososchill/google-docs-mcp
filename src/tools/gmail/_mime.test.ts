// Regression-Tests fuer die MIME-Header-Kodierung.
//
// Anlass (2026-08-15): 19 gesendete Mails trugen einen zerschossenen Betreff.
// Aus "Unterlassungserklaerung – Ihr Zeichen" wurde beim Empfaenger
// "UnterlassungserklÃ¤rung â€“ Ihr Zeichen": der Header ging roh als UTF-8
// raus, und RFC 5322 laesst in Headern nur US-ASCII zu. Der BODY war immer
// korrekt — deshalb faellt es beim Schreiben nicht auf, sondern erst beim
// Empfaenger. Betroffen waren u.a. Mails an Hetzner, an einen Kunden und
// mehrfach an unsere Kanzlei.

import { describe, it, expect } from 'vitest';
import { buildMimeMessage, encodeHeaderValue } from './_mime.js';

/**
 * Holt den Wert eines Headers aus dem rohen MIME-Text.
 * Faltet dabei Folgezeilen zusammen (RFC 5322: eine Folgezeile beginnt mit
 * Whitespace) — ohne das liest man bei einem langen Betreff nur die erste
 * Haelfte und haelt eine korrekte Kodierung faelschlich fuer abgeschnitten.
 */
function header(mime: string, name: string): string {
  const m = mime.match(new RegExp(`^${name}: ((?:.*(?:\\r\\n[ \\t].*)*))$`, 'm'));
  return m ? m[1].replace(/\r\n[ \t]+/g, ' ') : '';
}

/** Dekodiert RFC-2047-Encoded-Words zurueck nach UTF-8. */
function decodeEncodedWord(v: string): string {
  // Zwei benachbarte Encoded-Words werden ohne das trennende Leerzeichen
  // zusammengesetzt — so schreibt es RFC 2047 vor.
  return v
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_, b64) =>
      Buffer.from(b64, 'base64').toString('utf-8')
    );
}

describe('encodeHeaderValue', () => {
  it('laesst reines ASCII unangetastet', () => {
    expect(encodeHeaderValue('Ihr Zeichen CY-45227-MM')).toBe('Ihr Zeichen CY-45227-MM');
  });

  it('kodiert Umlaute als RFC-2047-Encoded-Word', () => {
    const out = encodeHeaderValue('Unterlassungserklärung');
    expect(out).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    expect(decodeEncodedWord(out)).toBe('Unterlassungserklärung');
  });

  it('kodiert den Gedankenstrich, der den Vorfall ausgeloest hat', () => {
    const original = 'Unterlassungserklärung – Ihr Zeichen CY-45227-MM';
    expect(decodeEncodedWord(encodeHeaderValue(original))).toBe(original);
  });

  it('kodiert Emoji (4-Byte-UTF-8)', () => {
    const original = '🔒 Brief vom Finanzamt';
    expect(decodeEncodedWord(encodeHeaderValue(original))).toBe(original);
  });

  it('bricht lange Nicht-ASCII-Werte in mehrere Encoded-Words', () => {
    const original = 'Ü'.repeat(200);
    const out = encodeHeaderValue(original);
    // Keine erzeugte Zeile darf die 76-Zeichen-Grenze aus RFC 2047 reissen.
    for (const line of out.split('\r\n')) {
      expect(line.trimStart().length).toBeLessThanOrEqual(76);
    }
    expect(decodeEncodedWord(out.replace(/\r\n\s+/g, ''))).toBe(original);
  });

  it('zerschneidet keinen Mehrbyte-Codepoint', () => {
    // Bei naivem Byte-Splitting entstehen hier U+FFFD-Ersatzzeichen.
    const original = 'ä'.repeat(120);
    const out = encodeHeaderValue(original).replace(/\r\n\s+/g, '');
    expect(decodeEncodedWord(out)).toBe(original);
    expect(decodeEncodedWord(out)).not.toContain('�');
  });
});

describe('buildMimeMessage — Header', () => {
  it('kodiert den Betreff, statt ihn roh zu schreiben (der eigentliche Vorfall)', () => {
    const mime = buildMimeMessage({
      to: 'artur@jil-langwost.de',
      subject: 'Unterlassungserklärung – Ihr Zeichen CY-45227-MM',
      bodyText: 'Sehr geehrter Herr Brommer,',
    });
    const subj = header(mime, 'Subject');
    expect(subj).not.toContain('ä');
    expect(subj).toMatch(/=\?UTF-8\?B\?/);
    expect(decodeEncodedWord(subj)).toBe('Unterlassungserklärung – Ihr Zeichen CY-45227-MM');
  });

  it('laesst einen ASCII-Betreff unveraendert lesbar', () => {
    const mime = buildMimeMessage({
      to: 'a@b.de',
      subject: 'Ihr Zeichen UW-7956-26',
      bodyText: 'Text',
    });
    expect(header(mime, 'Subject')).toBe('Ihr Zeichen UW-7956-26');
  });

  it('kodiert einen Anzeigenamen, ohne die Adresse anzufassen', () => {
    const mime = buildMimeMessage({
      to: 'Jürgen Groß <juergen@example.de>',
      subject: 'Test',
      bodyText: 'Text',
    });
    const to = header(mime, 'To');
    expect(to).toContain('<juergen@example.de>');
    expect(to).not.toContain('ü');
    expect(decodeEncodedWord(to)).toBe('Jürgen Groß <juergen@example.de>');
  });

  it('laesst eine nackte Adresse ohne Anzeigename in Ruhe', () => {
    const mime = buildMimeMessage({ to: 'a@b.de', subject: 'Test', bodyText: 'Text' });
    expect(header(mime, 'To')).toBe('a@b.de');
  });

  it('kodiert mehrere Empfaenger einzeln', () => {
    const mime = buildMimeMessage({
      to: 'Jürgen <j@example.de>, plain@example.de',
      subject: 'Test',
      bodyText: 'Text',
    });
    const to = header(mime, 'To');
    expect(to).toContain('plain@example.de');
    expect(decodeEncodedWord(to)).toContain('Jürgen <j@example.de>');
  });
});

describe('buildMimeMessage — Body', () => {
  it('deklariert nicht 7bit, wenn der Body Nicht-ASCII enthaelt', () => {
    const mime = buildMimeMessage({
      to: 'a@b.de',
      subject: 'Test',
      bodyText: 'Mit freundlichen Grüßen',
    });
    expect(mime).not.toContain('Content-Transfer-Encoding: 7bit');
    expect(mime).toContain('Content-Transfer-Encoding: base64');
  });

  it('haelt den Body bei reinem ASCII unveraendert lesbar', () => {
    const mime = buildMimeMessage({ to: 'a@b.de', subject: 'Test', bodyText: 'Plain body' });
    expect(mime).toContain('Content-Transfer-Encoding: 7bit');
    expect(mime).toContain('Plain body');
  });

  it('uebertraegt einen Umlaut-Body verlustfrei', () => {
    const body = 'Sehr geehrter Herr Dr. Slopek,\n\nMit freundlichen Grüßen\nTom Soto Schiller';
    const mime = buildMimeMessage({ to: 'a@b.de', subject: 'Test', bodyText: body });
    const b64 = mime.split('\r\n\r\n').slice(1).join('\r\n\r\n').trim().replace(/\r\n/g, '');
    expect(Buffer.from(b64, 'base64').toString('utf-8')).toBe(body);
  });
});

describe('buildMimeMessage — Anhaenge', () => {
  const att = {
    filename: 'Unterlassungserklärung.pdf',
    mimeType: 'application/pdf',
    dataBase64Url: Buffer.from('%PDF-1.4 test').toString('base64'),
  };

  it('kodiert einen Nicht-ASCII-Dateinamen nach RFC 2231', () => {
    const mime = buildMimeMessage({
      to: 'a@b.de',
      subject: 'Test',
      bodyText: 'Text',
      attachments: [att],
    });
    expect(mime).toContain("filename*=UTF-8''");
    expect(mime).toContain('Unterlassungserkl%C3%A4rung.pdf');
    // Der rohe Umlaut darf im Header nicht mehr auftauchen.
    const dispo = mime.match(/^Content-Disposition: .*$/m)?.[0] ?? '';
    expect(dispo).not.toContain('ä');
  });

  it('laesst einen ASCII-Dateinamen in der einfachen Form', () => {
    const mime = buildMimeMessage({
      to: 'a@b.de',
      subject: 'Test',
      bodyText: 'Text',
      attachments: [{ ...att, filename: 'unterlassung.pdf' }],
    });
    expect(mime).toContain('filename="unterlassung.pdf"');
    expect(mime).not.toContain("filename*=UTF-8''");
  });
});
