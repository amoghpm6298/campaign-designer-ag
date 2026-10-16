// Writes the versioned schema artefact to disk.
// Run: npm run agent:schema
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSchemaArtefact } from './generateSchema';

const here = dirname(fileURLToPath(import.meta.url));

describe('schema artefact', () => {
  it('generates from app source and writes to disk', () => {
    const artefact = generateSchemaArtefact();

    // Guard the few invariants a consumer depends on. These assert the
    // artefact is well-formed; they do not restate any app rule.
    expect(Object.keys(artefact.nodeTypes).length).toBeGreaterThan(0);
    expect(artefact.contentHash).toMatch(/^[0-9a-f]{16}$/);
    expect(artefact.vocabulary.commsTemplates.length).toBeGreaterThan(0);

    const outPath = resolve(here, 'campaign-schema.json');
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(artefact, null, 2) + '\n');

    console.log(`\n  schema artefact → ${outPath.split('/drip-campaigns/')[1]}`);
    console.log(`    artefactVersion : ${artefact.schemaArtefactVersion}`);
    console.log(`    contentHash     : ${artefact.contentHash}`);
    console.log(`    nodeTypes       : ${Object.keys(artefact.nodeTypes).length}\n`);
  });
});
