import { describe, it, expect, vi, beforeEach } from 'vitest';

// Die Drive-API liefert nur die Felder, die in `fields` angefragt werden.
// Fehlt `mimeType` in der Anfrage, kommt es auch nicht zurück, und jede
// Typ-Prüfung danach scheitert. Genau das bildet dieser Nachbau ab.
const filesGet = vi.fn();
vi.mock('../../clients.js', () => ({
  getDriveClient: async () => ({ files: { get: filesGet } }),
}));

import { register } from './getFolderInfo.js';

const FOLDER = 'application/vnd.google-apps.folder';
const log = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} };

function captureTool(): any {
  let tool: any;
  register({ addTool: (t: any) => (tool = t) } as any);
  return tool;
}

function driveAntwortet(gespeichert: Record<string, any>) {
  filesGet.mockImplementation(async (req: any) => {
    const angefragt = String(req.fields)
      .split(',')
      .map((f) => f.replace(/\(.*$/, '').trim());
    const data: Record<string, any> = {};
    for (const [k, v] of Object.entries(gespeichert)) if (angefragt.includes(k)) data[k] = v;
    return { data };
  });
}

describe('getFolderInfo', () => {
  // Block statt Ausdruck: Vitest ruft einen zurückgegebenen Wert als Aufräum-Funktion auf,
  // und mockReset() gibt das Mock selbst zurück.
  beforeEach(() => {
    filesGet.mockReset();
  });

  it('liefert die Infos eines echten Ordners (mimeType wird angefragt)', async () => {
    driveAntwortet({ id: 'f1', name: 'Reports', mimeType: FOLDER, parents: ['p1'], shared: true });
    const out = JSON.parse(await captureTool().execute({ folderId: 'f1' }, { log }));
    expect(out).toMatchObject({ id: 'f1', name: 'Reports', parentFolderId: 'p1', shared: true });
    expect(filesGet.mock.calls[0][0].fields.split(',')).toContain('mimeType');
  });

  it('meldet eine Datei weiter als keinen Ordner und nennt ihren Typ', async () => {
    driveAntwortet({ id: 'd1', name: 'Bericht', mimeType: 'application/pdf' });
    await expect(captureTool().execute({ folderId: 'd1' }, { log })).rejects.toThrow(
      /not belong to a folder.*application\/pdf/
    );
  });
});
